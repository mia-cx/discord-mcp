import { WORKFLOW_LIMITS } from '@discord-mcp/workflow-sdk'
import { Effect, ManagedRuntime } from 'effect'
import { describe, expect, it } from 'vitest'
import { WorkflowQueues } from '../src/queue.ts'
import {
  type CronSchedule,
  checkScheduleFloor,
  MIN_SCHEDULE_INTERVAL_MINUTES,
  matches,
  nextFiring,
  parseCron,
} from '../src/schedule.ts'

/**
 * Schedules and queues: the two things that make automation run without anyone watching, and
 * therefore the two places where a mistake compounds unattended.
 */

const NOW = Date.UTC(2026, 6, 26, 12, 0, 0)

const parse = (expression: string): CronSchedule => {
  const result = parseCron(expression)
  if ('reason' in result) throw new Error(result.reason)
  return result
}

describe('cron parsing', () => {
  it('accepts the ordinary forms', () => {
    expect('reason' in parseCron('0 * * * *')).toBe(false)
    expect('reason' in parseCron('*/15 * * * *')).toBe(false)
    expect('reason' in parseCron('0 9-17 * * 1-5')).toBe(false)
    expect('reason' in parseCron('0 0 1,15 * *')).toBe(false)
  })

  it('refuses the wrong number of fields with a message naming them', () => {
    const rejected = parseCron('0 * * *')
    expect('reason' in rejected && rejected.reason).toContain('five fields')
  })

  it('refuses values outside a field’s range', () => {
    expect('reason' in parseCron('60 * * * *')).toBe(true)
    expect('reason' in parseCron('* 24 * * *')).toBe(true)
    expect('reason' in parseCron('* * 0 * *')).toBe(true)
    expect('reason' in parseCron('* * * 13 *')).toBe(true)
  })

  it('refuses month and weekday names rather than guessing a locale', () => {
    expect('reason' in parseCron('0 0 * JAN *')).toBe(true)
    expect('reason' in parseCron('0 0 * * MON')).toBe(true)
  })

  it('treats 7 and 0 as the same Sunday', () => {
    const seven = parse('0 0 * * 7')
    // 2026-07-26 is a Sunday.
    expect(matches(seven, new Date(Date.UTC(2026, 6, 26, 0, 0)))).toBe(true)
  })
})

describe('cron matching', () => {
  it('is evaluated in UTC, not the server’s zone', () => {
    const schedule = parse('30 14 * * *')
    expect(matches(schedule, new Date(Date.UTC(2026, 6, 26, 14, 30)))).toBe(true)
    // The same wall-clock time in another zone is a different instant, and only UTC decides.
    expect(matches(schedule, new Date(Date.UTC(2026, 6, 26, 13, 30)))).toBe(false)
  })

  it('ORs day-of-month with day-of-week when both are restricted', () => {
    const schedule = parse('0 0 1 * 1')
    // The 1st, whatever weekday it is...
    expect(matches(schedule, new Date(Date.UTC(2026, 6, 1, 0, 0)))).toBe(true)
    // ...and every Monday, whatever date it is. Surprising, but it is what every cron does.
    expect(matches(schedule, new Date(Date.UTC(2026, 6, 27, 0, 0)))).toBe(true)
    expect(matches(schedule, new Date(Date.UTC(2026, 6, 28, 0, 0)))).toBe(false)
  })

  it('finds the next firing across a month boundary', () => {
    const schedule = parse('0 0 1 * *')
    const next = nextFiring(schedule, new Date(Date.UTC(2026, 6, 26, 12, 0)))
    expect(next?.toISOString()).toBe('2026-08-01T00:00:00.000Z')
  })

  it('finds the next firing across a leap day', () => {
    const schedule = parse('0 12 29 2 *')
    const next = nextFiring(schedule, new Date(Date.UTC(2027, 0, 1)))
    expect(next?.toISOString()).toBe('2028-02-29T12:00:00.000Z')
  })

  it('returns nothing for a schedule that never fires', () => {
    // 30 February.
    expect(nextFiring(parse('0 0 30 2 *'), new Date(NOW))).toBeUndefined()
  })
})

describe('the schedule floor', () => {
  it('refuses a schedule that fires more often than the floor', () => {
    const rejection = checkScheduleFloor(parse('* * * * *'), new Date(NOW))
    expect(rejection?.reason).toContain(`${MIN_SCHEDULE_INTERVAL_MINUTES}-minute floor`)
  })

  it('catches an enumerated schedule as readily as a stepped one', () => {
    // `0,1,2,3,4` is every minute for five minutes; only one of these looks suspicious, and the
    // check works on actual firings rather than on how the expression is written.
    expect(checkScheduleFloor(parse('0,1,2,3,4 * * * *'), new Date(NOW))).toBeDefined()
  })

  it('accepts a schedule at the floor', () => {
    expect(checkScheduleFloor(parse('*/5 * * * *'), new Date(NOW))).toBeUndefined()
    expect(checkScheduleFloor(parse('0 * * * *'), new Date(NOW))).toBeUndefined()
  })
})

describe('workflow queues', () => {
  const runtime = ManagedRuntime.make(WorkflowQueues.layer)
  const run = <A>(effect: Effect.Effect<A, never, WorkflowQueues>) => runtime.runPromise(effect)

  const enqueue = (workflowId: string, overrides: Record<string, unknown> = {}) =>
    run(
      Effect.flatMap(WorkflowQueues, (queues) =>
        queues.enqueue({
          workflowId,
          revision: 1,
          triggerKind: 'gateway',
          triggerIndex: 0,
          payload: {},
          now: NOW,
          ...overrides,
        }),
      ),
    )

  const take = (workflowId: string, concurrency = 1) =>
    run(Effect.flatMap(WorkflowQueues, (queues) => queues.take({ workflowId, concurrency })))

  it('delivers events in order', async () => {
    await enqueue('wf-order', { payload: { n: 1 } })
    await enqueue('wf-order', { payload: { n: 2 } })

    const first = await take('wf-order')
    expect(first?.payload).toEqual({ n: 1 })

    await run(Effect.flatMap(WorkflowQueues, (q) => q.finish('wf-order')))
    const second = await take('wf-order')
    expect(second?.payload).toEqual({ n: 2 })
  })

  it('holds back work beyond a workflow’s concurrency', async () => {
    await enqueue('wf-concurrency')
    await enqueue('wf-concurrency')

    expect(await take('wf-concurrency', 1)).toBeDefined()
    // The second event is still queued; not starting work is cheaper than starting and throttling.
    expect(await take('wf-concurrency', 1)).toBeUndefined()

    await run(Effect.flatMap(WorkflowQueues, (q) => q.finish('wf-concurrency')))
    expect(await take('wf-concurrency', 1)).toBeDefined()
  })

  it('refuses the newest event on overflow, and says so', async () => {
    for (let index = 0; index < WORKFLOW_LIMITS.queuedEventsPerWorkflow; index += 1) {
      await enqueue('wf-overflow')
    }

    const overflowed = await enqueue('wf-overflow')
    expect(overflowed.accepted).toBe(false)
    // Refusing the newest rather than evicting the oldest: dropping the head would silently
    // reorder a causal chain.
    expect(!overflowed.accepted && overflowed.reason).toContain('not keeping up')
    expect(!overflowed.accepted && overflowed.dropped).toBe(1)
  })

  it('reports what it dropped rather than losing it silently', async () => {
    for (let index = 0; index <= WORKFLOW_LIMITS.queuedEventsPerWorkflow; index += 1) {
      await enqueue('wf-report')
    }

    const depth = await run(Effect.flatMap(WorkflowQueues, (q) => q.depth('wf-report')))
    expect(depth.pending).toBe(WORKFLOW_LIMITS.queuedEventsPerWorkflow)
    expect(depth.dropped).toBe(1)
  })

  it('keeps one workflow’s backlog out of another’s way', async () => {
    for (let index = 0; index < WORKFLOW_LIMITS.queuedEventsPerWorkflow; index += 1) {
      await enqueue('wf-noisy')
    }

    // A shared queue would have starved this one; per-workflow queues mean a slow handler degrades
    // itself and nothing else.
    await enqueue('wf-quiet')
    expect(await take('wf-quiet')).toBeDefined()
  })

  it('starts a new causal chain when nothing caused the event', async () => {
    const first = await enqueue('wf-chain')
    const second = await enqueue('wf-chain')

    expect(first.accepted && second.accepted).toBe(true)
    expect(first.accepted && second.accepted && first.event.correlationId).not.toBe(
      second.accepted && second.event.correlationId,
    )
  })

  it('carries correlation and causation through a caused event', async () => {
    const caused = await enqueue('wf-caused', {
      correlationId: 'corr-1',
      causationId: 'exec-0',
      causalDepth: 2,
    })

    expect(caused.accepted && caused.event.correlationId).toBe('corr-1')
    expect(caused.accepted && caused.event.causationId).toBe('exec-0')
    expect(caused.accepted && caused.event.causalDepth).toBe(2)
  })

  it('discards queued work when a workflow is disabled', async () => {
    await enqueue('wf-drain')
    await enqueue('wf-drain')

    const discarded = await run(Effect.flatMap(WorkflowQueues, (q) => q.drain('wf-drain')))
    expect(discarded).toBe(2)

    // Disabling should not leave work that resumes the moment someone re-enables it.
    expect(await take('wf-drain')).toBeUndefined()
  })
})
