import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'
import type { WorkflowGrants } from './index.ts'

/**
 * Bots whose tokens the platform holds. `sealedToken` is a token vault envelope, never plaintext.
 * A bot is online while `onlineUntil` is set: every bot host runs its share of the bot's
 * `shardCount` shards against `gatewayUrl` until then.
 */
export const bots = pgTable('bots', {
  id: text('id').primaryKey(),
  sealedToken: text('sealed_token').notNull(),
  shardCount: integer('shard_count'),
  gatewayUrl: text('gateway_url'),
  /** Milliseconds since the epoch, on the bot hosts' clocks. */
  onlineUntil: bigint('online_until', { mode: 'number' }),
  /**
   * The close code Discord refused this token with, so it stays offline until the token changes,
   * or for refused intents, until its workflows change.
   */
  rejectedCode: integer('rejected_code'),
  /** Its presence as JSON, or null for plain online. Cleared when it goes offline. */
  presence: text('presence'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * Gateway sessions a bot host can resume, one per shard. A row exists only while its shard is
 * online or between a host stopping and another resuming it. `sealedSession` is a token vault
 * envelope.
 */
export const shardSessions = pgTable(
  'shard_sessions',
  {
    botId: text('bot_id')
      .notNull()
      .references(() => bots.id, { onDelete: 'cascade' }),
    shardId: integer('shard_id').notNull(),
    sealedSession: text('sealed_session').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.botId, table.shardId] })],
)

/** A bot's named workflow. Its revisions are immutable; publishing adds the next one. */
export const workflows = pgTable(
  'workflows',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    botId: text('bot_id').notNull(),
    name: text('name').notNull(),
    latestRevision: integer('latest_revision').notNull(),
    /** The revision the dispatcher runs, or null while disabled. */
    enabledRevision: integer('enabled_revision'),
    /**
     * The instant the enabled revision's schedules have fired up to, starting when it was enabled.
     * Null while disabled.
     */
    scheduleCursor: timestamp('schedule_cursor', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.botId, table.name)],
)

export const workflowRevisions = pgTable(
  'workflow_revisions',
  {
    workflowId: uuid('workflow_id')
      .notNull()
      .references(() => workflows.id, { onDelete: 'cascade' }),
    revision: integer('revision').notNull(),
    source: text('source').notNull(),
    /**
     * The source bundled with its dependencies, as the isolate runs it. Null for revisions
     * published before bundles were stored; those are bundled from `source` when loaded.
     */
    bundle: text('bundle'),
    /** Every npm package the bundle was built with, as `name@version`, sorted. */
    packages: jsonb('packages').$type<ReadonlyArray<string>>().notNull().default([]),
    grants: jsonb('grants').$type<WorkflowGrants>().notNull(),
    /** The discord.js events the revision's clients listen for, found when it was published. */
    events: jsonb('events').$type<ReadonlyArray<string>>().notNull(),
    /** The Gateway intents its clients declare, as a bitfield. */
    intents: integer('intents').notNull(),
    /** Whether its default export has a fetch handler, which answers its inbound HTTP route. */
    route: boolean('route').notNull().default(false),
    /** The cron expressions its clients declare, in UTC. */
    schedules: jsonb('schedules').$type<ReadonlyArray<string>>().notNull().default([]),
    publishedBy: text('published_by').notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.workflowId, table.revision] })],
)

/**
 * Every workflow change, with the Discord user who made it. No foreign key, so a deleted
 * workflow's history stays.
 */
export const workflowChanges = pgTable(
  'workflow_changes',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    botId: text('bot_id').notNull(),
    workflowName: text('workflow_name').notNull(),
    action: text('action', { enum: ['publish', 'enable', 'disable', 'delete'] }).notNull(),
    revision: integer('revision'),
    actorId: text('actor_id').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index().on(table.botId, table.id)],
)

/**
 * Each workflow's key-value state, kept across revisions and restarts and deleted with the
 * workflow. `value` is JSON text; a workflow's keys and values together count toward its limit.
 */
export const workflowKv = pgTable(
  'workflow_kv',
  {
    workflowId: uuid('workflow_id')
      .notNull()
      .references(() => workflows.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    value: text('value').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.workflowId, table.key] })],
)

/** What each workflow run did: its outcome, error, and console output. Pruned by age and count. */
export const workflowRuns = pgTable(
  'workflow_runs',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    workflowId: uuid('workflow_id')
      .notNull()
      .references(() => workflows.id, { onDelete: 'cascade' }),
    revision: integer('revision').notNull(),
    /** What it ran for: a Gateway dispatch, such as MESSAGE_CREATE, or `schedule <cron>`. */
    event: text('event').notNull(),
    outcome: text('outcome', {
      enum: ['completed', 'threw', 'timed_out', 'crashed', 'skipped'],
    }).notNull(),
    error: text('error'),
    logs: jsonb('logs').$type<ReadonlyArray<string>>().notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }).notNull(),
  },
  (table) => [index().on(table.workflowId, table.id), index().on(table.finishedAt)],
)

/**
 * Named, expiring claims that keep each piece of work on one bot host process at a time: a
 * host's membership, a shard, a bot's REST traffic, a turn to identify.
 */
export const leases = pgTable('leases', {
  name: text('name').primaryKey(),
  /** The process holding the lease. */
  holder: text('holder').notNull(),
  /** Milliseconds since the epoch, on the holder's clock. */
  expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
})

/**
 * People who opted out of having one bot relay their voice in one server. Personal data: only the
 * three IDs the opt-out needs, nothing about when or where they clicked.
 */
export const voiceOptOuts = pgTable(
  'voice_opt_outs',
  {
    botId: text('bot_id').notNull(),
    guildId: text('guild_id').notNull(),
    userId: text('user_id').notNull(),
  },
  (table) => [primaryKey({ columns: [table.botId, table.guildId, table.userId] })],
)

/** People who opted out of having any bot relay their voice, anywhere. Only the user ID. */
export const voiceGlobalOptOuts = pgTable('voice_global_opt_outs', {
  userId: text('user_id').primaryKey(),
})
