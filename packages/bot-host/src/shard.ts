import type { Clock } from './clock.ts'

const Op = {
  Dispatch: 0,
  Heartbeat: 1,
  Identify: 2,
  Resume: 6,
  Reconnect: 7,
  InvalidSession: 9,
  Hello: 10,
  HeartbeatAck: 11,
} as const

/** `GUILDS` and `GUILD_VOICE_STATES`: voice joins need the bot's own voice state updates. */
const INTENTS = (1 << 0) | (1 << 7)
/** Discord refuses a new session after these too, so reconnecting cannot help. */
const FATAL_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014])
/**
 * An invalidated session, an invalid sequence number, or a timed-out session: reconnecting needs
 * a new session. We never send a payload before identifying, the other cause of 4003.
 */
const SESSION_ENDED_CLOSE_CODES = new Set([4003, 4007, 4009])
/** Ends the session, so Discord shows the bot offline at once. */
const NORMAL_CLOSURE = 1000
/** Closes a connection we are about to replace; any code but 1000 and 1001 keeps the session. */
const RECONNECT_CLOSURE = 4000
/** Discord allows one Identify per five seconds for a bot without large-bot sharding. */
const IDENTIFY_INTERVAL_MS = 5_000
const DAY_MS = 24 * 60 * 60 * 1000
/**
 * Discord resets a bot's token after 1,000 Identifies in 24 hours. Half of that leaves room for
 * the bot's other clients; a healthy shard identifies a few times a day.
 */
const DAILY_IDENTIFY_BUDGET = 500
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

/**
 * The earliest time a shard may identify again, given its Identify times from the last 24 hours,
 * oldest first.
 */
export const nextIdentifyAt = (identifiedAt: ReadonlyArray<number>, now: number): number => {
  const [oldest] = identifiedAt
  const latest = identifiedAt.at(-1) ?? Number.NEGATIVE_INFINITY
  const budgetReopens =
    oldest !== undefined && identifiedAt.length >= DAILY_IDENTIFY_BUDGET
      ? oldest + DAY_MS
      : Number.NEGATIVE_INFINITY
  return Math.max(now, latest + IDENTIFY_INTERVAL_MS, budgetReopens)
}

/** What a shard needs to resume its Gateway session, possibly from another process. */
export interface ShardSession {
  readonly sessionId: string
  readonly resumeGatewayUrl: string
  /** The last dispatch's sequence number; Discord replays every dispatch after it. */
  readonly sequence: number
}

export interface ShardOptions {
  readonly token: string
  readonly gatewayUrl: string
  readonly clock: Clock
  /** A session to resume instead of identifying, such as one a previous process saved. */
  readonly session?: ShardSession
  /**
   * The session to store changed: a new session, a later sequence number, or `undefined` once
   * the bot goes offline for good. A session Discord invalidates is not reported: the next READY
   * replaces it. Called in order.
   */
  readonly onSession: (session: ShardSession | undefined) => void
  readonly onReady: () => void
  /** Discord rejected the session for good; the shard has stopped. */
  readonly onFatal: (code: number) => void
  /** The daily Identify budget is spent; the shard reconnects after `waitMs`. */
  readonly onIdentifyBudgetSpent: (waitMs: number) => void
  /** Hears every dispatch, `READY` and `RESUMED` included. */
  readonly onDispatch?: (event: string, data: unknown) => void
}

export interface Shard {
  /** Send a payload on the open connection. False when there is none. */
  readonly send: (payload: { readonly op: number; readonly d: unknown }) => boolean
  /** End the session, so Discord shows the bot offline, and stop reconnecting. */
  readonly stop: () => void
  /** Disconnect and stop reconnecting, but leave the session resumable for the next process. */
  readonly suspend: () => void
}

/**
 * One Gateway shard that identifies with an online presence and heartbeats. After a drop it
 * resumes its session, so Discord replays the dispatches it missed, and identifies afresh only
 * once Discord says the session is gone. Shard 0 of 1, guild and voice state intents.
 */
export const startShard = ({
  token,
  gatewayUrl,
  clock,
  session: saved,
  onSession,
  onReady,
  onFatal,
  onIdentifyBudgetSpent,
  onDispatch,
}: ShardOptions): Shard => {
  let socket: WebSocket | undefined
  let session = saved
  /** A connection to this session's resume URL closed before Hello. */
  let resumeUrlFailed = false
  /** The current connection got Hello. */
  let greeted = false
  let acknowledged = true
  let attempts = 0
  const identifiedAt: number[] = []
  // The heartbeat runs only while connected and the reconnect wait only while not, so one timer.
  let cancelTimer = () => {}

  const send = (payload: Payload) => socket?.send(JSON.stringify(payload))

  const drop = (code: number) => {
    cancelTimer()
    const current = socket
    socket = undefined
    current?.close(code)
  }

  // Discord invalidated the session: identify afresh. The stored copy stays until the next READY
  // replaces it, so a restart in between still finds the bot; resuming it fails over to Identify.
  const forget = () => {
    session = undefined
  }

  // The bot is going offline for good, so nothing may resume it.
  const end = () => {
    session = undefined
    onSession(undefined)
  }

  // A connection without a session identifies right after Hello, so Identify limits gate it.
  const connectAfter = (ms: number) => {
    if (session !== undefined) {
      cancelTimer = clock.schedule(connect, ms)
      return
    }
    const now = clock.now()
    while (identifiedAt[0] !== undefined && identifiedAt[0] <= now - DAY_MS) identifiedAt.shift()
    const limitWait = nextIdentifyAt(identifiedAt, now) - now
    if (identifiedAt.length >= DAILY_IDENTIFY_BUDGET) onIdentifyBudgetSpent(limitWait)
    cancelTimer = clock.schedule(connect, Math.max(ms, limitWait))
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
    send({ op: Op.Heartbeat, d: session?.sequence ?? null })
    cancelTimer = clock.schedule(() => heartbeat(interval), interval)
  }

  const dispatch = ({ t, d, s }: Payload) => {
    // Discord numbers every dispatch.
    const sequence = s as number
    if (t === 'READY') {
      const ready = d as { session_id: string; resume_gateway_url: string }
      session = {
        sessionId: ready.session_id,
        resumeGatewayUrl: ready.resume_gateway_url,
        sequence,
      }
      resumeUrlFailed = false
    } else if (session !== undefined) {
      session = { ...session, sequence }
    }
    if (session !== undefined) onSession(session)
    if (t === 'READY' || t === 'RESUMED') {
      attempts = 0
      onReady()
    }
    if (typeof t === 'string') onDispatch?.(t, d)
  }

  const receive = (payload: Payload) => {
    switch (payload.op) {
      case Op.Hello: {
        const { heartbeat_interval: interval } = payload.d as { heartbeat_interval: number }
        greeted = true
        cancelTimer()
        cancelTimer = clock.schedule(() => heartbeat(interval), interval * clock.random())
        if (session !== undefined) {
          send({
            op: Op.Resume,
            d: { token, session_id: session.sessionId, seq: session.sequence },
          })
          return
        }
        identifiedAt.push(clock.now())
        send({
          op: Op.Identify,
          d: {
            token,
            intents: INTENTS,
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
        send({ op: Op.Heartbeat, d: session?.sequence ?? null })
        return
      case Op.Reconnect:
        return reconnect()
      case Op.InvalidSession:
        // `d` says whether the session may still be resumed.
        if (payload.d !== true) forget()
        drop(RECONNECT_CLOSURE)
        return connectAfter(INVALID_SESSION_MIN_MS + INVALID_SESSION_SPREAD_MS * clock.random())
      case Op.Dispatch:
        return dispatch(payload)
    }
  }

  function connect() {
    // Discord says to fall back to the initial URL when the resume URL fails.
    let url = new URL(gatewayUrl)
    let viaResumeUrl = false
    if (session !== undefined && !resumeUrlFailed) {
      try {
        const resume = new URL(session.resumeGatewayUrl)
        // A received or stored URL must not redirect the connection (and token) off Discord.
        // The configured origin is also trusted, so a local test Gateway can resume itself.
        if (
          resume.username === '' &&
          resume.password === '' &&
          ((resume.protocol === url.protocol && resume.host === url.host) ||
            (resume.protocol === 'wss:' &&
              resume.port === '' &&
              resume.hostname.endsWith('.discord.gg')))
        ) {
          url = resume
          viaResumeUrl = true
        }
      } catch {
        // A malformed resume URL falls back too, without losing the session.
      }
    }
    url.pathname = `${url.pathname.replace(/\/$/, '')}/`
    url.search = '?v=10&encoding=json'
    url.hash = ''
    const ws = new WebSocket(url)
    socket = ws
    greeted = false
    acknowledged = true
    // Events from a socket we already dropped are stale.
    ws.addEventListener('message', (event) => {
      if (ws === socket) receive(JSON.parse(String(event.data)))
    })
    ws.addEventListener('close', ({ code }) => {
      if (ws !== socket) return
      if (FATAL_CLOSE_CODES.has(code)) {
        drop(code)
        end()
        return onFatal(code)
      }
      if (viaResumeUrl && !greeted) resumeUrlFailed = true
      if (SESSION_ENDED_CLOSE_CODES.has(code)) forget()
      reconnect()
    })
  }

  connect()
  return {
    send: (payload) => {
      if (socket?.readyState !== WebSocket.OPEN) return false
      send(payload)
      return true
    },
    stop: () => {
      drop(NORMAL_CLOSURE)
      end()
    },
    suspend: () => drop(RECONNECT_CLOSURE),
  }
}
