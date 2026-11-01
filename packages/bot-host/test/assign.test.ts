import { expect, it } from 'vitest'
import { shardOwner } from '../src/assign.ts'

const BOT_ID = '345678901234567890'
const SHARDS = 64
const A = 'http://bot-host-0:3001'
const B = 'http://bot-host-1:3001'
const C = 'http://bot-host-2:3001'
const D = 'http://bot-host-3:3001'

const assignment = (hosts: string[]) =>
  Array.from({ length: SHARDS }, (_, shardId) => shardOwner(hosts, BOT_ID, shardId))

it.each([
  { change: 'a host joins: shards move only to it', before: [A, B], after: [A, B, C], to: C },
  { change: 'a second host joins', before: [A, B, C], after: [A, B, C, D], to: D },
  { change: 'a host leaves: only its shards move', before: [A, B, C], after: [A, C], from: B },
  { change: 'the last other host leaves', before: [A, B], after: [A], from: B },
  { change: 'a host joins the first', before: [A], after: [A, B], to: B },
])("spreads one bot's shards over every host: $change", ({ before, after, from, to }) => {
  const old = assignment(before)
  const next = assignment(after)
  // Every shard has exactly one host, and every host runs some.
  for (const owners of [old, next]) expect(owners.every((host) => host !== undefined)).toBe(true)
  expect(new Set(next)).toEqual(new Set(after))
  expect(assignment([...after].reverse())).toEqual(next)

  const moved = next.flatMap((host, shardId) => (old[shardId] === host ? [] : [shardId]))
  expect(moved.length).toBeGreaterThan(0)
  for (const shardId of moved) {
    if (to !== undefined) expect(next[shardId]).toBe(to)
    if (from !== undefined) expect(old[shardId]).toBe(from)
  }
})
