import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Pool } from 'pg'
import * as schema from './schema.ts'
import { createStorage, migrationsFolder, rootMessage } from './store.ts'

/**
 * The platform's Postgres tables. Callers get plain functions; Drizzle stays inside this package.
 */
export interface Storage {
  /** Insert or replace a bot's token vault envelope. */
  readonly storeSealedToken: (botId: string, sealedToken: string) => Promise<void>
  readonly loadSealedToken: (botId: string) => Promise<string | undefined>
  /** Insert or replace a shard's sealed Gateway session. The bot's token must be stored first. */
  readonly storeSealedSession: (
    botId: string,
    shardId: number,
    sealedSession: string,
  ) => Promise<void>
  readonly deleteSession: (botId: string, shardId: number) => Promise<void>
  /** Every stored shard session, with its bot's sealed token. */
  readonly loadSealedSessions: () => Promise<ReadonlyArray<SealedSession>>
  readonly close: () => Promise<void>
}

export interface SealedSession {
  readonly botId: string
  readonly shardId: number
  readonly sealedSession: string
  readonly sealedToken: string
}

const CONNECT_TIMEOUT_MS = 10_000
const QUERY_TIMEOUT_MS = 30_000

/**
 * Connect to Postgres and apply pending migrations before anything reads or writes.
 * `onError` hears connection failures outside a query, such as Postgres restarting; the pool
 * replaces the lost connection on next use.
 */
export const connectStorage = async (
  url: string,
  onError: (error: Error) => void,
): Promise<Storage> => {
  const pool = new Pool({
    connectionString: url,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    query_timeout: QUERY_TIMEOUT_MS,
  })
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
  return createStorage(db, () => pool.end())
}
