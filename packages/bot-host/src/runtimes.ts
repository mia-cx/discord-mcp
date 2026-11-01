import type { BotRanAs, Storage, VoiceOptOutChange } from '@discord-mcp/storage'
import { shardOwner } from './assign.ts'
import type { Clock } from './clock.ts'
import { createConsent } from './consent.ts'
import {
  createIdentifyGate,
  IDENTIFY_INTERVAL_MS,
  type IdentifyGate,
  type SessionStartLimit,
} from './identify.ts'
import { createLeases } from './leases.ts'
import { type Presence, type Shard, type ShardSession, startShard } from './shard.ts'
import type { OnlineVaultBot, TokenVault } from './vault.ts'
import { type BotVoice, createVoice, JOIN_TIMEOUT_MS, type Voice } from './voice.ts'

export const IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1000
export const DISCORD_API_URL = 'https://discord.com/api/v10'
/** How often each host renews its leases and catches up with the bots in storage. */
export const RECONCILE_MS = 5_000
const RETRY_MS = 60_000
/** A failed claim on an Identify turn tries again this soon. */
const TURN_RETRY_MS = 1_000
/**
 * Each Identify turn lasts this much past Discord's five seconds, covering the round trip that
 * claims it and clock skew between hosts.
 */
const TURN_MARGIN_MS = 1_000
const TURN_MS = IDENTIFY_INTERVAL_MS + TURN_MARGIN_MS
const UNAUTHORIZED = 401
/** An invalid shard, or a bot that outgrew its shard count. A fresh count fixes both. */
const RESHARD_CLOSE_CODES = new Set([4010, 4011])
/** Discord refused the intents: invalid (4013), or privileged and not allowed (4014). */
const INTENT_CLOSE_CODES = new Set([4013, 4014])
/** `GUILDS` and `GUILD_VOICE_STATES`: voice joins need the bot's own voice state updates. */
const VOICE_INTENTS = (1 << 0) | (1 << 7)
/** Every bot listens for its voice state, plus whatever its workflows need. */
const intentsOf = (bot: OnlineVaultBot) => VOICE_INTENTS | bot.intents
/**
 * How long a server's shard stays on the host whose voice asked for it without the bot joining
 * there: long enough for a join to move the shard and connect.
 */
const PIN_MS = 2 * JOIN_TIMEOUT_MS
const PIN_LEASE = 'pin:'
/** Discord sends a server's events on shard (guild_id >> 22) % shard_count. */
const shardOfGuild = (guildId: string, shardCount: number) =>
  Number((BigInt(guildId) >> 22n) % BigInt(shardCount))
/**
 * A server's shard a voice asked for, and when it last asked. The shard is unknown until this
 * host knows the bot's shard count.
 */
interface Pin {
  shardId: number | undefined
  at: number
}

/** How long `GET /gateway/bot` may take before it counts as failed and is retried. */
const GATEWAY_BOT_TIMEOUT_MS = 15_000

const LIFECYCLE = 'lifecycle:'
const HOST_LEASE = 'host:'
const SHARD_LEASE = 'shard:'
const shardLease = (botId: string, shardId: number) => `${SHARD_LEASE}${botId}:${shardId}`
const botOfShardLease = (name: string) => name.slice(SHARD_LEASE.length, name.lastIndexOf(':'))
const REST_LEASE = 'bot:'
const restLease = (botId: string) => `${REST_LEASE}${botId}`

export interface BotRuntimesOptions {
  readonly vault: TokenVault
  /** The database the vault seals into, which bot hosts also coordinate through. */
  readonly storage: Storage
  readonly clock: Clock
  /** Operator-facing lifecycle messages and failures. Never receives a token. */
  readonly log: (message: string) => void
  /**
   * This host's name among the bot hosts sharing the database, such as its URL. Shards spread
   * across the names of live hosts; processes sharing a name take turns.
   */
  readonly self: string
  /** How many bot hosts share each bot's shards, and so its daily Identify budget. */
  readonly hostCount?: number
  /**
   * Reaches Discord's REST API for each bot's Gateway URL, shard count, and Identify limits, its
   * voice notices, and the answers to their buttons.
   */
  readonly discordFetch?: typeof fetch
  /**
   * Hears every dispatch from every shard this host runs, replayed ones included, except clicks
   * on Textile's own voice notice buttons.
   */
  readonly onDispatch?: (botId: string, event: string, data: unknown) => void
  /**
   * How long this host's leases last without renewal, `LEASE_TTL_MS` unless a test jumping the
   * clock by hours keeps them from lapsing.
   */
  readonly leaseTtlMs?: number
  /**
   * Whether this host's list makes it the bot's REST owner. It keeps such a bot's REST lease while
   * the bot is online, so the bot's schedules run here. Every bot, by default.
   */
  readonly owns?: (botId: string) => boolean
}

export interface BotRuntimes {
  /**
   * Record an agent call for a bot Discord has verified. The first call stores its token and
   * brings it online; each call keeps it online for another 24 hours. Resolves once recorded.
   * Failures are logged rather than thrown, so they never fail the agent's call.
   */
  readonly use: (botId: string, token: string) => Promise<void>
  /**
   * Claim the bot's REST traffic for this process. Resolves `false` while another process holds
   * it, so one bot never has two rate limiters.
   */
  readonly own: (botId: string) => Promise<boolean>
  /** Whether this process holds the bot's REST traffic now, and so may act for it unasked. */
  readonly serves: (botId: string) => boolean
  /**
   * Its enabled workflows changed: storage now holds `intents`, the union of theirs, or none.
   * Brings a held bot online from its stored token if it is offline; releasing it starts its
   * 24-hour idle timer over. Every host's shards of the bot take up the change. Failures are
   * logged rather than thrown.
   */
  readonly hold: (botId: string, intents: number | undefined) => Promise<void>
  /** Whether enabled workflows hold this bot, online or not, as `hold` last heard here. */
  readonly holds: (botId: string) => boolean
  /**
   * Set an online bot's presence on every shard, on every host. Rejects when the bot is offline.
   */
  readonly updatePresence: (botId: string, presence: Presence) => Promise<void>
  /** The token an online bot runs with, wherever its shards run, as of this host's last pass. */
  readonly tokenOf: (botId: string) => string | undefined
  /**
   * A bot's voice, run on this host; `undefined` once this host is closing. Joins wait for the
   * bot's shard for that server. While the bot is in a server's voice channel, or joining one,
   * that server's shard runs on this host.
   */
  readonly voice: (botId: string) => BotVoice | undefined
  /**
   * Disconnect every shard without ending its session and give up this host's leases, so other
   * hosts, or the next process, resume them. Resolves once every session write has settled and
   * opt-outs are no longer followed; a token or online-state write still waiting on Discord is
   * left to the next agent call.
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

/** A shard this host runs, under its lease. */
interface Running {
  readonly botId: string
  readonly shardId: number
  readonly token: string
  readonly shardCount: number
  readonly shard: Shard
  /** The intents and presence storage last gave the shard. */
  intents: number
  presence: string | null
  /** Its session has started, with READY or RESUMED, and not dropped since. */
  ready: boolean
  /**
   * Discord closed the shard for good, with `rejectedCode` when no new shard count can help, and
   * what of the bot's state it refused (`ranAs`): a refused token is refused however the bot runs.
   */
  fatal?: { readonly rejectedCode?: number; readonly ranAs: BotRanAs }
}

const reason = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

/**
 * Keeps bots online across every bot host sharing the database. Each host runs the shards that
 * rendezvous hashing assigns it among the live hosts, each under a lease, so a shard runs on one
 * host at a time and moves, resuming its stored session, when hosts join or leave. A bot's online
 * state lives in storage, so any host resumes its shards without asking Discord first. Starts at
 * once.
 */
export const createBotRuntimes = ({
  vault,
  storage,
  clock,
  log,
  self,
  hostCount = 1,
  discordFetch = fetch,
  onDispatch,
  leaseTtlMs,
  owns = () => true,
}: BotRuntimesOptions): BotRuntimes => {
  const hostLease = `${HOST_LEASE}${self}`
  /** Shards this host runs, by lease name. */
  const running = new Map<string, Running>()
  /** Each bot's Identify gate on this host, for the token its shards run with. */
  const gates = new Map<
    string,
    { readonly token: string; readonly gate: Promise<IdentifyGate>; readonly cancel: () => void }
  >()
  /** Pending retries of bringing a bot online, by bot. */
  const onlineRetries = new Map<string, () => void>()
  /** The online bots as of the last pass, by bot. */
  let known = new Map<string, OnlineVaultBot>()
  /**
   * Bots' voices on this host, with the shards they need here: by server, the shard and when the
   * voice last asked for it.
   */
  const voices = new Map<string, { readonly voice: Voice; readonly pins: Map<string, Pin> }>()
  /** Bots `hold` last said enabled workflows hold, as this host's workflow host keeps them. */
  const holding = new Set<string>()
  let closed = false

  const optOutChanged = ({ scope, userId, optedOut }: VoiceOptOutChange) => {
    if ('everywhere' in scope) {
      for (const { voice } of voices.values()) voice.optOutChanged(undefined, userId, optedOut)
    } else {
      voices.get(scope.botId)?.voice.optOutChanged(scope.guildId, userId, optedOut)
    }
  }
  // A click applies to this host's voices as soon as it is stored, whichever host's shard heard
  // it. Every bot host, this one included, hears it again from Postgres. While that feed isn't
  // listening, an opt-out made elsewhere would go unheard, so nobody is relayed until it is back
  // and everyone is checked.
  const consent = createConsent({
    storage,
    discordFetch,
    owns: (botId) => own(botId),
    apiUrl: DISCORD_API_URL,
    log,
    changed: optOutChanged,
  })
  let feedLive = false
  const recheckAll = () => {
    for (const { voice } of voices.values()) voice.recheck()
  }
  const watching = storage
    .watchVoiceOptOuts({
      changed: optOutChanged,
      live: () => {
        feedLive = true
        recheckAll()
      },
      lost: (error) => {
        log(
          `Lost the voice opt-out feed from Postgres; relaying nobody until it is back: ${error.message}`,
        )
        feedLive = false
        recheckAll()
      },
    })
    .catch((cause) => {
      log(`Could not follow voice opt-outs from other bot hosts: ${reason(cause)}`)
      return async () => {}
    })

  const leases = createLeases(
    storage,
    clock,
    (name) => {
      if (name.startsWith(REST_LEASE)) return dropVoice(name.slice(REST_LEASE.length))
      forgetRetry(name)
      const lost = running.get(name)
      if (lost === undefined) return
      running.delete(name)
      halt(lost)
      log(
        `Bot ${lost.botId}'s shard ${lost.shardId} stopped on this host: it could not renew its lease in time.`,
      )
    },
    leaseTtlMs,
  )

  /**
   * Stop a shard running here, ending it for good with `end`. Otherwise its session stays
   * resumable, unless this host's voice has a channel on it: resumed, that session would keep the
   * bot in a channel nothing relays, so it identifies afresh.
   */
  const halt = (run: Running, end = false) => {
    const voice = voices.get(run.botId)?.voice
    if (end) run.shard.stop()
    else run.shard.suspend(voice?.inChannel(run.shardId) ?? false)
    // Its voice joins wait for the shard wherever it comes back.
    voice?.dropped(run.shardId)
  }

  /** Stop a bot's voice here, since another host may serve the bot now. */
  const dropVoice = (botId: string) => {
    const entry = voices.get(botId)
    if (entry === undefined) return
    entry.voice.close()
    // Shards that could not send their leave stop here, ending their sessions.
    for (const [name, run] of running) {
      if (run.botId !== botId || !entry.voice.inChannel(run.shardId)) continue
      running.delete(name)
      halt(run)
    }
    voices.delete(botId)
    log(`Bot ${botId}'s voice stopped on this host: it could not renew its REST lease in time.`)
  }

  /**
   * Storage writes, chained so they land in order: by bot, its sessions, so an ended session
   * never outlives the next one; and by `lifecycle`, its token and online state, so a replaced
   * token never overwrites its successor.
   */
  const writes = new Map<string, Promise<void>>()
  /**
   * Sessions waiting in their bot's write chain, by bot and shard, each with the hold of the
   * shard's lease it was made under. Only the newest is written.
   */
  const unsaved = new Map<
    string,
    { readonly session: ShardSession | undefined; readonly tenure: object | undefined }
  >()
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
  const forgetRetry = (key: string) => {
    retries.get(key)?.cancel()
    retries.delete(key)
  }
  /** Give up a shard's lease, and the session write waiting to retry under it. */
  const giveUp = (name: string) => {
    forgetRetry(name)
    return leases.release(name)
  }
  /** Agent calls waiting in their bot's write chain, by bot. Only the newest token is recorded. */
  const unrecorded = new Map<string, string>()

  /** Run `task` after every write queued under `chain` before it. */
  const write = (chain: string, task: () => Promise<void>) => {
    const done = (writes.get(chain) ?? Promise.resolve()).then(task)
    writes.set(
      chain,
      done.catch(() => {}),
    )
    return done
  }
  /**
   * A bot's token and online-state writes: their own chain, since they wait on Discord, and a
   * shard handed over waits only for its sessions.
   */
  const lifecycle = (botId: string) => `${LIFECYCLE}${botId}`
  const isLifecycle = (chain: string) => chain.startsWith(LIFECYCLE)
  /** Session writes queued so far. A token or online-state write may wait on Discord. */
  const sessionWrites = () =>
    Promise.all([...writes].flatMap(([chain, done]) => (isLifecycle(chain) ? [] : [done])))

  // A crash loses the writes still queued or waiting to retry, so the next host finds an older
  // session or none. It may replay events twice or identify afresh. Writes land only while this
  // host holds the shard's lease, so a host that lost a shard never overwrites its new owner's;
  // and only within the hold they were made under, since once this host takes the shard back, a
  // session from before is older than the one its owner meanwhile saved.
  const saveSession = (botId: string, shardId: number, session: ShardSession | undefined) => {
    const key = shardLease(botId, shardId)
    forgetRetry(key)
    const queued = unsaved.has(key)
    unsaved.set(key, { session, tenure: leases.tenure(key) })
    if (queued) return
    let latest: ShardSession | undefined
    let tenure: object | undefined
    /**
     * Whether the session may land under the hold this host has now. Once the hold lapses here the
     * fence decides. A newer hold means the shard came back, and a resumable session from before
     * may be older than its owner's since; ending one never is.
     */
    const mayLand = () => {
      const now = leases.tenure(key)
      const resumable = latest !== undefined && latest.stale !== true
      return !resumable || now === undefined || now === tenure
    }
    write(botId, async () => {
      const next = unsaved.get(key)
      unsaved.delete(key)
      latest = next?.session
      tenure = next?.tenure
      if (!mayLand()) return
      const fence = { lease: key, holder: leases.holder }
      return latest === undefined
        ? vault.clearSession(botId, shardId, fence)
        : vault.storeSession(botId, shardId, latest, fence)
    }).catch((cause) => {
      log(`Saving bot ${botId}'s shard ${shardId} Gateway session failed: ${reason(cause)}`)
      // A newer session is already queued behind this one. Without the lease it can never land.
      if (unsaved.has(key) || !leases.holds(key) || !mayLand()) return
      // Retry until storage recovers. A lost store can leave an online shard unresumable, since
      // READY may be its last dispatch.
      const cancel = clock.schedule(() => saveSession(botId, shardId, latest), RETRY_MS)
      retries.set(key, { botId, shardId, session: latest, cancel })
    })
  }

  /**
   * Wait for a bot's session writes, after one more try at any that failed, so whoever runs its
   * shards next starts from the newest sessions.
   */
  const flushSessions = async (botId: string) => {
    await writes.get(botId)
    for (const retry of retries.values()) {
      if (retry.botId === botId) saveSession(botId, retry.shardId, retry.session)
    }
    await writes.get(botId)
  }

  /** Discord's sharding advice for a bot, or `undefined` when it rejects the token. */
  const gatewayBot = async (token: string): Promise<GatewayBot | undefined> => {
    const response = await discordFetch(`${DISCORD_API_URL}/gateway/bot`, {
      headers: { authorization: `Bot ${token}` },
      signal: AbortSignal.timeout(GATEWAY_BOT_TIMEOUT_MS),
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

  const reject = (botId: string, token: string) => {
    log(`Bot ${botId} is offline: Discord rejected its token. It stays offline until it changes.`)
    return vault.setOffline(botId, token, { rejectedCode: UNAUTHORIZED })
  }

  // Each host takes its share of the budget, so hosts together still leave half of it.
  const gateFor = (botId: string, limit: SessionStartLimit) =>
    createIdentifyGate(
      clock,
      {
        ...limit,
        total: Math.floor(limit.total / hostCount),
        remaining: Math.floor(limit.remaining / hostCount),
      },
      {
        ms: TURN_MS,
        claim: async (bucket) => {
          const asked = clock.now()
          const waitMs = await leases
            .take(`identify:${botId}:${bucket}`, TURN_MS)
            .catch((cause: unknown) => {
              log(`Bot ${botId} could not claim a turn to identify: ${reason(cause)}`)
              return TURN_RETRY_MS
            })
          if (waitMs > 0) return waitMs
          // The Identify goes out now, so a turn whose claim answered late is too short: skip it.
          const late = clock.now() - asked
          return late > TURN_MARGIN_MS ? Math.max(TURN_MS - late, 1) : 0
        },
      },
    )

  /** The bot's Identify gate, once Discord says what its limits are. Asks only when needed. */
  const identifies = (botId: string, token: string) => {
    const known = gates.get(botId)
    if (known?.token === token) return known.gate
    known?.cancel()
    let cancelled = false
    let cancelRetry = () => {}
    const gate = new Promise<IdentifyGate>((resolve) => {
      const ask = () =>
        gatewayBot(token).then(
          (gateway) => {
            if (cancelled) return
            if (gateway !== undefined) return resolve(gateFor(botId, gateway.limit))
            // Its shards stop on the next pass, once storage says the bot is offline.
            reject(botId, token).catch((cause) =>
              log(`Taking bot ${botId} offline failed: ${reason(cause)}`),
            )
          },
          (cause) => {
            if (cancelled) return
            log(
              `Bot ${botId} cannot identify yet: asking Discord for its Identify limits failed: ${reason(cause)}. Retrying in a minute.`,
            )
            cancelRetry = clock.schedule(ask, RETRY_MS)
          },
        )
      void ask()
    })
    gates.set(botId, {
      token,
      gate,
      cancel: () => {
        cancelled = true
        cancelRetry()
      },
    })
    return gate
  }

  const start = (name: string, bot: OnlineVaultBot, shardId: number) => {
    const { botId, token, shardCount } = bot
    // The shard identifies afresh rather than resume a session with other intents, or a stale one.
    const session = bot.sessions.get(shardId)
    const shard = startShard({
      token,
      gatewayUrl: bot.gatewayUrl,
      clock,
      shardId,
      shardCount,
      intents: intentsOf(bot),
      identifies: () => identifies(botId, token),
      ...(session && { session }),
      onSession: (next) => saveSession(botId, shardId, next),
      onReady: () => {
        run.ready = true
        log(`Bot ${botId} is online on shard ${shardId} of ${shardCount}.`)
      },
      onDispatch: (event, data) => {
        voices.get(botId)?.voice.dispatch(shardId, event, data)
        if (event === 'INTERACTION_CREATE' && consent.answer(botId, data)) return
        onDispatch?.(botId, event, data)
      },
      onDrop: () => {
        run.ready = false
        voices.get(botId)?.voice.dropped(shardId)
      },
      onIdentifyBudgetSpent: (waitMs) =>
        log(
          `Bot ${botId}'s shard ${shardId} is offline: the bot spent its Gateway Identify budget. Reconnecting in ${Math.ceil(waitMs / 60_000)} minutes.`,
        ),
      onFatal: (code) => {
        const reshard = RESHARD_CLOSE_CODES.has(code)
        log(
          reshard
            ? `Bot ${botId} is offline: Discord closed shard ${shardId} with code ${code}, so its shard count is out of date. The next agent call brings it back with Discord's recommended count.`
            : INTENT_CLOSE_CODES.has(code)
              ? `Bot ${botId} is offline: Discord refused its Gateway intents with code ${code}. It stays offline until its workflows or its token change.`
              : `Bot ${botId} is offline: Discord closed its Gateway session with code ${code}. It stays offline until its token changes.`,
        )
        // The next pass takes the bot offline, and so stops its shards on every host, unless by
        // then it runs with another shard count or other intents than Discord refused. Recorded
        // now: a workflow change may update the run before that pass.
        run.fatal = reshard
          ? { ranAs: { shardCount: run.shardCount } }
          : {
              rejectedCode: code,
              ranAs: INTENT_CLOSE_CODES.has(code) ? { intents: run.intents } : {},
            }
        void tick()
      },
    })
    const run: Running = {
      botId,
      shardId,
      token,
      shardCount,
      shard,
      ...gatewayOf(bot),
      ready: false,
    }
    if (bot.presence !== null) shard.updatePresence(JSON.parse(bot.presence))
    running.set(name, run)
  }

  const gatewayOf = (bot: OnlineVaultBot) => ({ intents: bot.intents, presence: bot.presence })

  /** Give a running shard the intents and presence storage has for its bot. */
  const update = (run: Running, bot: OnlineVaultBot) => {
    if (run.intents !== bot.intents) run.shard.setIntents(intentsOf(bot))
    if (run.presence !== bot.presence && bot.presence !== null) {
      run.shard.updatePresence(JSON.parse(bot.presence))
    }
    Object.assign(run, gatewayOf(bot))
  }

  /** Stop running a shard here, once its last session write lands, and give up its lease. */
  const leave = async (name: string, run: Running, end: boolean) => {
    running.delete(name)
    halt(run, end)
    await flushSessions(run.botId)
    await giveUp(name)
  }

  /**
   * The bots online in storage, after taking offline those a shard here was closed for good and
   * those idle for 24 hours without workflows to hold them.
   */
  const onlineBots = async () => {
    for (const run of running.values()) {
      if (run.fatal === undefined) continue
      await vault.setOffline(run.botId, run.token, run.fatal)
      // Every shard on this token ends with it, at once: should this pass fail, the bot may come
      // back online with the same token before a shard closed later could take it offline again.
      const ended = [...running].filter(
        ([, other]) => other.botId === run.botId && other.token === run.token,
      )
      await Promise.all(ended.map(([name, other]) => leave(name, other, true)))
    }
    const now = clock.date()
    const online = new Map<string, OnlineVaultBot>()
    for (const bot of await vault.loadOnline()) {
      if (bot.until > now || bot.held) {
        online.set(bot.botId, bot)
      } else if (await storage.setBotOffline(bot.botId, { idleAt: now })) {
        log(`Bot ${bot.botId} went offline after 24 hours without an agent call.`)
      }
    }
    return online
  }

  /** Pin leases this host holds for its voices. */
  const pinned = new Set<string>()

  /**
   * Tell a voice which of its bot's shards here have a live session, as a resume would, so joins
   * waiting on them go ahead. A resume leaves the voice's channels as they are.
   */
  const nudge = (botId: string, voice: Voice) => {
    for (const run of running.values()) {
      if (run.botId === botId && run.ready) voice.dispatch(run.shardId, 'RESUMED', {})
    }
  }

  /**
   * Close the voices of bots gone offline, and pin the shards the rest need to this host. Resolves
   * the host each pinned shard must run on, by shard lease.
   */
  const pinVoices = async (
    online: ReadonlyMap<string, OnlineVaultBot>,
    previous: ReadonlyMap<string, OnlineVaultBot>,
  ) => {
    const now = clock.now()
    const wanted = new Set<string>()
    for (const [botId, { voice, pins }] of voices) {
      // A bot that went offline leaves its voice channels; one not yet online keeps its joins.
      if (!online.has(botId)) {
        if (!previous.has(botId)) continue
        voice.close()
        voices.delete(botId)
        continue
      }
      for (const shardId of keepPins(botId, voice, pins, online, now)) {
        wanted.add(`${PIN_LEASE}${botId}:${shardId}:${self}`)
      }
    }
    for (const name of wanted) {
      if (!leases.holds(name) && (await leases.claim(name))) pinned.add(name)
    }
    for (const name of pinned) {
      if (wanted.has(name)) continue
      pinned.delete(name)
      await leases.release(name)
    }
    return livePins()
  }

  /**
   * Drop the pins a voice no longer needs, and resolve those asked for before this host knew the
   * bot's shard count. Returns the shards the rest pin.
   */
  const keepPins = (
    botId: string,
    voice: Voice,
    pins: Map<string, Pin>,
    online: ReadonlyMap<string, OnlineVaultBot>,
    now: number,
  ) => {
    const shardCount = online.get(botId)?.shardCount ?? 1
    let resolved = false
    const kept: number[] = []
    for (const [guildId, pin] of pins) {
      if (pin.shardId === undefined) {
        pin.shardId = shardOfGuild(guildId, shardCount)
        resolved = true
      }
      if (!voice.joined(guildId) && now - pin.at >= PIN_MS) pins.delete(guildId)
      else kept.push(pin.shardId)
    }
    // Its waiting joins look again now that their servers' shards are known.
    if (resolved) nudge(botId, voice)
    return kept
  }

  /** The host each pinned shard must run on, by shard lease. */
  const livePins = async () => {
    const hosts = new Map<string, string>()
    for (const name of await leases.live(PIN_LEASE)) {
      // Host names are URLs, so they hold colons too.
      const [botId = '', shardId = '', ...host] = name.slice(PIN_LEASE.length).split(':')
      const key = shardLease(botId, Number(shardId))
      const pinHost = host.join(':')
      const current = hosts.get(key)
      if (current === undefined || pinHost < current) hosts.set(key, pinHost)
    }
    return hosts
  }

  /** Claim and start the assigned shards no host holds. */
  const takeOver = async (
    assigned: ReadonlyMap<string, { bot: OnlineVaultBot; shardId: number }>,
  ) => {
    const claimed = (
      await Promise.all(
        [...assigned].map(async ([name, { bot, shardId }]) =>
          !running.has(name) && (await leases.claim(name))
            ? [{ name, botId: bot.botId, shardId }]
            : [],
        ),
      )
    ).flat()
    if (claimed.length === 0) return
    // Read sessions again: a host that just handed a shard over saved it before releasing, and
    // this host may be saving one it stopped. Only those bots': another bot's write may be slow.
    await Promise.all([...new Set(claimed.map(({ botId }) => botId))].map(flushSessions))
    const fresh = new Map((await vault.loadOnline()).map((bot) => [bot.botId, bot]))
    for (const { name, botId, shardId } of claimed) {
      const bot = fresh.get(botId)
      // The read may have outlasted the lease.
      const gone = closed || !leases.holds(name)
      if (gone || bot === undefined || bot.shardCount <= shardId) {
        await giveUp(name)
        continue
      }
      // Its token may be newer than the pass's read; routes and voice use the shards' token.
      known.set(botId, bot)
      start(name, bot, shardId)
    }
  }

  /** Shards here assigned to this host, by lease: rendezvous over the live hosts, or a pin. */
  const assignment = (
    online: ReadonlyMap<string, OnlineVaultBot>,
    hosts: ReadonlyArray<string>,
    pins: ReadonlyMap<string, string>,
  ) => {
    const assigned = new Map<string, { bot: OnlineVaultBot; shardId: number }>()
    for (const bot of online.values()) {
      for (let shardId = 0; shardId < bot.shardCount; shardId += 1) {
        const name = shardLease(bot.botId, shardId)
        // A server's shard runs where the bot's voice in it does.
        const pin = pins.get(name)
        const owner = pin !== undefined && hosts.includes(pin) ? pin : undefined
        if ((owner ?? shardOwner(hosts, bot.botId, shardId)) !== self) continue
        assigned.set(name, { bot, shardId })
      }
    }
    return assigned
  }

  /**
   * Leases this host holds for nothing, and those it should hold: a shard claimed in a pass that
   * failed before starting it gives its lease back, and the REST owner of an online bot keeps the
   * bot's lease, so its schedules run here without an agent call.
   */
  const tidyLeases = async (online: ReadonlyMap<string, OnlineVaultBot>) => {
    for (const name of leases.names()) {
      if (!name.startsWith(SHARD_LEASE) || running.has(name)) continue
      // A shard stopped between passes may still be saving the session its next host starts from.
      await flushSessions(botOfShardLease(name))
      await giveUp(name)
    }
    for (const botId of online.keys()) {
      if (owns(botId) && !leases.holds(restLease(botId))) await leases.claim(restLease(botId))
    }
  }

  /** Renew this host's leases and run exactly the shards assigned to it among the live hosts. */
  const reconcile = async () => {
    await leases.renew()
    const member = leases.holds(hostLease) || (await leases.claim(hostLease))
    const hosts = (await leases.live(HOST_LEASE)).map((name) => name.slice(HOST_LEASE.length))
    // An agent's voice socket keeps its bot online.
    for (const [botId, { voice }] of voices) {
      if (voice.streaming()) await storage.keepBotOnline(botId, clock.date() + IDLE_TIMEOUT_MS)
    }
    const online = await onlineBots()
    const previous = known
    known = online
    await tidyLeases(online)
    const pins = await pinVoices(online, previous)
    const assigned = member ? assignment(online, hosts, pins) : new Map()
    await Promise.all(
      [...running].flatMap(([name, run]) => {
        const bot = online.get(run.botId)
        const current = bot?.token === run.token && bot.shardCount === run.shardCount
        if (current && assigned.has(name)) {
          update(run, bot)
          return []
        }
        // Offline, a new token, or a new shard count end the session; a move hands it over.
        return [leave(name, run, !current)]
      }),
    )
    await takeOver(assigned)
    for (const [botId, { cancel }] of gates) {
      if ([...running.values()].some((run) => run.botId === botId)) continue
      cancel()
      gates.delete(botId)
    }
  }

  let ticking: Promise<void> | undefined
  let queued: Promise<void> | undefined
  /**
   * Reconcile now, or again right after a pass already under way. Resolves once a pass that
   * started after the call has finished.
   */
  const tick = (): Promise<void> => {
    if (closed) return Promise.resolve()
    if (ticking !== undefined) {
      queued ??= ticking.then(() => {
        queued = undefined
        return tick()
      })
      return queued
    }
    ticking = reconcile()
      .catch((cause) => log(`Catching up with the bots in storage failed: ${reason(cause)}`))
      .finally(() => {
        ticking = undefined
      })
    return ticking
  }
  let cancelLoop = () => {}
  const loop = () => {
    cancelLoop = clock.schedule(() => {
      void tick()
      loop()
    }, RECONCILE_MS)
  }
  void tick()
  loop()

  /** Ask Discord how to shard the bot, then bring it online on every host. */
  const bringOnline = async (botId: string, token: string) => {
    let gateway: GatewayBot | undefined
    try {
      gateway = await gatewayBot(token)
    } catch (cause) {
      if (closed) return
      log(
        `Bot ${botId} is offline: asking Discord how to shard it failed: ${reason(cause)}. Retrying in a minute.`,
      )
      onlineRetries.set(
        botId,
        clock.schedule(() => {
          onlineRetries.delete(botId)
          void use(botId, token)
        }, RETRY_MS),
      )
      return
    }
    // Closed while Discord answered: another host may already have the bot online, and bringing
    // it online again would end the sessions it saved.
    if (closed) return
    if (gateway === undefined) return void (await reject(botId, token))
    // Another host may have brought the bot online meanwhile, maybe with a newer token.
    const started = await vault.setOnline(botId, token, {
      shardCount: gateway.shards,
      gatewayUrl: gateway.url,
      until: clock.date() + IDLE_TIMEOUT_MS,
    })
    if (!started) return
    // This host already knows the limits, should any of its shards identify.
    gates.get(botId)?.cancel()
    gates.set(botId, {
      token,
      gate: Promise.resolve(gateFor(botId, gateway.limit)),
      cancel: () => {},
    })
  }

  const use = async (botId: string, token: string): Promise<void> => {
    if (closed) return
    onlineRetries.get(botId)?.()
    onlineRetries.delete(botId)
    const queued = unrecorded.has(botId)
    unrecorded.set(botId, token)
    if (queued) return writes.get(lifecycle(botId))
    await record(botId, token)
    // A bot this host doesn't know online yet may have just come online: start its shards here,
    // and make its voice available, without waiting for the next pass. Outside the bot's write
    // chain, which the pass waits on.
    if (!known.has(botId)) await tick()
  }

  const record = (botId: string, token: string) =>
    write(lifecycle(botId), async () => {
      const latest = unrecorded.get(botId) ?? token
      unrecorded.delete(botId)
      // Queued behind work that outlasted close: another host serves the bot now.
      if (closed) return
      const stored = await vault.load(botId)
      if (stored?.token === latest) {
        // Discord refused it on the Gateway; a new token, or for intents new workflows, bring the
        // bot back.
        if (stored.rejectedCode !== null) return
        if (await storage.keepBotOnline(botId, clock.date() + IDLE_TIMEOUT_MS)) return
      } else {
        // A reset token invalidates the old sessions, so start over with the new one.
        await vault.store(botId, latest)
      }
      await bringOnline(botId, latest)
    }).catch((cause) => log(`Bot ${botId} stays offline: ${reason(cause)}`))

  const own = async (botId: string) =>
    !closed && (leases.holds(restLease(botId)) || leases.claim(restLease(botId)))

  return {
    use,
    own,
    serves: (botId) => !closed && leases.holds(restLease(botId)),
    hold: async (botId, intents) => {
      if (closed) return
      if (intents === undefined) holding.delete(botId)
      else holding.add(botId)
      await write(lifecycle(botId), async () => {
        if (closed) return
        // Storage reads the hold and its intents from the enabled workflows; releasing starts the
        // idle timer over.
        if (intents === undefined)
          await storage.keepBotOnline(botId, clock.date() + IDLE_TIMEOUT_MS)
        const stored = await vault.load(botId)
        if (stored === undefined) return log(`Bot ${botId} stays offline: it has no stored token.`)
        // Discord refused the intents the bot had; its workflows just changed, so try again.
        const retry = stored.rejectedCode !== null && INTENT_CLOSE_CODES.has(stored.rejectedCode)
        if (retry) await vault.store(botId, stored.token)
        if (intents === undefined || (stored.rejectedCode !== null && !retry)) return
        if (stored.online === undefined || retry) await bringOnline(botId, stored.token)
      }).catch((cause) => log(`Bot ${botId} stays offline: ${reason(cause)}`))
      // This host's shards take up new intents before this resolves; other hosts' on their next
      // pass.
      await tick()
    },
    updatePresence: async (botId, presence) => {
      const json = JSON.stringify(presence)
      if (!(await storage.setBotPresence(botId, json))) throw new Error(`Bot ${botId} is offline.`)
      // Other hosts set it on their next pass.
      for (const run of running.values()) {
        if (run.botId !== botId) continue
        run.shard.updatePresence(presence)
        run.presence = json
      }
    },
    tokenOf: (botId) => known.get(botId)?.token,
    voice: (botId) => {
      if (closed) return undefined
      const existing = voices.get(botId)
      if (existing !== undefined) return existing.voice
      const pins = new Map<string, Pin>()
      const voice = createVoice({
        botId,
        shardOf: (guildId) => {
          const shardCount = known.get(botId)?.shardCount
          const shardId = shardCount === undefined ? undefined : shardOfGuild(guildId, shardCount)
          const fresh = !pins.has(guildId)
          pins.set(guildId, { shardId, at: clock.now() })
          // Bring the server's shard here now, rather than on the next pass.
          if (fresh) void tick()
          return shardId
        },
        send: (shardId, payload) =>
          running.get(shardLease(botId, shardId))?.shard.send(payload) ?? false,
        consent: {
          notice: (channelId) => {
            const token = known.get(botId)?.token
            return token === undefined
              ? Promise.resolve('The bot is offline.')
              : consent.notice(botId, token, channelId)
          },
          // Without the feed, everyone counts as opted out.
          optedOut: async (guildId, userId) =>
            !feedLive || (await consent.optedOut(botId, guildId, userId)),
        },
        clock,
        log,
      })
      voices.set(botId, { voice, pins })
      // Shards here that started before the voice existed can carry its joins already.
      nudge(botId, voice)
      return voice
    },
    holds: (botId) => holding.has(botId),
    close: async () => {
      closed = true
      cancelLoop()
      await ticking
      for (const cancel of onlineRetries.values()) cancel()
      onlineRetries.clear()
      for (const { cancel } of gates.values()) cancel()
      gates.clear()
      // Voice cannot move between processes, so bots leave their voice channels first.
      for (const { voice } of voices.values()) voice.close()
      for (const run of running.values()) halt(run)
      running.clear()
      voices.clear()
      // Sessions only: the next agent call makes a token or online-state write again.
      await sessionWrites()
      // One last try at failed writes, so the next host starts from the newest state.
      for (const { botId, shardId, session } of retries.values()) {
        saveSession(botId, shardId, session)
      }
      await sessionWrites()
      for (const { cancel } of retries.values()) cancel()
      retries.clear()
      // Other hosts take this host's shards and bots as soon as its leases are gone; if releasing
      // fails, once they expire.
      await leases
        .close()
        .catch((cause) => log(`Releasing this host's leases failed: ${reason(cause)}`))
      await (await watching)()
    },
  }
}
