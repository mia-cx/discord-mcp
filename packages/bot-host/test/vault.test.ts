import { inMemoryStorage } from '@discord-mcp/storage/testing'
import { expect, it } from 'vitest'
import type { ShardSession } from '../src/shard.ts'
import { createTokenVault } from '../src/vault.ts'

it('stores bot tokens that only the vault key can read', async () => {
  const storage = await inMemoryStorage()
  const vault = createTokenVault(Buffer.alloc(32, 1), storage)

  await vault.store('111111111111111111', 'private-bot-token')

  expect(await storage.loadSealedToken('111111111111111111')).not.toContain('private-bot-token')
  expect(await vault.load('111111111111111111')).toBe('private-bot-token')
  await expect(
    createTokenVault(Buffer.alloc(32, 2), storage).load('111111111111111111'),
  ).rejects.toThrow()
  await storage.close()
})

it('keeps the sealed token out of a failed write', async () => {
  const storage = await inMemoryStorage()
  const vault = createTokenVault(Buffer.alloc(32, 1), storage)
  await storage.close()

  const failure = await vault.store('111111111111111111', 'private-bot-token').catch((e) => e)

  expect(failure).toBeInstanceOf(Error)
  expect(failure.message).toContain('111111111111111111')
  expect(failure.message).not.toContain('v1.')
})

it('stores shard sessions that only the vault key can read, alongside their token', async () => {
  const storage = await inMemoryStorage()
  const vault = createTokenVault(Buffer.alloc(32, 1), storage)
  const session = {
    sessionId: 'private-session-id',
    resumeGatewayUrl: 'wss://resume.discord.test',
    sequence: 42,
    shardCount: 3,
    intents: 129,
  }

  await vault.store('111111111111111111', 'private-bot-token')
  await vault.storeSession('111111111111111111', 0, session)

  const sealed = JSON.stringify(await storage.loadSealedSessions())
  expect(sealed).not.toContain('private-session-id')
  expect(sealed).not.toContain('resume.discord.test')
  expect(await vault.loadSessions()).toEqual([
    { botId: '111111111111111111', shardId: 0, token: 'private-bot-token', session },
  ])
  await expect(createTokenVault(Buffer.alloc(32, 2), storage).loadSessions()).rejects.toThrow()

  await vault.clearSession('111111111111111111', 0)
  expect(await vault.loadSessions()).toEqual([])
  await storage.close()
})

it('reads a session stored before bots sharded as shard 0 of 1', async () => {
  const storage = await inMemoryStorage()
  const vault = createTokenVault(Buffer.alloc(32, 1), storage)
  // The shape #45 sealed, with no shard count.
  const unsharded: Omit<ShardSession, 'shardCount'> = {
    sessionId: 'old',
    resumeGatewayUrl: 'wss://resume.discord.test',
    sequence: 9,
  }

  await vault.store('111111111111111111', 'private-bot-token')
  await vault.storeSession('111111111111111111', 0, unsharded as ShardSession)

  expect((await vault.loadSessions())[0]?.session).toEqual({ ...unsharded, shardCount: 1 })
  await storage.close()
})
