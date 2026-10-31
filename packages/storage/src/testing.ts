import { randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { Client } from 'pg'
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
  return createStorage(
    db,
    locks,
    () => client.close(),
    async (channel, { payload }) => {
      const unlisten = await client.listen(channel, payload)
      return () => unlisten()
    },
  )
}

/**
 * A fresh, empty database on the Postgres server at `TEST_DATABASE_URL`, for behaviour PGlite's one
 * session can't show, such as two processes contending for a lock. Undefined when it is unset.
 */
export const postgresTestDatabase = async () => {
  const server = process.env.TEST_DATABASE_URL
  if (server === undefined || server === '') return undefined
  const name = `test_${randomUUID().replaceAll('-', '')}`
  const admin = async (statement: string) => {
    const client = new Client({ connectionString: server })
    await client.connect()
    try {
      await client.query(statement)
    } finally {
      await client.end()
    }
  }
  await admin(`create database ${name}`)
  const url = new URL(server)
  url.pathname = `/${name}`
  return {
    url: url.href,
    drop: () => admin(`drop database ${name} with (force)`),
  }
}
