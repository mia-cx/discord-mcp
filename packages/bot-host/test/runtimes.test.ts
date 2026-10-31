import { inMemoryStorage } from '@discord-mcp/storage/testing'
import { expect, it, vi } from 'vitest'
import { createBotRuntimes, IDLE_TIMEOUT_MS } from '../src/runtimes.ts'
import { fakeGateway, manualClock } from '../src/testing.ts'
import { createTokenVault } from '../src/vault.ts'

const BOT_ID = '345678901234567890'
const KEY = Buffer.alloc(32, 1)
const HOUR = 60 * 60 * 1000

it('leaves a bot Discord rejected offline until its token changes', async () => {
  const storage = await inMemoryStorage()
  const gateway = await fakeGateway()
  const bots = createBotRuntimes({
    vault: createTokenVault(KEY, storage),
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

  await bots.close()
  await gateway.close()
  await storage.close()
})

it('resumes an online bot after a restart, from what the previous process stored', async () => {
  const storage = await inMemoryStorage()
  const gateway = await fakeGateway()
  const options = { clock: manualClock(), log: () => {}, gatewayUrl: gateway.url }
  const before = createBotRuntimes({ vault: createTokenVault(KEY, storage), ...options })
  const stored = createTokenVault(KEY, storage)

  await before.use(BOT_ID, 'private-token-a')
  await vi.waitFor(() => expect(gateway.connections[0]?.received[0]?.op).toBe(2))
  gateway.connections[0]?.send({ op: 0, t: 'MESSAGE_CREATE', s: 2, d: {} })
  await vi.waitFor(async () => expect((await stored.loadSessions())[0]?.session.sequence).toBe(2))
  await before.close()
  // Any close but 1000 or 1001 keeps the session resumable.
  await vi.waitFor(() => expect(gateway.connections[0]?.closeCode).toBe(4000))

  // The next process shares nothing with the last but the database and the vault key.
  const after = createBotRuntimes({ vault: createTokenVault(KEY, storage), ...options })
  await after.resume()
  await vi.waitFor(() =>
    expect(gateway.connections[1]?.received[0]).toEqual({
      op: 6,
      d: { token: 'private-token-a', session_id: 'fake-session', seq: 2 },
    }),
  )
  // Discord replays what happened during the restart.
  gateway.connections[1]?.send({ op: 0, t: 'MESSAGE_CREATE', s: 3, d: {} })
  gateway.connections[1]?.send({ op: 0, t: 'RESUMED', s: 4, d: {} })
  await vi.waitFor(async () => expect((await stored.loadSessions())[0]?.session.sequence).toBe(4))

  await after.close()
  await gateway.close()
  await storage.close()
})

it('retries a failed session store, so an online bot still resumes after a restart', async () => {
  const storage = await inMemoryStorage()
  const gateway = await fakeGateway(100 * HOUR)
  const clock = manualClock()
  const vault = createTokenVault(KEY, storage)
  const storeSession = vi
    .fn(vault.storeSession)
    .mockRejectedValueOnce(new Error('Connection terminated unexpectedly'))
  const bots = createBotRuntimes({
    vault: { ...vault, storeSession },
    clock,
    log: () => {},
    gatewayUrl: gateway.url,
  })

  // READY is the only dispatch, and storing it fails.
  await bots.use(BOT_ID, 'private-token-a')
  await vi.waitFor(() => expect(storeSession).toHaveBeenCalledTimes(1))
  expect(await vault.loadSessions()).toEqual([])

  clock.advance(60_000)
  await vi.waitFor(async () => expect(await vault.loadSessions()).toHaveLength(1))

  await bots.close()
  await gateway.close()
  await storage.close()
})

it('clears an idle bot’s session even when the clear fails during shutdown', async () => {
  const storage = await inMemoryStorage()
  const gateway = await fakeGateway(100 * HOUR)
  const clock = manualClock()
  const vault = createTokenVault(KEY, storage)
  let failClear = (_: Error) => {}
  const clearSession = vi.fn(vault.clearSession).mockImplementationOnce(
    () =>
      new Promise((_, reject) => {
        failClear = reject
      }),
  )
  const bots = createBotRuntimes({
    vault: { ...vault, clearSession },
    clock,
    log: () => {},
    gatewayUrl: gateway.url,
  })

  await bots.use(BOT_ID, 'private-token-a')
  await vi.waitFor(async () => expect(await vault.loadSessions()).toHaveLength(1))
  clock.advance(IDLE_TIMEOUT_MS)
  await vi.waitFor(() => expect(clearSession).toHaveBeenCalledTimes(1))
  // Shutdown starts while the clear is in flight, and then the clear fails.
  const closed = bots.close()
  failClear(new Error('Connection terminated unexpectedly'))
  await closed
  expect(await vault.loadSessions()).toEqual([])
  await gateway.close()
  await storage.close()
})
