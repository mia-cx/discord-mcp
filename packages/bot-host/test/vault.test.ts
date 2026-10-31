import { inMemoryStorage } from '@discord-mcp/storage/testing'
import { expect, it } from 'vitest'
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
