import { connectStorage } from '@discord-mcp/storage'
import { postgresTestDatabase } from '@discord-mcp/storage/testing'
import { Client } from 'pg'
import { afterEach, expect, it } from 'vitest'
import { advisoryLocks } from '../src/locks.ts'

const database = await postgresTestDatabase()
const cleanup: Array<() => unknown> = []
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})

it.skipIf(database === undefined)(
  'end a session whose lock statement fails after Postgres took the lock, so another can take it',
  async () => {
    if (database === undefined) return
    cleanup.push(database.drop)
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
