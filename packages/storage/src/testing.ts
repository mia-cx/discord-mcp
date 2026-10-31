import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import type { Storage } from './index.ts'
import { advisoryLocks } from './locks.ts'
import * as schema from './schema.ts'
import { createStorage, migrationsFolder } from './store.ts'

/**
 * A migrated in-process Postgres (PGlite) for tests. Each call is a fresh, empty database. PGlite
 * has one session, which holds every advisory lock it takes.
 */
export const inMemoryStorage = async (): Promise<Storage> => {
  const client = new PGlite()
  const db = drizzle(client, { schema })
  await migrate(db, { migrationsFolder })
  const locks = advisoryLocks(async () => ({
    query: async (text, values) =>
      (await client.query<Record<string, unknown>>(text, [...values])).rows,
    close: async () => {},
  }))
  return createStorage(db, locks, () => client.close())
}
