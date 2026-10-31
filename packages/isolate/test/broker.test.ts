import { OperationCatalog } from '@mia-cx/discord-catalog'
import { Effect } from 'effect'
import { expect, it, vi } from 'vitest'
import { makeBroker } from '../src/broker.ts'

const catalog = await Effect.runPromise(Effect.provide(OperationCatalog, OperationCatalog.layer))

const setPresence = (activity: Record<string, unknown>) =>
  new Request('https://gateway.textile.internal/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      op: 3,
      d: { since: null, afk: false, status: 'online', activities: [activity] },
    }),
  })

it.each([
  [{ name: 'tests', type: 0 }, 204, 'a presence discord.js sends'],
  [{ name: 'x'.repeat(16_000), type: 0 }, 403, 'one Discord would close the connection over'],
  [{ name: 'tests', type: 99 }, 403, 'an activity type Discord does not define'],
])('answers setPresence(%o) with %i: %s', async (activity, status) => {
  const updatePresence = vi.fn(async () => {})
  const broker = makeBroker({
    operations: catalog.all,
    grants: { operations: [], families: [], hosts: [] },
    discord: () => Effect.die('unused'),
    updatePresence,
    onDenied: () => {},
  })

  const response = await broker(setPresence(activity))

  expect(response.status).toBe(status)
  expect(updatePresence).toHaveBeenCalledTimes(status === 204 ? 1 : 0)
})
