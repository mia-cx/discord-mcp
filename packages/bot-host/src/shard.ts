import type { Clock } from './clock.ts'

const Op = {
  Dispatch: 0,
  Heartbeat: 1,
  Identify: 2,
  Reconnect: 7,
  InvalidSession: 9,
  Hello: 10,
  HeartbeatAck: 11,
} as const

/** Discord refuses a new session after these too, so reconnecting cannot help. */
const FATAL_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014])
/** Ends the session, so Discord shows the bot offline at once. */
const NORMAL_CLOSURE = 1000
/** Closes a connection we are about to replace. */
const RECONNECT_CLOSURE = 4000
const BACKOFF_BASE_MS = 1_000
const MAX_BACKOFF_MS = 60_000
/** Discord asks for a random 1–5 second wait before identifying after an invalid session. */
const INVALID_SESSION_MIN_MS = 1_000
const INVALID_SESSION_SPREAD_MS = 4_000

interface Payload {
  readonly op: number
  readonly d?: unknown
  readonly s?: number | null
  readonly t?: string | null
}

export interface ShardOptions {
  readonly token: string
  readonly gatewayUrl: string
  readonly clock: Clock
  readonly onReady: () => void
  /** Discord rejected the session for good; the shard has stopped. */
  readonly onFatal: (code: number) => void
}

export interface Shard {
  /** Close the connection and stop reconnecting. */
  readonly stop: () => void
}

/**
 * One Gateway shard that identifies with an online presence, heartbeats, and reconnects with a
 * fresh identify after any drop. Shard 0 of 1, no intents, no resume.
 */
export const startShard = ({ token, gatewayUrl, clock, onReady, onFatal }: ShardOptions): Shard => {
  let socket: WebSocket | undefined
  let sequence: number | null = null
  let acknowledged = true
  let attempts = 0
  // The heartbeat runs only while connected and the reconnect wait only while not, so one timer.
  let cancelTimer = () => {}

  const send = (payload: Payload) => socket?.send(JSON.stringify(payload))

  const drop = (code: number) => {
    cancelTimer()
    const current = socket
    socket = undefined
    current?.close(code)
  }

  const connectAfter = (ms: number) => {
    cancelTimer = clock.schedule(connect, ms)
  }

  const reconnect = () => {
    drop(RECONNECT_CLOSURE)
    connectAfter(Math.min(BACKOFF_BASE_MS * 2 ** attempts, MAX_BACKOFF_MS) * clock.random())
    attempts += 1
  }

  const heartbeat = (interval: number) => {
    // No ACK since the last beat: the connection is a zombie.
    if (!acknowledged) return reconnect()
    acknowledged = false
    send({ op: Op.Heartbeat, d: sequence })
    cancelTimer = clock.schedule(() => heartbeat(interval), interval)
  }

  const receive = (payload: Payload) => {
    if (typeof payload.s === 'number') sequence = payload.s
    switch (payload.op) {
      case Op.Hello: {
        const { heartbeat_interval: interval } = payload.d as { heartbeat_interval: number }
        cancelTimer()
        cancelTimer = clock.schedule(() => heartbeat(interval), interval * clock.random())
        send({
          op: Op.Identify,
          d: {
            token,
            intents: 0,
            properties: { os: process.platform, browser: 'discord-mcp', device: 'discord-mcp' },
            presence: { since: null, activities: [], status: 'online', afk: false },
          },
        })
        return
      }
      case Op.HeartbeatAck:
        acknowledged = true
        return
      case Op.Heartbeat:
        send({ op: Op.Heartbeat, d: sequence })
        return
      case Op.Reconnect:
        return reconnect()
      case Op.InvalidSession:
        drop(RECONNECT_CLOSURE)
        return connectAfter(INVALID_SESSION_MIN_MS + INVALID_SESSION_SPREAD_MS * clock.random())
      case Op.Dispatch:
        if (payload.t === 'READY') {
          attempts = 0
          onReady()
        }
    }
  }

  function connect() {
    const ws = new WebSocket(`${gatewayUrl}/?v=10&encoding=json`)
    socket = ws
    sequence = null
    acknowledged = true
    // Events from a socket we already dropped are stale.
    ws.addEventListener('message', (event) => {
      if (ws === socket) receive(JSON.parse(String(event.data)))
    })
    ws.addEventListener('close', ({ code }) => {
      if (ws !== socket) return
      if (FATAL_CLOSE_CODES.has(code)) {
        drop(code)
        return onFatal(code)
      }
      reconnect()
    })
  }

  connect()
  return { stop: () => drop(NORMAL_CLOSURE) }
}
