import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import type { Storage } from './index.ts'
import * as schema from './schema.ts'
import { createStorage, migrationsFolder } from './store.ts'

/** A migrated in-process Postgres (PGlite) for tests. Each call is a fresh, empty database. */
export const inMemoryStorage = async (): Promise<Storage> => {
  const client = new PGlite()
  const db = drizzle(client, { schema })
  await migrate(db, { migrationsFolder })
  return createStorage(db, () => client.close())
}
