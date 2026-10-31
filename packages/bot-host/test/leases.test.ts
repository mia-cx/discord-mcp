import { inMemoryStorage } from '@discord-mcp/storage/testing'
import { expect, it, vi } from 'vitest'
import { createLeases, LEASE_TTL_MS } from '../src/leases.ts'
import { manualClock } from '../src/testing.ts'

it('holds nothing when Postgres grants a lease too late to rely on', async () => {
  const storage = await inMemoryStorage()
  const clock = manualClock()
  const leases = createLeases(
    {
      ...storage,
      // Postgres answers after the lease would already have to be given up.
      claimLease: async (...args) => {
        clock.stall(LEASE_TTL_MS)
        return storage.claimLease(...args)
      },
    },
    clock,
    vi.fn(),
  )

  expect(await leases.claim('bot:345678901234567890')).toBe(false)
  expect(leases.holds('bot:345678901234567890')).toBe(false)
  await storage.close()
})

it('lets a lease it could not release expire, rather than renewing it for nobody', async () => {
  const storage = await inMemoryStorage()
  const clock = manualClock()
  const leases = createLeases(
    {
      ...storage,
      releaseLease: () => Promise.reject(new Error('Connection terminated unexpectedly')),
    },
    clock,
    vi.fn(),
  )
  expect(await leases.claim('shard:345678901234567890:0')).toBe(true)
  await expect(leases.release('shard:345678901234567890:0')).rejects.toThrow()

  // Renewals go on for this process's other leases, but not this one.
  await leases.claim('host:bot-host-0')
  for (let renewal = 0; renewal < 4; renewal += 1) {
    clock.stall(LEASE_TTL_MS / 3)
    await leases.renew()
  }
  expect(
    await storage.claimLease('shard:345678901234567890:0', 'another', clock.date(), 1),
  ).toEqual(expect.objectContaining({ holder: 'another' }))
  await storage.close()
})

it('keeps one hold of a lease while extending it, and starts another once it is given up', async () => {
  const storage = await inMemoryStorage()
  const leases = createLeases(storage, manualClock(), vi.fn())
  const name = 'shard:345678901234567890:0'

  expect(await leases.claim(name)).toBe(true)
  const first = leases.tenure(name)
  expect(await leases.claim(name)).toBe(true)
  await leases.renew()
  expect(leases.tenure(name)).toBe(first)

  await leases.release(name)
  expect(leases.tenure(name)).toBeUndefined()
  expect(await leases.claim(name)).toBe(true)
  expect(leases.tenure(name)).not.toBe(first)
  await storage.close()
})
