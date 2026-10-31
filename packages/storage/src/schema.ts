import { pgTable, text, timestamp } from 'drizzle-orm/pg-core'

/** Bots whose tokens the platform holds. `sealedToken` is a token vault envelope, never plaintext. */
export const bots = pgTable('bots', {
  id: text('id').primaryKey(),
  sealedToken: text('sealed_token').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})
