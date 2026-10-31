import type { Clock } from './clock.ts'
import { type Dispatch, type Presence, type Shard, type ShardSession, startShard } from './shard.ts'
import type { TokenVault } from './vault.ts'

export const IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1000
export const DISCORD_GATEWAY_URL = 'wss://gateway.discord.gg'
/** Each bot runs one shard. */
const SHARD_ID = 0
const SESSION_RETRY_MS = 60_000

/** A Gateway event for an online bot, with the token a workflow run acts with. */
export interface BotEvent {
  readonly botId: string
  readonly token: string
  readonly dispatch: Dispatch
}

export interface BotRuntimesOptions {
  readonly vault: TokenVault
  readonly clock: Clock
  /** Operator-facing lifecycle messages and failures. Never receives a token. */
  readonly log: (message: string) => void
  /** Hears every Gateway event of every online bot, replayed ones included. */
  readonly onEvent?: (event: BotEvent) => void
  readonly gatewayUrl?: string
}

export interface BotRuntimes {
  /**
   * Record an agent call for a bot Discord has verified. The first call stores its token and
   * brings it online; each call restarts its 24-hour idle timer. Resolves once the token is
   * stored. Failures are logged rather than thrown, so they never fail the agent's call.
   */
  readonly use: (botId: string, token: string) => Promise<void>
  /**
   * Bring back every bot a previous process left online, resuming its stored session so Discord
   * replays the events it missed. Each starts a fresh 24-hour idle timer. Failures are logged.
   */
  readonly resume: () => Promise<void>
  /**
   * Keep a bot online with these Gateway intents while it has enabled workflows. `undefined`
   * releases it, and its 24-hour idle timer starts over. A held bot that is offline comes online
   * with its stored token, once `resume` has run, so a stored session is resumed rather than
   * replaced. Failures are logged rather than thrown.
   */
  readonly hold: (botId: string, intents: number | undefined) => Promise<void>
  /** Set an online bot's presence. Throws when the bot is offline. */
  readonly updatePresence: (botId: string, presence: Presence) => void
  /**
   * Disconnect every bot without ending its session, so the next process can resume it.
   * Resolves once every pending storage write has settled.
   */
  readonly close: () => Promise<void>
}

interface Runtime {
  readonly token: string
  shard?: Shard
  cancelIdle: () => void
}

const reason = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

/** The bots this process keeps online, one runtime per bot. */
export const createBotRuntimes = ({
  vault,
  clock,
  log,
  onEvent,
  gatewayUrl = DISCORD_GATEWAY_URL,
}: BotRuntimesOptions): BotRuntimes => {
  const running = new Map<string, Runtime>()
  /** The intents of each bot with enabled workflows, which stays online without agent calls. */
  const held = new Map<string, number>()
  let resumed = false
  /** Tokens Discord rejected for good, by bot. Retrying them only spends Identifies. */
  const rejected = new Map<string, string>()
  /**
   * Each bot's storage writes, chained so they land in order: a replaced token never overwrites
   * its successor, and an ended session never outlives the next one.
   */
  const writes = new Map<string, Promise<void>>()
  /** Sessions waiting in their bot's write chain. Only the newest is written. */
  const unsaved = new Map<string, ShardSession | undefined>()
  /** Failed session writes waiting to retry, by bot. Any newer write for the bot replaces one. */
  const retries = new Map<
    string,
    { readonly session: ShardSession | undefined; readonly cancel: () => void }
  >()

  const write = (botId: string, task: () => Promise<void>) => {
    const done = (writes.get(botId) ?? Promise.resolve()).then(task)
    writes.set(
      botId,
      done.catch(() => {}),
    )
    return done
  }

  // A crash loses the writes still queued or waiting to retry, so the next process finds an
  // older session or none. It may replay events twice, identify afresh, leave an online bot
  // offline, or resume a bot that went offline on purpose.
  const saveSession = (botId: string, session: ShardSession | undefined) => {
    retries.get(botId)?.cancel()
    retries.delete(botId)
    const queued = unsaved.has(botId)
    unsaved.set(botId, session)
    if (queued) return
    let latest: ShardSession | undefined
    write(botId, () => {
      latest = unsaved.get(botId)
      unsaved.delete(botId)
      return latest === undefined
        ? vault.clearSession(botId, SHARD_ID)
        : vault.storeSession(botId, SHARD_ID, latest)
    }).catch((cause) => {
      log(`Saving bot ${botId}'s Gateway session failed: ${reason(cause)}`)
      // A newer session is already queued behind this one.
      if (unsaved.has(botId)) return
      // Retry until storage recovers. A lost store can leave an online bot unresumable, since
      // READY may be its last dispatch; a lost clear lets the next process revive an idle bot.
      const cancel = clock.schedule(() => saveSession(botId, latest), SESSION_RETRY_MS)
      retries.set(botId, { session: latest, cancel })
    })
  }

  const stop = (botId: string, runtime: Runtime) => {
    if (running.get(botId) !== runtime) return
    running.delete(botId)
    runtime.cancelIdle()
    runtime.shard?.stop()
  }

  const keepAlive = (botId: string, runtime: Runtime) => {
    runtime.cancelIdle()
    runtime.cancelIdle = clock.schedule(() => {
      if (held.has(botId)) return
      log(`Bot ${botId} went offline after 24 hours without an agent call.`)
      stop(botId, runtime)
    }, IDLE_TIMEOUT_MS)
  }

  const add = (botId: string, token: string) => {
    const runtime: Runtime = { token, cancelIdle: () => {} }
    running.set(botId, runtime)
    keepAlive(botId, runtime)
    return runtime
  }

  const connect = (botId: string, runtime: Runtime, session?: ShardSession) => {
    runtime.shard = startShard({
      token: runtime.token,
      gatewayUrl,
      clock,
      intents: held.get(botId) ?? 0,
      ...(session && { session }),
      onSession: (next) => saveSession(botId, next),
      onReady: () => log(`Bot ${botId} is online.`),
      onDispatch: (dispatch) => onEvent?.({ botId, token: runtime.token, dispatch }),
      onIdentifyBudgetSpent: (waitMs) =>
        log(
          `Bot ${botId} is offline: it spent its daily Gateway Identify budget. Reconnecting in ${Math.ceil(waitMs / 60_000)} minutes.`,
        ),
      onFatal: (code) => {
        log(
          `Bot ${botId} is offline: Discord closed its Gateway session with code ${code}. It stays offline until its token changes or the server restarts.`,
        )
        rejected.set(botId, runtime.token)
        stop(botId, runtime)
      },
    })
  }

  /** Bring a held bot online with its stored token. */
  const startHeld = async (botId: string) => {
    let token: string | undefined
    try {
      token = await vault.load(botId)
    } catch (cause) {
      return log(`Bot ${botId} stays offline: ${reason(cause)}`)
    }
    if (token === undefined) return log(`Bot ${botId} stays offline: no token is stored for it.`)
    // An agent call brought it online, or its workflows were disabled, while loading.
    if (running.has(botId) || !held.has(botId) || rejected.get(botId) === token) return
    connect(botId, add(botId, token))
  }

  return {
    use: (botId, token) => {
      if (rejected.get(botId) === token) return Promise.resolve()
      const current = running.get(botId)
      if (current?.token === token) {
        keepAlive(botId, current)
        return Promise.resolve()
      }
      // A reset token invalidates the old session, so start over with the new one.
      if (current !== undefined) stop(botId, current)
      const runtime = add(botId, token)
      return write(botId, () => vault.store(botId, token)).then(
        () => {
          // Idle, closed, or replaced by a new token while storing.
          if (running.get(botId) === runtime) connect(botId, runtime)
        },
        (cause) => {
          log(`Bot ${botId} stays offline: ${reason(cause)}`)
          stop(botId, runtime)
        },
      )
    },
    resume: async () => {
      const stored = await vault.loadSessions().catch((cause) => {
        log(`Could not resume bots from storage: ${reason(cause)}`)
        return []
      })
      for (const { botId, token, session } of stored) {
        // An agent call brought it online first.
        if (running.has(botId)) continue
        connect(botId, add(botId, token), session)
      }
      resumed = true
      await Promise.all([...held.keys()].filter((id) => !running.has(id)).map(startHeld))
    },
    hold: async (botId, intents) => {
      if (intents === undefined) {
        held.delete(botId)
        const current = running.get(botId)
        if (current !== undefined) keepAlive(botId, current)
        return
      }
      held.set(botId, intents)
      const current = running.get(botId)
      // A runtime still storing its token connects with these intents once it has.
      if (current !== undefined) return current.shard?.setIntents(intents)
      if (resumed) await startHeld(botId)
    },
    updatePresence: (botId, presence) => {
      const shard = running.get(botId)?.shard
      if (shard === undefined) throw new Error(`Bot ${botId} is offline.`)
      shard.updatePresence(presence)
    },
    close: async () => {
      for (const [botId, runtime] of running) {
        running.delete(botId)
        runtime.cancelIdle()
        runtime.shard?.suspend()
      }
      await Promise.all(writes.values())
      // One last try at failed writes, so the next process starts from the newest state.
      for (const [botId, { session }] of retries) saveSession(botId, session)
      await Promise.all(writes.values())
      for (const { cancel } of retries.values()) cancel()
      retries.clear()
    },
  }
}
