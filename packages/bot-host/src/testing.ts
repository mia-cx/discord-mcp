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
 * A local stand-in for Discord's Gateway: it says Hello, answers Identify with READY, and
 * acknowledges heartbeats. Tests drive drops and closes through `connections`.
 */
export const fakeGateway = async (heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS) => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await once(server, 'listening')
  const connections: FakeConnection[] = []
  server.on('connection', (socket) => {
    const connection: FakeConnection = {
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
        connection.send({ op: 0, t: 'READY', s: 1, d: { v: 10, session_id: 'fake-session' } })
      }
      if (payload.op === 1 && connection.acknowledge) connection.send({ op: 11 })
    })
    socket.on('close', (code) => {
      connection.closeCode = code
    })
    connection.send({ op: 10, d: { heartbeat_interval: heartbeatIntervalMs } })
  })
  const { port } = server.address() as AddressInfo
  return {
    url: `ws://127.0.0.1:${port}`,
    connections,
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of server.clients) client.terminate()
        server.close(() => resolve())
      }),
  }
}

/** A clock that moves only when told to, with a fixed `random`. */
export const manualClock = (random = 0.5) => {
  let now = 0
  const pending = new Set<{ readonly at: number; readonly run: () => void }>()
  return {
    now: () => now,
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
        now = due.at
        due.run()
      }
      now = target
    },
  } satisfies Clock & { advance: (ms: number) => void }
}
