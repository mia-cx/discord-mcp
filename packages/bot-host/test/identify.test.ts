import { expect, it } from 'vitest'
import { createIdentifyGate } from '../src/identify.ts'
import { manualClock } from '../src/testing.ts'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const LIMIT = { total: 1000, remaining: 1000, resetAfter: DAY, maxConcurrency: 1 }

it.each([
  {
    case: 'one bucket identifies its shards five seconds apart, in the order they asked',
    maxConcurrency: 1,
    shards: [2, 0, 1],
    identified: [
      [2, 0],
      [0, 5_000],
      [1, 10_000],
    ],
  },
  {
    case: 'each concurrency bucket identifies on its own',
    maxConcurrency: 2,
    shards: [0, 1, 2, 3, 4],
    identified: [
      [0, 0],
      [1, 0],
      [2, 5_000],
      [3, 5_000],
      [4, 10_000],
    ],
  },
])('paces Identifies by max_concurrency: $case', ({ maxConcurrency, shards, identified }) => {
  const clock = manualClock()
  const gate = createIdentifyGate(clock, { ...LIMIT, maxConcurrency })
  const at: Array<[shardId: number, ms: number]> = []
  for (const shardId of shards) gate.whenFree(shardId, () => at.push([shardId, clock.now()]))
  clock.advance(DAY)
  expect(at).toEqual(identified)
})

it.each([
  {
    case: 'half of what Discord says remains, then a wait for its reset',
    remaining: 5,
    resetAfter: 3 * HOUR,
    waits: [0, 0, 3 * HOUR],
  },
  {
    case: 'nothing when one Identify remains',
    remaining: 1,
    resetAfter: HOUR,
    waits: [HOUR],
  },
])('spends the daily Identify budget: $case', ({ remaining, resetAfter, waits }) => {
  const gate = createIdentifyGate(manualClock(), { ...LIMIT, remaining, resetAfter })
  expect(waits.map(() => gate.spend())).toEqual(waits)
})

it('spends half the daily total once the budget resets, then waits a day', () => {
  const clock = manualClock()
  const gate = createIdentifyGate(clock, { ...LIMIT, remaining: 0, resetAfter: HOUR })
  expect(gate.spend()).toBe(HOUR)

  clock.advance(HOUR)
  const spent = Array.from({ length: 500 }, () => gate.spend())
  expect(spent.every((wait) => wait === 0)).toBe(true)
  expect(gate.spend()).toBe(DAY)
})
