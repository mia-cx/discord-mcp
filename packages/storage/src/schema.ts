import { integer, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core'

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
