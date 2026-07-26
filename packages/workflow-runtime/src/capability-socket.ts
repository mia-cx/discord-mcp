import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { join } from 'node:path'
import { Context, Effect, Layer, Schema } from 'effect'
import type { CapabilityCredential } from './broker.ts'
import { CapabilityRequest, MAX_CALL_BYTES, MAX_LOG_BYTES } from './capability-rpc.ts'
import { CapabilityServer, type ExecutionScope } from './capability-server.ts'

/**
 * One capability socket per execution.
 *
 * Served by the control plane rather than the supervisor, because this is where the grants and the
 * Discord credentials already are. Routing it through the supervisor would mean giving the process
 * that holds the Docker socket the credentials too, and the whole point of splitting them is that
 * neither process has both.
 *
 * The socket lives in a directory the container mounts as a subpath, and it is removed when the
 * execution ends: a socket that outlived its execution would be a way back in.
 */

export interface ExecutionSocket {
  /** The socket path inside the container, which is fixed and the same for every execution. */
  readonly containerPath: string
  readonly logs: () => string
  /** What the handler returned, or undefined if it never reported a result. */
  readonly result: () => unknown
  readonly close: () => Effect.Effect<void>
}

const decodeRequest = Schema.decodeUnknownEffect(CapabilityRequest)

export class CapabilitySockets extends Context.Service<
  CapabilitySockets,
  {
    /** Open a socket for one execution. The caller closes it when the execution ends. */
    readonly open: (
      credential: CapabilityCredential,
      /** The trigger payload, written beside the socket for the runner to read. */
      payload?: unknown,
    ) => Effect.Effect<ExecutionSocket, never, CapabilityServer>
  }
>()('workflow-runtime/CapabilitySockets') {
  static readonly layer = (options: {
    /** Where the shared capability volume is mounted in *this* process. */
    readonly directory: string
  }): Layer.Layer<CapabilitySockets> =>
    Layer.sync(CapabilitySockets)(() => ({
      open: (credential, payload) =>
        Effect.gen(function* () {
          const server = yield* CapabilityServer
          const directory = join(options.directory, credential.executionId)
          const socketPath = join(directory, 'broker.sock')

          let logs = ''
          const appendLog = (line: string) =>
            Effect.sync(() => {
              // Dropped rather than truncated-and-failed: a chatty workflow is not a broken one,
              // and killing it over log volume would be the worse failure.
              if (logs.length < MAX_LOG_BYTES) logs += `${line}\n`
            })

          let result: unknown
          const recordResult = (value: unknown) =>
            Effect.sync(() => {
              result = value
            })

          const scope: ExecutionScope = { credential, appendLog, recordResult }

          yield* Effect.promise(async () => {
            // Traversable, because the workflow container runs as a different user again (65534)
            // and has to reach the socket inside. The mode is not what isolates one execution from
            // another — the per-execution subpath mount is, and a container sees only its own.
            await mkdir(directory, { recursive: true, mode: 0o755 })
            // A socket left by a crashed control plane would fail `bind` with EADDRINUSE.
            await rm(socketPath, { force: true })
            // Beside the socket rather than inside the container: the runtime's tmpfs would mask
            // anything copied to /tmp, and a Gateway payload is too large to pass as an env var.
            await writeFile(join(directory, 'payload.json'), JSON.stringify(payload ?? null), {
              mode: 0o644,
            })
          })

          const listener = createServer((socket) => {
            handleConnection(socket, (line) =>
              Effect.runPromise(
                Effect.gen(function* () {
                  const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
                  const parsed = yield* Effect.result(
                    Effect.try({
                      try: () => JSON.parse(line) as unknown,
                      catch: () => new Error('malformed'),
                    }).pipe(Effect.flatMap(decodeRequest)),
                  )

                  if (parsed._tag === 'Failure') {
                    return {
                      id: '',
                      ok: false as const,
                      denied: false,
                      message: 'The capability request was malformed.',
                    }
                  }

                  return yield* server.handle({ request: parsed.success, scope, now })
                }),
              ),
            )
          })

          yield* Effect.callback<void>((resume) => {
            listener.listen(socketPath, () => {
              // The container runs as UID 65534, which is not this process's user, so the socket
              // has to be world-connectable. The subpath mount is what actually isolates it: no
              // other container can see this directory.
              void chmod(socketPath, 0o777).finally(() => resume(Effect.void))
            })
          })

          return {
            containerPath: socketPath,
            logs: () => logs,
            result: () => result,
            close: () =>
              Effect.promise(
                () =>
                  new Promise<void>((resolve) => {
                    listener.close(() => {
                      void rm(directory, { recursive: true, force: true }).finally(() => resolve())
                    })
                  }),
              ),
          }
        }),
    }))
}

/** Read newline-delimited requests from one connection, bounded, answering each in order. */
const handleConnection = (socket: Socket, respond: (line: string) => Promise<unknown>): void => {
  let buffer = ''
  socket.setEncoding('utf8')

  socket.on('data', (chunk: string) => {
    buffer += chunk
    if (buffer.length > MAX_CALL_BYTES) {
      // A workflow cannot make the broker buffer without bound; the alternative is a workflow that
      // exhausts the control plane's memory from inside a 256 MiB container.
      socket.destroy()
      return
    }

    let newline = buffer.indexOf('\n')
    while (newline !== -1) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf('\n')

      if (line.trim().length > 0) {
        void respond(line).then((response) => {
          socket.write(`${JSON.stringify(response)}\n`)
        })
      }
    }
  })

  // Nothing to do but let the execution end; the container is killed at its deadline regardless.
  socket.on('error', () => socket.destroy())
}
