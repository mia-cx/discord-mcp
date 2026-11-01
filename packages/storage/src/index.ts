import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Client, Pool } from 'pg'
import { advisoryLocks } from './locks.ts'
import * as schema from './schema.ts'
import { createStorage, type Listen, migrationsFolder, rootMessage } from './store.ts'

/** What a workflow revision may do: catalog operation IDs, operation families, outbound hosts. */
export interface WorkflowGrants {
  readonly operations: ReadonlyArray<string>
  readonly families: ReadonlyArray<string>
  readonly hosts: ReadonlyArray<string>
}

/** One immutable revision of a bot's workflow. */
export interface WorkflowRevision {
  /** Stable across revisions; a workflow deleted and published again gets a new one. */
  readonly workflowId: string
  readonly botId: string
  readonly name: string
  readonly revision: number
  readonly source: string
  /** The source bundled with its dependencies; null for revisions stored before bundles were. */
  readonly bundle: string | null
  /** Every npm package the bundle was built with, as `name@version`, sorted. */
  readonly packages: ReadonlyArray<string>
  readonly grants: WorkflowGrants
  /** The discord.js events its clients listen for. */
  readonly events: ReadonlyArray<string>
  /** The Gateway intents its clients declare, as a bitfield. */
  readonly intents: number
  /** Whether it answers its inbound HTTP route. */
  readonly route: boolean
  /** The cron expressions its clients declare, in UTC. */
  readonly schedules: ReadonlyArray<string>
  /** The Discord user ID of the human who published it. */
  readonly publishedBy: string
  readonly publishedAt: Date
}

export interface WorkflowSummary {
  readonly name: string
  readonly latestRevision: number
  readonly enabledRevision: number | null
}

/** A recorded workflow change and the Discord user who made it. */
export interface WorkflowChange {
  readonly workflowName: string
  readonly action: 'publish' | 'enable' | 'disable' | 'delete'
  readonly revision: number | null
  readonly actorId: string
  readonly at: Date
}

/** How a workflow run ended. `skipped` runs never started, as when no process slot freed in time. */
export type WorkflowRunOutcome = 'completed' | 'threw' | 'timed_out' | 'crashed' | 'skipped'

/** One run of a workflow on one event. */
export interface WorkflowRun {
  readonly workflowId: string
  readonly revision: number
  /**
   * What it ran for: a Gateway dispatch, such as MESSAGE_CREATE, `schedule <cron>`, or `HTTP POST`
   * for a route request.
   */
  readonly event: string
  readonly outcome: WorkflowRunOutcome
  readonly error: string | null
  readonly logs: ReadonlyArray<string>
  readonly receivedAt: Date
  readonly finishedAt: Date
}

/** A recorded run, as an agent reads it back. */
export interface RecordedWorkflowRun extends Omit<WorkflowRun, 'workflowId'> {
  readonly id: number
  readonly workflowName: string
}

export interface WorkflowRunQuery {
  /** One workflow's runs; every workflow's when omitted. */
  readonly name?: string
  /** Only runs that did not complete. */
  readonly failed?: boolean
  /** Runs that finished before this are expired, even before pruning removes them. */
  readonly since: Date
  readonly limit: number
}

/** Where a voice opt-out applies: one bot in one server, or every bot everywhere. */
export type VoiceOptOutScope =
  | { readonly botId: string; readonly guildId: string }
  | { readonly everywhere: true }

/** A person opting out of voice relay in `scope`, or back in. */
export interface VoiceOptOutChange {
  readonly scope: VoiceOptOutScope
  readonly userId: string
  readonly optedOut: boolean
}

/** Hears voice opt-out changes as they commit. */
export interface OptOutWatcher {
  readonly changed: (change: VoiceOptOutChange) => void
  /**
   * Listening started, first or after `lost`. Changes made before it were not heard; changes
   * from now on are, until `lost`.
   */
  readonly live: () => void
  /** Listening stopped: why its connection failed or dropped. It retries on its own. */
  readonly lost: (error: Error) => void
}

export interface PublishWorkflow {
  readonly botId: string
  readonly name: string
  readonly source: string
  readonly bundle: string
  readonly packages: ReadonlyArray<string>
  readonly grants: WorkflowGrants
  readonly events: ReadonlyArray<string>
  readonly intents: number
  readonly route: boolean
  readonly schedules: ReadonlyArray<string>
  readonly actorId: string
}

/** An enabled workflow revision that runs on schedules, and how far they have fired. */
export interface ScheduledWorkflow {
  readonly botId: string
  readonly name: string
  readonly revision: number
  readonly schedules: ReadonlyArray<string>
  /** Every tick up to this instant has fired, or fell before the revision was enabled. */
  readonly cursor: Date
}

/**
 * The platform's Postgres tables. Callers get plain functions; Drizzle stays inside this package.
 * Every workflow change records its actor in the same transaction. Times are milliseconds since
 * the epoch on the caller's clock.
 */
export interface Storage {
  /**
   * Insert or replace a bot's token vault envelope. A replaced token ends the bot's sessions and
   * takes it offline, since Discord ends them too.
   */
  readonly storeSealedToken: (botId: string, sealedToken: string) => Promise<void>
  readonly loadBot: (botId: string) => Promise<StoredBot | undefined>
  /**
   * Bring an offline, unrefused bot online until `online.until`, with no sessions to resume, if
   * its token is still `sealedToken`. Resolves whether it changed.
   */
  readonly setBotOnline: (botId: string, sealedToken: string, online: BotOnline) => Promise<boolean>
  /** Extend an online bot's time online. Resolves `false` when the bot is offline. */
  readonly keepBotOnline: (botId: string, until: number) => Promise<boolean>
  /** Set an online bot's presence, as JSON. Resolves `false` when the bot is offline. */
  readonly setBotPresence: (botId: string, presence: string) => Promise<boolean>
  /**
   * Take a bot offline and end its sessions. With `idleAt`, only if it has no enabled workflows
   * and its time online ended by then; with `rejectedCode`, it stays offline until its token is stored again;
   * with `sealedToken`, only if that is still its token; with `ranAs`, only while it is online
   * with the shard count and workflow intents given there. Resolves whether it changed.
   */
  readonly setBotOffline: (
    botId: string,
    options?: {
      readonly idleAt?: number
      readonly rejectedCode?: number
      readonly sealedToken?: string
      readonly ranAs?: BotRanAs
    },
  ) => Promise<boolean>
  /** Every online bot with its sealed token and stored sessions. */
  readonly loadOnlineBots: () => Promise<ReadonlyArray<OnlineBot>>
  /** Insert or replace a shard's sealed Gateway session, unless `fence` no longer holds. */
  readonly storeSealedSession: (
    botId: string,
    shardId: number,
    sealedSession: string,
    fence: Fence,
  ) => Promise<void>
  /** Delete a shard's session, unless `fence` no longer holds. */
  readonly deleteSession: (botId: string, shardId: number, fence: Fence) => Promise<void>
  /**
   * Claim a lease for `ttlMs` unless another holder's lease on it is live. A holder's own lease is
   * extended. Resolves the lease as it stands afterwards.
   */
  readonly claimLease: (name: string, holder: string, now: number, ttlMs: number) => Promise<Lease>
  /** Extend the live leases among `names` that `holder` has, resolving their names. */
  readonly renewLeases: (
    holder: string,
    names: ReadonlyArray<string>,
    now: number,
    ttlMs: number,
  ) => Promise<ReadonlyArray<string>>
  readonly releaseLease: (name: string, holder: string) => Promise<void>
  /** Release every lease `holder` has. */
  readonly releaseLeases: (holder: string) => Promise<void>
  /** The names of live leases that start with `prefix`. */
  readonly liveLeases: (prefix: string, now: number) => Promise<ReadonlyArray<string>>
  /** Store the workflow's next revision, creating the workflow on its first. */
  readonly publishWorkflow: (input: PublishWorkflow) => Promise<WorkflowRevision>
  readonly listWorkflows: (botId: string) => Promise<ReadonlyArray<WorkflowSummary>>
  /** A revision, or the latest when `revision` is omitted. */
  readonly loadWorkflowRevision: (
    botId: string,
    name: string,
    revision?: number,
  ) => Promise<WorkflowRevision | undefined>
  /**
   * Run `revision`, or nothing when null, with its schedules owing every tick after `at`, the
   * time of the change. False when the workflow or revision does not exist.
   */
  readonly setEnabledRevision: (
    botId: string,
    name: string,
    revision: number | null,
    actorId: string,
    at: Date,
  ) => Promise<boolean>
  /** Delete a workflow and its revisions. False when it does not exist. */
  readonly deleteWorkflow: (botId: string, name: string, actorId: string) => Promise<boolean>
  /** The enabled revision of every workflow, for one bot or for all of them. */
  readonly enabledRevisions: (botId?: string) => Promise<ReadonlyArray<WorkflowRevision>>
  /** A bot's most recent workflow changes, newest first, deleted workflows included. */
  readonly workflowChanges: (botId: string, limit: number) => Promise<ReadonlyArray<WorkflowChange>>
  /** Every bot's enabled revisions with schedules. */
  readonly scheduledWorkflows: () => Promise<ReadonlyArray<ScheduledWorkflow>>
  /**
   * Move a scheduled workflow's cursor from `from` to `to`. False, changing nothing, when its
   * cursor is no longer `from` or another revision runs: someone else fired those ticks.
   */
  readonly advanceScheduleCursor: (
    workflow: Pick<ScheduledWorkflow, 'botId' | 'name' | 'revision'>,
    from: Date,
    to: Date,
  ) => Promise<boolean>
  /**
   * Take the Postgres session advisory lock that lets one process fire a bot's schedules. True
   * while this process holds it, until `unlockSchedules`, `close`, or a lost connection releases
   * it. Lock one bot at a time.
   */
  readonly lockSchedules: (botId: string) => Promise<boolean>
  readonly unlockSchedules: (botId: string) => Promise<void>
  /** A workflow's stored value for `key`, as JSON text. */
  readonly loadWorkflowValue: (workflowId: string, key: string) => Promise<string | undefined>
  /**
   * Store `value`, JSON text, under `key`, unless the workflow's keys and values would then take
   * more than `limitBytes`. Writes to one workflow take turns, so concurrent ones cannot overshoot.
   * `bytes` is what the workflow's state takes with the value stored, or would have taken.
   */
  readonly storeWorkflowValue: (
    workflowId: string,
    key: string,
    value: string,
    limitBytes: number,
  ) => Promise<{ readonly stored: boolean; readonly bytes: number }>
  readonly deleteWorkflowValue: (workflowId: string, key: string) => Promise<void>
  /** Record a run, then delete all but its workflow's newest `keep`. */
  readonly recordWorkflowRun: (run: WorkflowRun, keep: number) => Promise<void>
  /** A bot's most recent workflow runs, newest first. */
  readonly workflowRuns: (
    botId: string,
    query: WorkflowRunQuery,
  ) => Promise<ReadonlyArray<RecordedWorkflowRun>>
  /** Delete runs that finished before `before`. Resolves to how many were deleted. */
  readonly pruneWorkflowRuns: (before: Date) => Promise<number>
  /** Opt a person out of voice relay, or back in, in `scope`. Repeating either changes nothing. */
  readonly setVoiceOptOut: (
    scope: VoiceOptOutScope,
    userId: string,
    optedOut: boolean,
  ) => Promise<void>
  /** Whether a person opted out of relay by this bot in this server, or by every bot. */
  readonly voiceOptedOut: (botId: string, guildId: string, userId: string) => Promise<boolean>
  /**
   * Hear every voice opt-out change any process sharing this database makes, this one included,
   * once it commits. Resolves to a function that stops listening.
   */
  readonly watchVoiceOptOuts: (watcher: OptOutWatcher) => Promise<() => Promise<void>>
  readonly close: () => Promise<void>
}

export interface BotOnline {
  readonly shardCount: number
  readonly gatewayUrl: string
  readonly until: number
}

/** What an online bot ran with, as a shard Discord closed saw it. Each given part must still hold. */
export interface BotRanAs {
  readonly shardCount?: number
  /** Its enabled workflows' intents. */
  readonly intents?: number
}

/** How every host runs a bot's shards while it is online. */
export interface BotGateway {
  /** The Gateway intents its shards identify with: every enabled workflow's, as a bitfield. */
  readonly intents: number
  /** It has enabled workflows, so it stays online without agent calls. */
  readonly held: boolean
  /** Its presence as JSON, or null for plain online. */
  readonly presence: string | null
}

export interface StoredBot extends BotGateway {
  readonly sealedToken: string
  readonly online: BotOnline | undefined
  /** The close code Discord refused the token with, or null. */
  readonly rejectedCode: number | null
}

export interface OnlineBot extends BotOnline, BotGateway {
  readonly botId: string
  readonly sealedToken: string
  readonly sessions: ReadonlyArray<{ readonly shardId: number; readonly sealedSession: string }>
}

export interface Lease {
  readonly holder: string
  readonly expiresAt: number
}

/** A write lands only while `holder` holds the lease named `lease`. */
export interface Fence {
  readonly lease: string
  readonly holder: string
}

const CONNECT_TIMEOUT_MS = 10_000
const QUERY_TIMEOUT_MS = 30_000
/** The lock session's TCP keepalives: idle seconds before probing, and probes before giving up. */
const KEEPALIVE_IDLE_S = 10
const KEEPALIVE_PROBES = 3

/** How long a lost listening connection waits before reconnecting. */
const RELISTEN_MS = 1_000
/** How often the listening connection proves it is alive; a dead one is noticed within this plus the query timeout. */
const LISTEN_HEARTBEAT_MS = 15_000

/**
 * Listen on its own connection, since a pooled one goes back to other queries. A connection that
 * fails, first or later, is retried until stopped, and `resumed` fires once listening works again.
 */
const listenOn =
  (url: string): Listen =>
  async (channel, { payload, listening, lost: onLost }) => {
    let stopped = false
    let current: Client | undefined
    let retry: ReturnType<typeof setTimeout> | undefined
    const open = () => {
      if (stopped) return
      const client = new Client({
        connectionString: url,
        connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
        query_timeout: CONNECT_TIMEOUT_MS,
      })
      current = client
      let lost = false
      let heartbeat: ReturnType<typeof setInterval> | undefined
      const reopen = (error: Error) => {
        clearInterval(heartbeat)
        if (lost || stopped) return
        lost = true
        onLost(error)
        void client.end().catch(() => {})
        retry = setTimeout(open, RELISTEN_MS)
      }
      client.on('error', reopen)
      client.on('end', () => reopen(new Error('The listening connection to Postgres ended.')))
      client.on('notification', (message) => {
        if (message.channel === channel && message.payload !== undefined) payload(message.payload)
      })
      client
        .connect()
        .then(() => client.query(`listen "${channel}"`))
        .then(() => {
          if (lost || stopped) return
          // A connection dropped without a FIN or RST reports nothing, so ask it something.
          heartbeat = setInterval(
            () => void client.query('select 1').catch(reopen),
            LISTEN_HEARTBEAT_MS,
          )
          listening()
        }, reopen)
    }
    open()
    return async () => {
      stopped = true
      clearTimeout(retry)
      await current?.end().catch(() => {})
    }
  }

/**
 * Connect to Postgres and apply pending migrations before anything reads or writes.
 * `onError` hears connection failures outside a query, such as Postgres restarting; the pool
 * replaces the lost connection on next use. `url` must reach the primary directly, with no pooler:
 * the scheduler's session locks need a session of their own, which sets its own keepalives.
 */
export const connectStorage = async (
  url: string,
  onError: (error: Error) => void,
): Promise<Storage> => {
  const options = {
    connectionString: url,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    query_timeout: QUERY_TIMEOUT_MS,
  }
  const pool = new Pool(options)
  pool.on('error', onError)
  const db = drizzle(pool, { schema })
  try {
    await migrate(db, { migrationsFolder })
  } catch (cause) {
    await pool.end()
    throw new Error(`Could not connect to Postgres or apply migrations: ${rootMessage(cause)}`, {
      cause,
    })
  }
  const locks = advisoryLocks(async (onLost) => {
    // Keepalives on both ends notice a dead connection within a minute. Postgres then ends the
    // session and releases its locks, so another bot host can fire the bots this one held. The
    // server's are set on the session, leaving DATABASE_URL to mean what it means to the pool.
    const client = new Client({
      ...options,
      keepAlive: true,
      keepAliveInitialDelayMillis: KEEPALIVE_IDLE_S * 1000,
    })
    client.on('error', (error) => {
      onError(error)
      onLost()
    })
    client.on('end', onLost)
    await client.connect()
    try {
      await client.query(
        `set tcp_keepalives_idle = ${KEEPALIVE_IDLE_S}; set tcp_keepalives_interval = ${KEEPALIVE_IDLE_S}; set tcp_keepalives_count = ${KEEPALIVE_PROBES}`,
      )
    } catch (error) {
      await client.end()
      throw error
    }
    return {
      query: async (text, values) => (await client.query(text, [...values])).rows,
      close: () => client.end(),
    }
  })
  return createStorage(db, locks, () => pool.end(), listenOn(url))
}
