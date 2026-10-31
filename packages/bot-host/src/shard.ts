import type { Clock } from './clock.ts'
import type { IdentifyGate, Reservation } from './identify.ts'

const Op = {
  Dispatch: 0,
  Heartbeat: 1,
  Identify: 2,
  PresenceUpdate: 3,
  Resume: 6,
  Reconnect: 7,
  InvalidSession: 9,
  Hello: 10,
  HeartbeatAck: 11,
} as const

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
const BACKOFF_BASE_MS = 1_000
const MAX_BACKOFF_MS = 60_000
/** Discord asks for a random 1–5 second wait before identifying after an invalid session. */
const INVALID_SESSION_MIN_MS = 1_000
const INVALID_SESSION_SPREAD_MS = 4_000
/** Discord allows 120 Gateway sends a minute; presence updates stay well below it. */
export const PRESENCE_INTERVAL_MS = 5_000

interface Payload {
  readonly op: number
  readonly d?: unknown
  readonly s?: number | null
  readonly t?: string | null
}

/** The bot's status and activities, as a Gateway presence update carries them. */
export interface Presence {
  readonly since: number | null
  readonly activities: ReadonlyArray<Record<string, unknown>>
  readonly status: string
  readonly afk: boolean
}

const ONLINE: Presence = { since: null, activities: [], status: 'online', afk: false }

/** What a shard needs to resume its Gateway session, possibly from another process. */
export interface ShardSession {
  readonly sessionId: string
  readonly resumeGatewayUrl: string
  /** The last dispatch's sequence number; Discord replays every dispatch after it. */
  readonly sequence: number
  /**
   * How many shards the bot identified with. Every shard of a bot must agree on it, so a bot
   * resumed from stored sessions keeps it.
   */
  readonly shardCount: number
}

export interface ShardOptions {
  readonly token: string
  readonly gatewayUrl: string
  readonly clock: Clock
  /** This shard's ID, from 0 to `shardCount - 1`. Discord assigns it the matching guilds. */
  readonly shardId: number
  readonly shardCount: number
  /** The Gateway intents to identify with, as a bitfield. */
  readonly intents: number
  /** Paces Identifies across the bot's shards. */
  readonly identifies: IdentifyGate
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
  /** Hears every dispatch, `READY` and replayed ones included. */
  readonly onDispatch?: (event: string, data: unknown) => void
}

export interface Shard {
  /** Identify a new session with different intents. */
  readonly setIntents: (intents: number) => void
  /**
   * Set the bot's presence on this shard, now or once `PRESENCE_INTERVAL_MS` has passed since the
   * last update. Later identifies carry it too.
   */
  readonly updatePresence: (presence: Presence) => void
  /** End the session, so Discord shows the bot offline, and stop reconnecting. */
  readonly stop: () => void
  /** Disconnect and stop reconnecting, but leave the session resumable for the next process. */
  readonly suspend: () => void
}

/**
 * One Gateway shard that identifies with an online presence and heartbeats. After a drop it
 * resumes its session, so Discord replays the dispatches it missed, and identifies afresh only
 * once Discord says the session is gone.
 */
export const startShard = ({
  token,
  gatewayUrl,
  clock,
  shardId,
  shardCount,
  intents: initialIntents,
  identifies,
  session: saved,
  onSession,
  onReady,
  onFatal,
  onIdentifyBudgetSpent,
  onDispatch,
}: ShardOptions): Shard => {
  let intents = initialIntents
  let presence = ONLINE
  let presenceSentAt = Number.NEGATIVE_INFINITY
  let cancelPresence: (() => void) | undefined
  /**
   * The latest presence has not reached Discord. Discord closes a connection that sends one
   * before its session starts, so it waits for READY or RESUMED.
   */
  let presenceUnsent = false
  /** The current connection's session has started: READY or RESUMED arrived. */
  let authenticated = false
  let socket: WebSocket | undefined
  let session = saved
  /** A connection to this session's resume URL closed before Hello. */
  let resumeUrlFailed = false
  /** The current connection got Hello. */
  let greeted = false
  let acknowledged = true
  let attempts = 0
  // The heartbeat runs only while connected and the reconnect wait only while not, so one timer.
  let cancelTimer = () => {}
  /** Withdraws a connected shard's wait for its turn to identify. */
  let cancelIdentify = () => {}
  /** The Identify the current connection reserved and has not sent. */
  let reservation: Reservation | undefined

  // A replacement socket may still be connecting when a deferred presence update fires.
  const send = (payload: Payload) => {
    if (socket?.readyState !== WebSocket.OPEN) return false
    socket.send(JSON.stringify(payload))
    return true
  }

  const drop = (code: number) => {
    cancelTimer()
    cancelIdentify()
    reservation?.release()
    reservation = undefined
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

  // A connection without a session identifies after Hello, so it reserves an Identify first.
  const connectToIdentify = () => {
    reservation = identifies.reserve()
    if (reservation !== undefined) return connect()
    const waitMs = identifies.reopensIn()
    onIdentifyBudgetSpent(waitMs)
    cancelTimer = clock.schedule(connectToIdentify, waitMs)
  }

  const connectAfter = (ms: number) => {
    cancelTimer = clock.schedule(session === undefined ? connectToIdentify : connect, ms)
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
    // Discord numbers and names every dispatch.
    const sequence = s as number
    const event = t as string
    if (event === 'READY') {
      const ready = d as { session_id: string; resume_gateway_url: string }
      session = {
        sessionId: ready.session_id,
        resumeGatewayUrl: ready.resume_gateway_url,
        sequence,
        shardCount,
      }
      resumeUrlFailed = false
    } else if (session !== undefined) {
      session = { ...session, sequence }
    }
    if (session !== undefined) onSession(session)
    if (event === 'READY' || event === 'RESUMED') {
      authenticated = true
      if (presenceUnsent && cancelPresence === undefined) sendPresence()
      attempts = 0
      onReady()
    }
    onDispatch?.(event, d)
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
        cancelIdentify = identifies.whenFree(shardId, () => {
          cancelIdentify = () => {}
          reservation?.spend()
          reservation = undefined
          send({
            op: Op.Identify,
            d: {
              token,
              intents,
              shard: [shardId, shardCount],
              properties: { os: process.platform, browser: 'discord-mcp', device: 'discord-mcp' },
              presence,
            },
          })
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
    const url = new URL(gatewayUrl)
    let viaResumeUrl = false
    if (session !== undefined && !resumeUrlFailed) {
      try {
        const resume = new URL(session.resumeGatewayUrl)
        // A received or stored URL must not redirect the connection (and token) off Discord.
        // The origin Discord's API named in `gatewayUrl` is also trusted, so a local test
        // Gateway can resume itself.
        if (
          resume.username === '' &&
          resume.password === '' &&
          ((resume.protocol === url.protocol && resume.host === url.host) ||
            (resume.protocol === 'wss:' &&
              resume.port === '' &&
              resume.hostname.endsWith('.discord.gg')))
        ) {
          // Keep the trusted URL object; copy only the checked authority and resume path.
          url.protocol = resume.protocol
          url.host = resume.host
          url.port = resume.port
          url.pathname = resume.pathname
          url.username = ''
          url.password = ''
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
    authenticated = false
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

  function sendPresence() {
    cancelPresence = undefined
    presenceUnsent = !authenticated || !send({ op: Op.PresenceUpdate, d: presence })
    if (!presenceUnsent) presenceSentAt = clock.now()
  }

  if (session === undefined) connectToIdentify()
  else connect()
  return {
    setIntents: (next) => {
      if (next === intents) return
      intents = next
      // A resumed session keeps the intents it was identified with, so no process may resume it.
      end()
      reconnect()
    },
    updatePresence: (next) => {
      presence = next
      // A pending update sends the latest presence when it runs.
      if (cancelPresence !== undefined) return
      const wait = presenceSentAt + PRESENCE_INTERVAL_MS - clock.now()
      if (wait <= 0) sendPresence()
      else cancelPresence = clock.schedule(sendPresence, wait)
    },
    stop: () => {
      cancelPresence?.()
      drop(NORMAL_CLOSURE)
      end()
    },
    suspend: () => {
      cancelPresence?.()
      drop(RECONNECT_CLOSURE)
    },
  }
}
