import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { WebSocketServer } from 'ws'
import type { Clock } from './clock.ts'

export interface GatewayPayload {
  readonly op: number
  readonly d?: unknown
  readonly s?: number | null
  readonly t?: string | null
}

/** One client connection to the fake Gateway. */
export interface FakeConnection {
  /** The path and query the client connected to, such as `/?v=10&encoding=json`. */
  readonly path: string
  /** Payloads the client sent, oldest first. */
  readonly received: GatewayPayload[]
  /** The close code once the socket closed. */
  closeCode: number | undefined
  /** Whether heartbeats get an ACK. Clear it to make the connection a zombie. */
  acknowledge: boolean
  readonly send: (payload: GatewayPayload) => void
  readonly close: (code: number) => void
}

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 41_250

/**
 * A local stand-in for Discord's Gateway: it says Hello, answers Identify with READY naming
 * itself as the resume URL, and acknowledges heartbeats. Tests drive replays, drops, and closes
 * through `connections`.
 */
export const fakeGateway = async (heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS) => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await once(server, 'listening')
  const { port } = server.address() as AddressInfo
  const url = `ws://127.0.0.1:${port}`
  const connections: FakeConnection[] = []
  server.on('connection', (socket, request) => {
    const connection: FakeConnection = {
      path: request.url ?? '/',
      received: [],
      closeCode: undefined,
      acknowledge: true,
      send: (payload) => socket.send(JSON.stringify(payload)),
      close: (code) => socket.close(code),
    }
    connections.push(connection)
    socket.on('message', (data) => {
      const payload: GatewayPayload = JSON.parse(String(data))
      connection.received.push(payload)
      if (payload.op === 2) {
        connection.send({
          op: 0,
          t: 'READY',
          s: 1,
          d: { v: 10, session_id: 'fake-session', resume_gateway_url: url },
        })
      }
      if (payload.op === 1 && connection.acknowledge) connection.send({ op: 11 })
    })
    socket.on('close', (code) => {
      connection.closeCode = code
    })
    connection.send({ op: 10, d: { heartbeat_interval: heartbeatIntervalMs } })
  })
  return {
    url,
    connections,
    /**
     * A `fetch` that answers `GET /gateway/bot` with this fake's URL, `shards` recommended
     * shards, and a fresh daily Identify budget, unless overridden.
     */
    discordFetch:
      ({
        shards = 1,
        maxConcurrency = 1,
        remaining = 1000,
      }: {
        shards?: number
        maxConcurrency?: number
        remaining?: number
      } = {}): typeof fetch =>
      async (input) =>
        new URL(String(input)).pathname.endsWith('/gateway/bot')
          ? Response.json({
              url,
              shards,
              session_start_limit: {
                total: 1000,
                remaining,
                reset_after: 24 * 60 * 60 * 1000,
                max_concurrency: maxConcurrency,
              },
            })
          : new Response(null, { status: 404 }),
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of server.clients) client.terminate()
        server.close(() => resolve())
      }),
  }
}

/** A clock that moves only when told to, with a fixed `random`. Its `date` starts at `epochMs`. */
export const manualClock = (random = 0.5, epochMs = 0) => {
  let now = 0
  const pending = new Set<{ readonly at: number; readonly run: () => void }>()
  return {
    now: () => now,
    date: () => epochMs + now,
    random: () => random,
    schedule: (run, ms) => {
      const timer = { at: now + ms, run }
      pending.add(timer)
      return () => pending.delete(timer)
    },
    /** Move time forward, running each timer that comes due, in order. */
    advance: (ms: number) => {
      const target = now + ms
      for (;;) {
        const [due] = [...pending].filter((t) => t.at <= target).sort((a, b) => a.at - b.at)
        if (due === undefined) break
        pending.delete(due)
        // A timer overdue after `stall` runs late, as a real one would.
        now = Math.max(now, due.at)
        due.run()
      }
      now = target
    },
    /** Move time forward without running timers, like a blocked event loop. */
    stall: (ms: number) => {
      now += ms
    },
  } satisfies Clock & { advance: (ms: number) => void; stall: (ms: number) => void }
}
