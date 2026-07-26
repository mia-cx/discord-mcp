import { timingSafeEqual } from 'node:crypto'
import { chmod, mkdir, stat, unlink } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { dirname } from 'node:path'
import { SandboxError } from '@discord-mcp/core'
import { Effect, Schema } from 'effect'
import { DEFAULT_RUNTIME_LIMITS } from './container-spec.ts'
import {
  MAX_REQUEST_BYTES,
  SOCKET_DIR_MODE,
  SOCKET_MODE,
  SupervisorRequest,
  type SupervisorResponse,
} from './protocol.ts'
import { Supervisor } from './supervisor.ts'

/**
 * The private Unix socket.
 *
 * Two gates, because either alone has a plausible failure: filesystem permissions are one bad umask
 * from open, and a credential alone would be usable by any local process that found the socket.
 */

const credentialMatches = (supplied: string, expected: string): boolean => {
  const a = Buffer.from(supplied)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

const decodeRequest = Schema.decodeUnknownEffect(SupervisorRequest)

const errorResponse = (id: string, error: SandboxError): SupervisorResponse => ({
  id,
  ok: false,
  error: {
    message: error.message,
    phase: error.phase,
    ...(error.diagnostics === undefined ? {} : { diagnostics: error.diagnostics }),
  },
})

const runCommand = (
  supervisor: Supervisor['Service'],
  command: SupervisorRequest['command'],
): Effect.Effect<unknown, SandboxError> => {
  const ref = { workflowId: command.workflowId, revision: command.revision }
  switch (command.kind) {
    case 'build':
      return supervisor.build({
        workflowId: command.workflowId,
        revision: command.revision,
        source: command.source,
        dependencies: command.dependencies,
        allowInstallScripts: command.allowInstallScripts,
      })
    case 'start':
      return supervisor.start({
        ref,
        executionId: command.executionId,
        capabilityCredential: command.capabilityCredential,
        payload: command.payload,
        limits: { ...DEFAULT_RUNTIME_LIMITS, timeoutSeconds: command.timeoutSeconds },
      })
    case 'stop':
      return supervisor.stop(ref)
    case 'inspect':
      return supervisor.inspect(ref)
    case 'destroy':
      return supervisor.destroy(ref)
  }
}

/**
 * Handle one line of the protocol.
 *
 * Exported so the credential and validation gates are testable without a socket — the two things
 * most worth having a direct test for.
 */
export const handleLine = (input: {
  readonly supervisor: Supervisor['Service']
  readonly serviceCredential: string
  readonly line: string
}): Effect.Effect<SupervisorResponse> =>
  Effect.gen(function* () {
    const parsed = yield* Effect.result(
      Effect.try({
        try: () => JSON.parse(input.line) as unknown,
        catch: () => new SandboxError({ message: 'Malformed request.', phase: 'protocol' }),
      }).pipe(Effect.flatMap(decodeRequest)),
    )

    if (parsed._tag === 'Failure') {
      // No id to echo: the request was not well-formed enough to have one.
      return errorResponse(
        '',
        new SandboxError({ message: 'Malformed request.', phase: 'protocol' }),
      )
    }

    const request = parsed.success
    if (!credentialMatches(request.credential, input.serviceCredential)) {
      return errorResponse(
        request.id,
        new SandboxError({ message: 'Unauthorized.', phase: 'protocol' }),
      )
    }

    const outcome = yield* Effect.result(runCommand(input.supervisor, request.command))
    return outcome._tag === 'Success'
      ? { id: request.id, ok: true as const, result: outcome.success }
      : errorResponse(request.id, outcome.failure)
  })

/** Buffer a socket into newline-delimited requests, bounded. */
const readLines = (socket: Socket, onLine: (line: string) => void): void => {
  let buffer = ''
  socket.setEncoding('utf8')
  socket.on('data', (chunk: string) => {
    buffer += chunk
    if (buffer.length > MAX_REQUEST_BYTES) {
      socket.destroy()
      return
    }
    let index = buffer.indexOf('\n')
    while (index !== -1) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      if (line.trim().length > 0) onLine(line)
      index = buffer.indexOf('\n')
    }
  })
}

export const serve = (options: {
  readonly socketPath: string
  readonly serviceCredential: string
}): Effect.Effect<never, SandboxError, Supervisor> =>
  Effect.gen(function* () {
    const supervisor = yield* Supervisor

    return yield* Effect.callback<never, SandboxError>((resume) => {
      const server = createServer((socket) => {
        readLines(socket, (line) => {
          void Effect.runPromise(
            handleLine({ supervisor, serviceCredential: options.serviceCredential, line }),
          ).then((response) => {
            socket.write(`${JSON.stringify(response)}\n`)
          })
        })
      })

      server.on('error', (cause) => {
        resume(
          Effect.fail(
            new SandboxError({ message: `Socket failed: ${cause.message}`, phase: 'protocol' }),
          ),
        )
      })

      void prepareSocketPath(options.socketPath).then(() => {
        server.listen(options.socketPath, () => {
          // Belt and braces: the parent directory already admits only the shared group, so there is no
          // window in which the socket is reachable more widely than this.
          void chmod(options.socketPath, SOCKET_MODE)
        })
      })

      return Effect.sync(() => {
        server.close()
      })
    })
  })

/**
 * Make the socket's directory owner-only before binding.
 *
 * `chmod` after `listen` leaves a window where the socket exists with the process umask. Restricting
 * the directory first closes it, because traversal is denied regardless of the socket's own mode.
 */
const prepareSocketPath = async (socketPath: string): Promise<void> => {
  const directory = dirname(socketPath)
  await mkdir(directory, { recursive: true, mode: SOCKET_DIR_MODE })

  // The directory may belong to someone else — an operator bind-mounting one they manage, or a
  // Docker volume seeded by another image. `chmod` then fails, and crashing over it would be the
  // wrong answer: what matters is whether the mode is *acceptable*, not who set it.
  try {
    await chmod(directory, SOCKET_DIR_MODE)
  } catch {
    const { mode } = await stat(directory)
    if ((mode & 0o007) !== 0) {
      throw new Error(
        `${directory} is world-accessible and this process cannot tighten it. The supervisor socket is the Docker socket by proxy, so refusing is the only safe answer: chown the directory to this user, or mount one that is not world-accessible.`,
      )
    }
  }

  // A socket left by a crashed supervisor would fail `bind` with EADDRINUSE and read as a second
  // instance running.
  await unlink(socketPath).catch(() => undefined)
}
