import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Pool } from 'pg'
import * as schema from './schema.ts'
import { createStorage, migrationsFolder } from './store.ts'

/**
 * The platform's Postgres tables. Callers get plain functions; Drizzle stays inside this package.
 */
export interface Storage {
  /** Insert or replace a bot's token vault envelope. */
  readonly storeSealedToken: (botId: string, sealedToken: string) => Promise<void>
  readonly loadSealedToken: (botId: string) => Promise<string | undefined>
  readonly close: () => Promise<void>
}

/** Drizzle wraps driver errors in "Failed query"; the driver's own message says what went wrong. */
const rootMessage = (error: unknown): string =>
  error instanceof Error && error.cause !== undefined ? rootMessage(error.cause) : String(error)

/** Connect to Postgres and apply pending migrations before anything reads or writes. */
export const connectStorage = async (url: string): Promise<Storage> => {
  const pool = new Pool({ connectionString: url })
  const db = drizzle(pool, { schema })
  try {
    await migrate(db, { migrationsFolder })
  } catch (cause) {
    await pool.end()
    throw new Error(`Could not connect to Postgres or apply migrations: ${rootMessage(cause)}`, {
      cause,
    })
  }
  return createStorage(db, () => pool.end())
}
