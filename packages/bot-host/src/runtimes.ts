import type { Clock } from './clock.ts'
import { createIdentifyGate, type SessionStartLimit } from './identify.ts'
import { type Shard, type ShardSession, startShard } from './shard.ts'
import type { TokenVault } from './vault.ts'

export const IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1000
export const DISCORD_API_URL = 'https://discord.com/api/v10'
const RETRY_MS = 60_000
const UNAUTHORIZED = 401
/** An invalid shard, or a bot that outgrew its shard count. A fresh count fixes both. */
const RESHARD_CLOSE_CODES = new Set([4010, 4011])

export interface BotRuntimesOptions {
  readonly vault: TokenVault
  readonly clock: Clock
  /** Operator-facing lifecycle messages and failures. Never receives a token. */
  readonly log: (message: string) => void
  /** Reaches Discord's REST API for each bot's Gateway URL, shard count, and Identify limits. */
  readonly discordFetch?: typeof fetch
  /** Hears every dispatch from every shard of every bot, replayed ones included. */
  readonly onDispatch?: (botId: string, event: string, data: unknown) => void
}

export interface BotRuntimes {
  /**
   * Record an agent call for a bot Discord has verified. The first call stores its token and
   * brings it online; each call restarts its 24-hour idle timer. Resolves once the token is
   * stored. Failures are logged rather than thrown, so they never fail the agent's call.
   */
  readonly use: (botId: string, token: string) => Promise<void>
  /**
   * Bring back every bot a previous process left online that `owns` accepts, resuming its stored
   * sessions so Discord replays the events it missed. Each starts a fresh 24-hour idle timer.
   * Failures are logged.
   */
  readonly resume: (owns?: (botId: string) => boolean) => Promise<void>
  /**
   * Disconnect every bot without ending its sessions, so the next process can resume them.
   * Resolves once every pending storage write has settled.
   */
  readonly close: () => Promise<void>
}

/** Discord's answer to `GET /gateway/bot`. */
interface GatewayBotBody {
  readonly url: string
  /** The recommended shard count. */
  readonly shards: number
  readonly session_start_limit: {
    readonly total: number
    readonly remaining: number
    readonly reset_after: number
    readonly max_concurrency: number
  }
}

interface GatewayBot {
  readonly url: string
  readonly shards: number
  readonly limit: SessionStartLimit
}

interface Runtime {
  readonly token: string
  /** Sessions a previous process stored, by shard ID, for the shards to resume. */
  readonly saved: ReadonlyMap<number, ShardSession>
  shards: ReadonlyArray<Shard>
  cancelIdle: () => void
  /** Cancels a pending retry of `GET /gateway/bot`. */
  cancelRetry: () => void
}

const reason = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

/** The bots this process keeps online, one runtime per bot, each running all its shards. */
export const createBotRuntimes = ({
  vault,
  clock,
  log,
  discordFetch = fetch,
  onDispatch,
}: BotRuntimesOptions): BotRuntimes => {
  const running = new Map<string, Runtime>()
  /** Tokens Discord rejected for good, by bot. Retrying them only spends Identifies. */
  const rejected = new Map<string, string>()
  /**
   * Each bot's storage writes, chained so they land in order: a replaced token never overwrites
   * its successor, and an ended session never outlives the next one.
   */
  const writes = new Map<string, Promise<void>>()
  /** Sessions waiting in their bot's write chain, by bot and shard. Only the newest is written. */
  const unsaved = new Map<string, ShardSession | undefined>()
  /** Failed session writes waiting to retry, by bot and shard. A newer write replaces one. */
  const retries = new Map<
    string,
    {
      readonly botId: string
      readonly shardId: number
      readonly session: ShardSession | undefined
      readonly cancel: () => void
    }
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
  const saveSession = (botId: string, shardId: number, session: ShardSession | undefined) => {
    const key = `${botId}:${shardId}`
    retries.get(key)?.cancel()
    retries.delete(key)
    const queued = unsaved.has(key)
    unsaved.set(key, session)
    if (queued) return
    let latest: ShardSession | undefined
    write(botId, () => {
      latest = unsaved.get(key)
      unsaved.delete(key)
      return latest === undefined
        ? vault.clearSession(botId, shardId)
        : vault.storeSession(botId, shardId, latest)
    }).catch((cause) => {
      log(`Saving bot ${botId}'s shard ${shardId} Gateway session failed: ${reason(cause)}`)
      // A newer session is already queued behind this one.
      if (unsaved.has(key)) return
      // Retry until storage recovers. A lost store can leave an online bot unresumable, since
      // READY may be its last dispatch; a lost clear lets the next process revive an idle bot.
      const cancel = clock.schedule(() => saveSession(botId, shardId, latest), RETRY_MS)
      retries.set(key, { botId, shardId, session: latest, cancel })
    })
  }

  const stop = (botId: string, runtime: Runtime) => {
    if (running.get(botId) !== runtime) return
    running.delete(botId)
    runtime.cancelIdle()
    runtime.cancelRetry()
    for (const shard of runtime.shards) shard.stop()
    // Stopped before its shards started, so its stored sessions must end here.
    if (runtime.shards.length === 0) {
      for (const shardId of runtime.saved.keys()) saveSession(botId, shardId, undefined)
    }
  }

  const keepAlive = (botId: string, runtime: Runtime) => {
    runtime.cancelIdle()
    runtime.cancelIdle = clock.schedule(() => {
      log(`Bot ${botId} went offline after 24 hours without an agent call.`)
      stop(botId, runtime)
    }, IDLE_TIMEOUT_MS)
  }

  const add = (botId: string, token: string, saved: ReadonlyMap<number, ShardSession>) => {
    const runtime: Runtime = {
      token,
      saved,
      shards: [],
      cancelIdle: () => {},
      cancelRetry: () => {},
    }
    running.set(botId, runtime)
    keepAlive(botId, runtime)
    return runtime
  }

  /** Discord's sharding advice for a bot, or `undefined` when it rejects the token. */
  const gatewayBot = async (token: string): Promise<GatewayBot | undefined> => {
    const response = await discordFetch(`${DISCORD_API_URL}/gateway/bot`, {
      headers: { authorization: `Bot ${token}` },
    })
    if (response.status === UNAUTHORIZED) return undefined
    if (!response.ok) throw new Error(`Discord answered GET /gateway/bot with ${response.status}`)
    const { url, shards, session_start_limit: limit } = (await response.json()) as GatewayBotBody
    return {
      url,
      shards,
      limit: {
        total: limit.total,
        remaining: limit.remaining,
        resetAfter: limit.reset_after,
        maxConcurrency: limit.max_concurrency,
      },
    }
  }

  const startShards = (botId: string, runtime: Runtime, gateway: GatewayBot) => {
    // Resumed sessions keep the count they identified with; the rest follow Discord's advice.
    const [resumed] = runtime.saved.values()
    const shardCount = resumed?.shardCount ?? gateway.shards
    const identifies = createIdentifyGate(clock, gateway.limit)
    runtime.shards = Array.from({ length: shardCount }, (_, shardId) => {
      const session = runtime.saved.get(shardId)
      return startShard({
        token: runtime.token,
        gatewayUrl: gateway.url,
        clock,
        shardId,
        shardCount,
        identifies,
        ...(session && { session }),
        onSession: (next) => saveSession(botId, shardId, next),
        onReady: () => log(`Bot ${botId} is online on shard ${shardId} of ${shardCount}.`),
        onDispatch: (event, data) => onDispatch?.(botId, event, data),
        onIdentifyBudgetSpent: (waitMs) =>
          log(
            `Bot ${botId}'s shard ${shardId} is offline: the bot spent its Gateway Identify budget. Reconnecting in ${Math.ceil(waitMs / 60_000)} minutes.`,
          ),
        onFatal: (code) => {
          if (RESHARD_CLOSE_CODES.has(code)) {
            log(
              `Bot ${botId} is offline: Discord closed shard ${shardId} with code ${code}, so its shard count is out of date. The next agent call brings it back with Discord's recommended count.`,
            )
          } else {
            log(
              `Bot ${botId} is offline: Discord closed its Gateway session with code ${code}. It stays offline until its token changes or the server restarts.`,
            )
            rejected.set(botId, runtime.token)
          }
          stop(botId, runtime)
        },
      })
    })
  }

  const connect = (botId: string, runtime: Runtime) =>
    gatewayBot(runtime.token).then(
      (gateway) => {
        // Idle, closed, or replaced by a new token while asking.
        if (running.get(botId) !== runtime) return
        if (gateway !== undefined) return startShards(botId, runtime, gateway)
        log(
          `Bot ${botId} is offline: Discord rejected its token. It stays offline until it changes.`,
        )
        rejected.set(botId, runtime.token)
        stop(botId, runtime)
      },
      (cause) => {
        if (running.get(botId) !== runtime) return
        log(
          `Bot ${botId} is offline: asking Discord how to shard it failed: ${reason(cause)}. Retrying in a minute.`,
        )
        runtime.cancelRetry = clock.schedule(() => connect(botId, runtime), RETRY_MS)
      },
    )

  return {
    use: (botId, token) => {
      if (rejected.get(botId) === token) return Promise.resolve()
      const current = running.get(botId)
      if (current?.token === token) {
        keepAlive(botId, current)
        return Promise.resolve()
      }
      // A reset token invalidates the old sessions, so start over with the new one.
      if (current !== undefined) stop(botId, current)
      const runtime = add(botId, token, new Map())
      return write(botId, () => vault.store(botId, token)).then(
        () => {
          // Idle, closed, or replaced by a new token while storing.
          if (running.get(botId) === runtime) void connect(botId, runtime)
        },
        (cause) => {
          log(`Bot ${botId} stays offline: ${reason(cause)}`)
          stop(botId, runtime)
        },
      )
    },
    resume: async (owns = () => true) => {
      const stored = await vault.loadSessions().catch((cause) => {
        log(`Could not resume bots from storage: ${reason(cause)}`)
        return []
      })
      const bots = new Map<string, { token: string; saved: Map<number, ShardSession> }>()
      for (const { botId, shardId, token, session } of stored) {
        const bot = bots.get(botId) ?? { token, saved: new Map() }
        bot.saved.set(shardId, session)
        bots.set(botId, bot)
      }
      for (const [botId, { token, saved }] of bots) {
        // Another bot host's, or an agent call brought it online first.
        if (!owns(botId) || running.has(botId)) continue
        void connect(botId, add(botId, token, saved))
      }
    },
    close: async () => {
      for (const [botId, runtime] of running) {
        running.delete(botId)
        runtime.cancelIdle()
        runtime.cancelRetry()
        for (const shard of runtime.shards) shard.suspend()
      }
      await Promise.all(writes.values())
      // One last try at failed writes, so the next process starts from the newest state.
      for (const { botId, shardId, session } of retries.values()) {
        saveSession(botId, shardId, session)
      }
      await Promise.all(writes.values())
      for (const { cancel } of retries.values()) cancel()
      retries.clear()
    },
  }
}
