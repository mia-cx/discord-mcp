import { DiscordDispatcher, DiscordRestClient } from '@discord-mcp/discord-api'
import { Database } from '@discord-mcp/persistence'
import { Effect } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'
import { SqliteOperationPreviews } from './operation-previews.js'

describe('persistent operation previews', () => {
  const databases: Array<Database> = []
  afterEach(() => {
    for (const database of databases.splice(0)) database.close()
  })

  it('survives dispatcher reconstruction and is consumed atomically', async () => {
    const database = new Database(':memory:')
    database.migrate()
    databases.push(database)
    let calls = 0
    const rest = new DiscordRestClient({
      request: async () => {
        calls += 1
        return {}
      },
    })
    const input = {
      operationId: 'delete_channel',
      path: { channel_id: '12345678901234567' },
    } as const
    const issued = new DiscordDispatcher(rest, new SqliteOperationPreviews(database)).preview(
      'local-administrator',
      input,
    )
    expect(issued.previewToken).toBeDefined()
    const previewToken = issued.previewToken
    if (!previewToken) throw new Error('preview token was not issued')
    const restarted = new DiscordDispatcher(rest, new SqliteOperationPreviews(database))
    await Effect.runPromise(
      restarted.dispatch('local-administrator', 'destructive', {
        ...input,
        previewToken,
      }),
    )
    expect(calls).toBe(1)
    expect(() =>
      restarted.dispatch('local-administrator', 'destructive', {
        ...input,
        previewToken,
      }),
    ).toThrow(/used|missing/)
  })
})
