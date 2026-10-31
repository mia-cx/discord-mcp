import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { setTimeout as sleep } from 'node:timers/promises'
import type { Broker } from './broker.ts'

const workerd: { readonly default: string; readonly compatibilityDate: string } = createRequire(
  import.meta.url,
)('workerd')

/** V8 aborts the process past this heap, so a memory hog takes down only its own bot's process. */
const HEAP_LIMIT_MB = 256
const RESULT_LIMIT_BYTES = 1024 * 1024
const STDERR_TAIL_BYTES = 4 * 1024
const STARTUP_RETRY_MS = 10

export type ScriptOutcome =
  | {
      readonly outcome: 'completed'
      readonly result: unknown
      readonly logs: ReadonlyArray<string>
    }
  | {
      readonly outcome: 'threw'
      readonly error: { readonly name: string; readonly message: string }
      readonly logs: ReadonlyArray<string>
    }
  | { readonly outcome: 'timed_out'; readonly timeoutMs: number }
  | { readonly outcome: 'crashed'; readonly message: string }

export interface ScriptExecution {
  /** Executions for one bot run one at a time; different bots run side by side. */
  readonly botId: string
  /** The bot's own user object, which the isolate's client reports as `client.user`. */
  readonly botUser: unknown
  readonly bundle: string
  readonly timeoutMs: number
  readonly broker: Broker
  readonly signal?: AbortSignal
}

/** The isolate's workerd config: the script, plus the broker as its only way out. */
const configFor = (
  brokerSocket: string,
  runSocket: string,
) => `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [
    ( name = "script", worker = (
        modules = [(name = "script.js", esModule = embed "script.js")],
        compatibilityDate = "${workerd.compatibilityDate}",
        globalOutbound = "broker" ) ),
    ( name = "broker", external = (address = "unix:${brokerSocket}", http = (style = proxy)) )
  ],
  sockets = [(name = "run", address = "unix:${runSocket}", http = (), service = "script")],
  v8Flags = ["--max-old-space-size=${HEAP_LIMIT_MB}"]
);
`

/**
 * Serves the broker to workerd. Proxy-style requests carry the full URL the isolate fetched, and
 * no `Host` header. `signal` ends the execution, aborting whatever the broker still has in flight.
 */
const serveBroker = (broker: Broker, signal: AbortSignal) =>
  createServer({ requireHostHeader: false }, async (incoming, outgoing) => {
    try {
      const headers = new Headers()
      for (const [name, value] of Object.entries(incoming.headers)) {
        for (const item of Array.isArray(value) ? value : [value ?? '']) headers.append(name, item)
      }
      const hasBody = incoming.method !== 'GET' && incoming.method !== 'HEAD'
      const response = await broker(
        new Request(incoming.url ?? '', {
          method: incoming.method ?? 'GET',
          headers,
          signal,
          ...(hasBody ? { body: Readable.toWeb(incoming) as ReadableStream, duplex: 'half' } : {}),
        }),
      )
      outgoing.writeHead(response.status, [...response.headers].flat())
      if (response.body === null) outgoing.end()
      else Readable.fromWeb(response.body).pipe(outgoing)
    } catch {
      outgoing.writeHead(502).end()
    }
  })

const listen = (server: Server, path: string) =>
  new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(path, resolve)
  })

const readLimited = async (response: IncomingMessage) => {
  let body = ''
  for await (const chunk of response) {
    body += chunk
    if (body.length > RESULT_LIMIT_BYTES) {
      response.destroy()
      return undefined
    }
  }
  return body
}

/** Send the one request that runs the script, waiting for workerd to open its socket first. */
const invoke = async (socketPath: string, botUser: unknown, signal: AbortSignal) => {
  const payload = JSON.stringify({ user: botUser })
  for (;;) {
    try {
      return await new Promise<string | undefined>((resolve, reject) => {
        const request = httpRequest({ socketPath, path: '/', method: 'POST', signal }, (response) =>
          readLimited(response).then(resolve, reject),
        )
        request.on('error', reject)
        request.end(payload)
      })
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ECONNREFUSED') throw error
      await sleep(STARTUP_RETRY_MS, undefined, { signal })
    }
  }
}

const parseOutcome = (body: string | undefined): ScriptOutcome =>
  body === undefined
    ? { outcome: 'crashed', message: `The script's result exceeded ${RESULT_LIMIT_BYTES} bytes.` }
    : (JSON.parse(body) as ScriptOutcome)

/**
 * Run one script in a fresh workerd process, killed at the deadline.
 *
 * Self-hosted workerd enforces no CPU limit, and one spinning isolate stalls its whole process, so
 * the process boundary is the limit: each execution gets its own process and its own broker socket.
 * Both sockets live in a private temporary directory, and the token never enters it.
 */
const execute = async (execution: ScriptExecution): Promise<ScriptOutcome> => {
  const dir = await mkdtemp(join(tmpdir(), 'textile-script-'))
  const brokerSocket = join(dir, 'broker.sock')
  const runSocket = join(dir, 'run.sock')
  const stop = new AbortController()
  const signal =
    execution.signal === undefined ? stop.signal : AbortSignal.any([stop.signal, execution.signal])
  const server = serveBroker(execution.broker, signal)
  let stderr = ''
  try {
    await listen(server, brokerSocket)
    await writeFile(join(dir, 'script.js'), execution.bundle)
    await writeFile(join(dir, 'config.capnp'), configFor(brokerSocket, runSocket))
    const child = spawn(workerd.default, ['serve', 'config.capnp'], {
      cwd: dir,
      env: {},
      stdio: ['ignore', 'ignore', 'pipe'],
      signal,
      killSignal: 'SIGKILL',
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-STDERR_TAIL_BYTES)
    })
    child.on('error', () => {})

    return await new Promise<ScriptOutcome>((resolve, reject) => {
      const timer = setTimeout(
        () => resolve({ outcome: 'timed_out', timeoutMs: execution.timeoutMs }),
        execution.timeoutMs,
      )
      signal.addEventListener('abort', () => clearTimeout(timer), { once: true })
      child.once('exit', (code, exitSignal) =>
        resolve({
          outcome: 'crashed',
          message:
            `workerd exited (${code ?? exitSignal}) before the script finished.\n${stderr}`.trim(),
        }),
      )
      invoke(runSocket, execution.botUser, signal).then(
        (body) => resolve(parseOutcome(body)),
        (error: unknown) => (signal.aborted ? undefined : reject(error)),
      )
      execution.signal?.addEventListener('abort', () => reject(execution.signal?.reason), {
        once: true,
      })
    })
  } finally {
    stop.abort()
    server.closeAllConnections()
    server.close()
    await rm(dir, { recursive: true, force: true })
  }
}

export interface IsolateHost {
  readonly run: (execution: ScriptExecution) => Promise<ScriptOutcome>
}

/** Runs scripts one at a time per bot, each in its own workerd process. */
export const makeIsolateHost = (): IsolateHost => {
  const queues = new Map<string, Promise<unknown>>()
  return {
    run: (execution) => {
      const previous = queues.get(execution.botId) ?? Promise.resolve()
      const current = previous.then(() => {
        execution.signal?.throwIfAborted()
        return execute(execution)
      })
      const settled = current.catch(() => undefined)
      queues.set(execution.botId, settled)
      void settled.then(() => {
        if (queues.get(execution.botId) === settled) queues.delete(execution.botId)
      })
      return current
    },
  }
}
