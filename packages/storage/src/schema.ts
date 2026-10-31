import {
  bigint,
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

/** Bots whose tokens the platform holds. `sealedToken` is a token vault envelope, never plaintext. */
export const bots = pgTable('bots', {
  id: text('id').primaryKey(),
  sealedToken: text('sealed_token').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * Gateway sessions a bot host can resume, one per shard. A row exists only while its shard is
 * online or between a restart and its resume. `sealedSession` is a token vault envelope.
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
    grants: jsonb('grants').$type<WorkflowGrants>().notNull(),
    /** The discord.js events the revision's clients listen for, found when it was published. */
    events: jsonb('events').$type<ReadonlyArray<string>>().notNull(),
    /** The Gateway intents its clients declare, as a bitfield. */
    intents: integer('intents').notNull(),
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
