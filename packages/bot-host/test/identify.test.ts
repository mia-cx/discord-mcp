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

it('keeps five seconds between Identifies when their timers fire late', () => {
  const clock = manualClock()
  const gate = createIdentifyGate(clock, LIMIT)
  const at: number[] = []
  for (const shardId of [0, 1, 2]) gate.whenFree(shardId, () => at.push(clock.now()))

  // The event loop blocks past both waiting shards' turns.
  clock.stall(11_000)
  clock.advance(DAY)
  expect(at).toEqual([0, 11_000, 16_000])
})

it('gives a withdrawn turn to the next shard in its bucket', () => {
  const clock = manualClock()
  const gate = createIdentifyGate(clock, LIMIT)
  const at: Array<[shardId: number, ms: number]> = []
  for (const shardId of [0, 1, 2]) {
    const withdraw = gate.whenFree(shardId, () => at.push([shardId, clock.now()]))
    if (shardId === 1) withdraw()
  }

  clock.advance(DAY)
  expect(at).toEqual([
    [0, 0],
    [2, 5_000],
  ])
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
  // Every shard in its own bucket, so only the budget makes anyone wait.
  const gate = createIdentifyGate(manualClock(), {
    ...LIMIT,
    remaining,
    resetAfter,
    maxConcurrency: 16,
  })
  const seen = waits.map((_, shardId) => {
    const wait = gate.budgetWait()
    if (wait === 0) gate.whenFree(shardId, () => {})
    return wait
  })
  expect(seen).toEqual(waits)
})

it('charges only Identifies sent, not connections that failed before Hello', () => {
  const gate = createIdentifyGate(manualClock(), { ...LIMIT, remaining: 2 })
  // Shards that pass the budget check but never reach Hello send no Identify.
  for (let attempt = 0; attempt < 10; attempt++) expect(gate.budgetWait()).toBe(0)

  gate.whenFree(0, () => {})
  expect(gate.budgetWait()).toBe(DAY)
})

it('spends half the daily total once the budget resets, then waits a day', () => {
  const clock = manualClock()
  const gate = createIdentifyGate(clock, {
    ...LIMIT,
    remaining: 0,
    resetAfter: HOUR,
    maxConcurrency: 500,
  })
  expect(gate.budgetWait()).toBe(HOUR)

  clock.advance(HOUR)
  for (let shardId = 0; shardId < 500; shardId++) {
    expect(gate.budgetWait()).toBe(0)
    gate.whenFree(shardId, () => {})
  }
  expect(gate.budgetWait()).toBe(DAY)
})
