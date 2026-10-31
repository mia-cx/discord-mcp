import { expect, it } from 'vitest'
import { createIdentifyGate, type IdentifyGate } from '../src/identify.ts'
import { manualClock } from '../src/testing.ts'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const LIMIT = { total: 1000, remaining: 1000, resetAfter: DAY, maxConcurrency: 1 }

/** Reserve an Identify and return 0, or return the wait until the budget reopens. */
const waitToReserve = (gate: IdentifyGate) => (gate.reserve() === undefined ? gate.reopensIn() : 0)

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
  {
    case: 'no more shards than half of what remains, however many start at once',
    remaining: 4,
    resetAfter: HOUR,
    waits: [0, 0, HOUR, HOUR, HOUR, HOUR, HOUR, HOUR],
  },
])('reserves the daily Identify budget: $case', ({ remaining, resetAfter, waits }) => {
  const gate = createIdentifyGate(manualClock(), { ...LIMIT, remaining, resetAfter })
  expect(waits.map(() => waitToReserve(gate))).toEqual(waits)
})

it('gets back an Identify reserved by a connection that never identified', () => {
  const gate = createIdentifyGate(manualClock(), { ...LIMIT, remaining: 2 })
  const reservation = gate.reserve()
  expect(waitToReserve(gate)).toBe(DAY)

  reservation?.release()
  expect(waitToReserve(gate)).toBe(0)
})

it('counts reservations still held at the reset against the new window', () => {
  const clock = manualClock()
  const gate = createIdentifyGate(clock, {
    total: 6,
    remaining: 4,
    resetAfter: HOUR,
    maxConcurrency: 1,
  })
  // Both wait for Hello or their bucket's turn while Discord's window resets.
  const sentAfterReset = gate.reserve()
  const droppedAfterReset = gate.reserve()

  clock.advance(HOUR)
  // The new window holds three; the two still waiting take two of them.
  expect(waitToReserve(gate)).toBe(0)
  expect(waitToReserve(gate)).toBe(DAY)
  sentAfterReset?.spend()
  droppedAfterReset?.release()
  expect(waitToReserve(gate)).toBe(0)
  expect(waitToReserve(gate)).toBe(DAY)
})

it('reserves half the daily total once the budget resets, then waits a day', () => {
  const clock = manualClock()
  const gate = createIdentifyGate(clock, { ...LIMIT, remaining: 0, resetAfter: HOUR })
  expect(waitToReserve(gate)).toBe(HOUR)

  clock.advance(HOUR)
  const reserved = Array.from({ length: 500 }, () => waitToReserve(gate))
  expect(reserved.every((wait) => wait === 0)).toBe(true)
  expect(waitToReserve(gate)).toBe(DAY)
})
