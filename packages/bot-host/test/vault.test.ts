import { inMemoryStorage } from '@discord-mcp/storage/testing'
import { expect, it } from 'vitest'
import { createTokenVault } from '../src/vault.ts'

const BOT_ID = '111111111111111111'
const ONLINE = { shardCount: 1, gatewayUrl: 'wss://gateway.discord.test', until: 1_000 }
const FENCE = { lease: `shard:${BOT_ID}:0`, holder: 'host-a' }

it('stores bot tokens that only the vault key can read', async () => {
  const storage = await inMemoryStorage()
  const vault = createTokenVault(Buffer.alloc(32, 1), storage)

  await vault.store(BOT_ID, 'private-bot-token')

  expect((await storage.loadBot(BOT_ID))?.sealedToken).not.toContain('private-bot-token')
  expect((await vault.load(BOT_ID))?.token).toBe('private-bot-token')
  await expect(createTokenVault(Buffer.alloc(32, 2), storage).load(BOT_ID)).rejects.toThrow()
  await storage.close()
})

it('keeps the sealed token out of a failed write', async () => {
  const storage = await inMemoryStorage()
  const vault = createTokenVault(Buffer.alloc(32, 1), storage)
  await storage.close()

  const failure = await vault.store(BOT_ID, 'private-bot-token').catch((e) => e)

  expect(failure).toBeInstanceOf(Error)
  expect(failure.message).toContain(BOT_ID)
  expect(failure.message).not.toContain('v1.')
})

it('stores shard sessions that only the vault key can read, alongside their token', async () => {
  const storage = await inMemoryStorage()
  const vault = createTokenVault(Buffer.alloc(32, 1), storage)
  const session = {
    sessionId: 'private-session-id',
    resumeGatewayUrl: 'wss://resume.discord.test',
    sequence: 42,
    intents: 129,
  }

  await vault.store(BOT_ID, 'private-bot-token')
  await storage.setBotOnline(BOT_ID, ONLINE)
  await storage.claimLease(FENCE.lease, FENCE.holder, 0, 1_000)
  await vault.storeSession(BOT_ID, 0, session, FENCE)

  const sealed = JSON.stringify(await storage.loadOnlineBots())
  expect(sealed).not.toContain('private-session-id')
  expect(sealed).not.toContain('resume.discord.test')
  expect(await vault.loadOnline()).toEqual([
    {
      botId: BOT_ID,
      token: 'private-bot-token',
      ...ONLINE,
      intents: 0,
      held: false,
      presence: null,
      sessions: new Map([[0, session]]),
    },
  ])
  await expect(createTokenVault(Buffer.alloc(32, 2), storage).loadOnline()).rejects.toThrow()

  await vault.clearSession(BOT_ID, 0, FENCE)
  expect((await vault.loadOnline())[0]?.sessions).toEqual(new Map())
  await storage.close()
})

it('keeps a shard’s session from a host that no longer holds its lease', async () => {
  const storage = await inMemoryStorage()
  const vault = createTokenVault(Buffer.alloc(32, 1), storage)
  const session = {
    sessionId: 'new-owner',
    resumeGatewayUrl: 'wss://resume.discord.test',
    sequence: 9,
    intents: 0,
  }
  await vault.store(BOT_ID, 'private-bot-token')
  await storage.setBotOnline(BOT_ID, ONLINE)
  await storage.claimLease(FENCE.lease, 'host-b', 0, 1_000)
  await vault.storeSession(BOT_ID, 0, session, { ...FENCE, holder: 'host-b' })

  // Host a's last writes land after host b took the shard.
  await vault.storeSession(BOT_ID, 0, { ...session, sessionId: 'old-owner', sequence: 3 }, FENCE)
  await vault.clearSession(BOT_ID, 0, FENCE)

  expect((await vault.loadOnline())[0]?.sessions).toEqual(new Map([[0, session]]))
  await storage.close()
})
