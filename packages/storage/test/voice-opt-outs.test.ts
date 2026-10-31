import { connectStorage, type VoiceOptOutChange } from '@discord-mcp/storage'
import { postgresTestDatabase } from '@discord-mcp/storage/testing'
import { Client } from 'pg'
import { afterAll, afterEach, expect, it, vi } from 'vitest'

const database = await postgresTestDatabase()
const cleanup: Array<() => unknown> = []
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})
afterAll(() => database?.drop())

const USER_ID = '158533742254751744'

it.skipIf(database === undefined)(
  "hears other processes' opt-outs, and listens again once Postgres ends its session",
  async () => {
    if (database === undefined) return
    // Two bot hosts sharing the database.
    const writer = await connectStorage(database.url, () => {})
    const reader = await connectStorage(database.url, () => {})
    cleanup.push(writer.close, reader.close)
    const changes: VoiceOptOutChange[] = []
    const lost: string[] = []
    let live = 0
    cleanup.push(
      await reader.watchVoiceOptOuts({
        changed: (change) => changes.push(change),
        live: () => {
          live += 1
        },
        lost: (error) => lost.push(error.message),
      }),
    )
    await vi.waitFor(() => expect(live).toBe(1))

    await writer.setVoiceOptOut({ everywhere: true }, USER_ID, true)
    await vi.waitFor(() =>
      expect(changes).toEqual([{ scope: { everywhere: true }, userId: USER_ID, optedOut: true }]),
    )

    // Postgres ends the listening session, as in a failover.
    const admin = new Client({ connectionString: database.url })
    await admin.connect()
    await admin.query(
      `select pg_terminate_backend(pid) from pg_stat_activity
       where datname = current_database() and query = 'listen "voice_opt_outs"'`,
    )
    await admin.end()
    await vi.waitFor(() => expect(lost).toHaveLength(1))
    await vi.waitFor(() => expect(live).toBe(2), { timeout: 5_000 })

    const scope = { botId: '345678901234567890', guildId: '234567890123456789' }
    await writer.setVoiceOptOut(scope, USER_ID, true)
    await vi.waitFor(() =>
      expect(changes.at(-1)).toEqual({ scope, userId: USER_ID, optedOut: true }),
    )
    expect(await reader.voiceOptedOut(scope.botId, scope.guildId, USER_ID)).toBe(true)
  },
)
