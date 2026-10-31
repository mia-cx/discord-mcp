import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http'
import { createRequire } from 'node:module'
import { availableParallelism, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import type { Broker } from './broker.ts'
import type { ScriptModule } from './bundle.ts'

interface Workerd {
  /** The platform binary's path. */
  readonly default: string
  readonly compatibilityDate: string
}

/** Loaded on first use: it throws on a platform with no workerd build, which must not stop the relay. */
const loadWorkerd = (): Workerd => createRequire(import.meta.url)('workerd')

/** V8 aborts the process past this heap, so a memory hog takes down only its own bot's process. */
const HEAP_LIMIT_MB = 256
const RESULT_LIMIT_BYTES = 1024 * 1024
const STDERR_TAIL_BYTES = 4 * 1024
const STARTUP_RETRY_MS = 10
/** Enough that a host with few CPUs still runs one bot's runaway beside other bots' work. */
const MIN_CONCURRENCY = 4

/** A Gateway dispatch: its event name and data. */
export interface GatewayEvent {
  readonly t: string
  readonly d: Record<string, unknown>
}

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
  /**
   * Executions with the same queue run one at a time, in order; others run side by side. Scripts
   * queue per bot, workflow events per bot and guild.
   */
  readonly queue: string
  /** The bot's own user object, which the isolate's client reports as `client.user`. */
  readonly botUser: unknown
  /** From `prepareScript`; the first is the entry module. */
  readonly modules: ReadonlyArray<ScriptModule>
  /**
   * What to run. Omitted, the script's default export; `event`, a workflow's listeners for one
   * Gateway dispatch; `probe`, a report of the events and intents a workflow's clients declare.
   */
  readonly input?: { readonly event: GatewayEvent } | { readonly probe: true }
  /**
   * Starts without waiting for a free process slot, for an interaction Discord expects answered
   * within three seconds. Interactions are rare enough to leave uncounted.
   */
  readonly urgent?: boolean
  readonly timeoutMs: number
  readonly broker: Broker
  readonly signal?: AbortSignal
}

/** The isolate's workerd config: the script's modules, plus the broker as its only way out. */
const configFor = (
  workerd: Workerd,
  modules: ReadonlyArray<ScriptModule>,
  brokerSocket: string,
  runSocket: string,
) => `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [
    ( name = "script", worker = (
        modules = [${modules.map(({ name, type }) => `(name = "${name}", ${type} = embed "${name}")`).join(', ')}],
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
      // HTTP's own rule for whether a request has a body; bodyless writes like reactions send none.
      const hasBody =
        incoming.headers['transfer-encoding'] !== undefined ||
        Number(incoming.headers['content-length'] ?? 0) > 0
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
      // A body that fails midway resets the isolate's connection, which its fetch reports.
      else await pipeline(Readable.fromWeb(response.body), outgoing).catch(() => undefined)
    } catch {
      if (outgoing.headersSent) outgoing.destroy()
      else outgoing.writeHead(502).end()
    }
  })

const listen = (server: Server, path: string) =>
  new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(path, resolve)
  })

const readLimited = async (response: IncomingMessage) => {
  response.setEncoding('utf8')
  let body = ''
  for await (const chunk of response as AsyncIterable<string>) {
    body += chunk
    if (Buffer.byteLength(body) > RESULT_LIMIT_BYTES) {
      response.destroy()
      return undefined
    }
  }
  return body
}

/** Send the one request that runs the script, waiting for workerd to open its socket first. */
const invoke = async (socketPath: string, payload: string, signal: AbortSignal) => {
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

/** The entry module answers with an outcome; anything else is workerd's own error page. */
const parseOutcome = (body: string | undefined, stderr: () => string): ScriptOutcome => {
  if (body === undefined) {
    return {
      outcome: 'crashed',
      message: `The script's result exceeded ${RESULT_LIMIT_BYTES} bytes.`,
    }
  }
  try {
    return JSON.parse(body) as ScriptOutcome
  } catch {
    return {
      outcome: 'crashed',
      message: `The script ended without a result: ${body.slice(0, 200)}\n${stderr()}`.trim(),
    }
  }
}

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
    let workerd: Workerd
    try {
      workerd = loadWorkerd()
    } catch (error) {
      return { outcome: 'crashed', message: `workerd is unavailable here: ${String(error)}` }
    }
    await listen(server, brokerSocket)
    for (const { name, source } of execution.modules) await writeFile(join(dir, name), source)
    await writeFile(
      join(dir, 'config.capnp'),
      configFor(workerd, execution.modules, brokerSocket, runSocket),
    )
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

    return await new Promise<ScriptOutcome>((resolve, reject) => {
      const timer = setTimeout(
        () => resolve({ outcome: 'timed_out', timeoutMs: execution.timeoutMs }),
        execution.timeoutMs,
      )
      signal.addEventListener('abort', () => clearTimeout(timer), { once: true })
      let dropped = ''
      child.once('error', (error) => {
        if (!signal.aborted) {
          resolve({ outcome: 'crashed', message: `workerd did not start: ${error.message}` })
        }
      })
      child.once('exit', (code, exitSignal) =>
        resolve({
          outcome: 'crashed',
          message:
            `workerd exited (${code ?? exitSignal}) before the script finished.${dropped}\n${stderr}`.trim(),
        }),
      )
      invoke(
        runSocket,
        JSON.stringify({ user: execution.botUser, ...execution.input }),
        signal,
      ).then(
        (body) => resolve(parseOutcome(body, () => stderr)),
        // The connection dropped: workerd died or is dying. Its exit reports why, with stderr.
        (error: unknown) => {
          if (signal.aborted) return
          dropped = ` The connection to it failed: ${String(error)}.`
          child.kill('SIGKILL')
        },
      )
      // Removed when this execution ends: a workflow's signal outlives thousands of them.
      execution.signal?.addEventListener('abort', () => reject(execution.signal?.reason), {
        once: true,
        signal: stop.signal,
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

/**
 * Runs executions one at a time per queue, each in its own workerd process, with at most
 * `concurrency` processes at once. Executions over the limit wait their turn, oldest first.
 */
export const makeIsolateHost = (
  concurrency = Math.max(MIN_CONCURRENCY, availableParallelism()),
): IsolateHost => {
  const queues = new Map<string, Promise<unknown>>()
  let running = 0
  const waiting: Array<() => void> = []
  // A finished execution hands its slot straight to the oldest waiting one.
  const release = () => {
    const next = waiting.shift()
    if (next === undefined) running -= 1
    else next()
  }
  const acquire = () => {
    if (running < concurrency) {
      running += 1
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => waiting.push(resolve))
  }
  return {
    run: (execution) => {
      const previous = queues.get(execution.queue) ?? Promise.resolve()
      const current = previous.then(async () => {
        execution.signal?.throwIfAborted()
        if (execution.urgent) return execute(execution)
        await acquire()
        try {
          execution.signal?.throwIfAborted()
          return await execute(execution)
        } finally {
          release()
        }
      })
      const settled = current.catch(() => undefined)
      queues.set(execution.queue, settled)
      void settled.then(() => {
        if (queues.get(execution.queue) === settled) queues.delete(execution.queue)
      })
      return current
    },
  }
}
