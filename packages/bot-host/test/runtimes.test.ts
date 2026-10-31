import { inMemoryStorage } from '@discord-mcp/storage/testing'
import { expect, it, vi } from 'vitest'
import { createBotRuntimes } from '../src/runtimes.ts'
import { fakeGateway, manualClock } from '../src/testing.ts'
import { createTokenVault } from '../src/vault.ts'

const BOT_ID = '345678901234567890'

it('leaves a bot Discord rejected offline until its token changes', async () => {
  const storage = await inMemoryStorage()
  const gateway = await fakeGateway()
  const bots = createBotRuntimes({
    vault: createTokenVault(Buffer.alloc(32, 1), storage),
    clock: manualClock(),
    log: () => {},
    gatewayUrl: gateway.url,
  })

  await bots.use(BOT_ID, 'private-token-a')
  await vi.waitFor(() => expect(gateway.connections[0]?.received[0]?.op).toBe(2))
  // Sharding required: Discord rejects every single-shard Identify from this bot.
  gateway.connections[0]?.close(4011)
  await vi.waitFor(() => expect(gateway.connections[0]?.closeCode).toBe(4011))

  await bots.use(BOT_ID, 'private-token-a')
  await new Promise((resolve) => setTimeout(resolve, 100))
  expect(gateway.connections).toHaveLength(1)

  await bots.use(BOT_ID, 'private-token-b')
  await vi.waitFor(() => expect(gateway.connections[1]?.received[0]).toMatchObject({ op: 2 }))

  bots.close()
  await gateway.close()
  await storage.close()
})
