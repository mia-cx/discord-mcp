import { randomUUID } from 'node:crypto'
import { connectStorage } from '@discord-mcp/storage'
import { postgresTestDatabase } from '@discord-mcp/storage/testing'
import { Client } from 'pg'
import { afterAll, afterEach, expect, it } from 'vitest'
import { advisoryLocks } from '../src/locks.ts'

const database = await postgresTestDatabase()
const cleanup: Array<() => unknown> = []
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})
afterAll(() => database?.drop())

const admin = async (url: string, statement: string) => {
  const client = new Client({ connectionString: url })
  await client.connect()
  try {
    await client.query(statement)
  } finally {
    await client.end()
  }
}

it.skipIf(database === undefined)(
  'end a session whose lock statement fails after Postgres took the lock, so another can take it',
  async () => {
    if (database === undefined) return
    let timeOut = true
    // Postgres runs the statement, but the client gives up waiting, as past `query_timeout`.
    const locks = advisoryLocks(async () => {
      const client = new Client({ connectionString: database.url })
      await client.connect()
      return {
        query: async (text, values) => {
          const { rows } = await client.query(text, [...values])
          if (!timeOut) return rows
          timeOut = false
          throw new Error('Query read timeout')
        },
        close: () => client.end(),
      }
    })
    cleanup.push(locks.close)
    const other = await connectStorage(database.url, () => {})
    cleanup.push(other.close)

    await expect(locks.lock('textile-schedules:1')).rejects.toThrow('timeout')
    expect(await locks.lock('textile-schedules:1')).toBe(true)
    await locks.unlock('textile-schedules:1')

    expect(await other.lockSchedules('1')).toBe(true)
  },
)

it.skipIf(database === undefined)(
  'take a lock with any DATABASE_URL the pool connects with',
  async () => {
    if (database === undefined) return
    const { hostname, port, pathname } = new URL(database.url)
    const role = `lock_${randomUUID().replaceAll('-', '')}`
    await admin(database.url, `create role ${role} superuser login password 'pa%ss'`)
    cleanup.push(() => admin(database.url, `drop role ${role}`))

    for (const url of [
      // A literal percent sign, which pg reads as itself.
      `postgres://${role}:pa%ss@${hostname}:${port}${pathname}`,
      // No host in the authority, and options repeated: pg takes the last.
      `postgres://${role}:pa%25ss@${pathname}?host=${hostname}&port=${port}&options=-c%20statement_timeout%3D1&options=-c%20statement_timeout%3D30000`,
    ]) {
      const storage = await connectStorage(url, () => {})
      try {
        expect(await storage.lockSchedules('1')).toBe(true)
      } finally {
        await storage.close()
      }
    }
  },
)
