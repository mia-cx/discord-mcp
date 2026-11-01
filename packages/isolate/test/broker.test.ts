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
  [{ name: 'tests', type: 0 }, { name: 'tests', type: 0 }, 'a presence discord.js sends'],
  [
    { name: 'tests', type: 1, url: 'https://twitch.tv/x', emoji: { id: 1 } },
    { name: 'tests', type: 1, url: 'https://twitch.tv/x' },
    'fields discord.js never sends are dropped',
  ],
  [
    { name: 'x'.repeat(16_000), type: 0 },
    undefined,
    'too large: Discord would close the connection',
  ],
  [{ name: 'tests', type: 99 }, undefined, 'an activity type Discord does not define'],
  [{ name: 'tests', type: 1, url: 123 }, undefined, 'a URL that is not a string'],
])('forwards setPresence(%o) as %o: %s', async (activity, forwarded) => {
  const updatePresence = vi.fn(async () => {})
  const broker = makeBroker({
    operations: catalog.all,
    grants: { operations: [], families: [], hosts: [] },
    discord: () => Effect.die('unused'),
    updatePresence,
    onDenied: () => {},
  })

  const response = await broker(setPresence(activity))

  expect(response.status).toBe(forwarded === undefined ? 403 : 204)
  expect(updatePresence.mock.calls).toEqual(
    forwarded === undefined
      ? []
      : [[{ since: null, afk: false, status: 'online', activities: [forwarded] }]],
  )
})
