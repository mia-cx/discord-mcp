import type { ScheduledWorkflow, Storage } from '@discord-mcp/storage'
import { nextFiring, parseCron } from './cron.ts'
import type { ScheduleTick } from './isolate-host.ts'

/** The wall clock and timers the scheduler runs on. The bot host's `Clock` is one. */
export interface SchedulerClock {
  /** Milliseconds since the Unix epoch. */
  readonly date: () => number
  /** Run `callback` after `ms`; the returned function cancels it. */
  readonly schedule: (callback: () => void, ms: number) => () => void
}

export interface SchedulerOptions {
  readonly storage: Storage
  readonly clock: SchedulerClock
  /** Run one tick of a workflow revision. Called once per tick across every process. */
  readonly fire: (workflow: ScheduledWorkflow, tick: ScheduleTick) => void
  readonly log: (message: string) => void
}

export interface Scheduler {
  /** Fire the schedules of the bots `owns` accepts, from now until `close`. */
  readonly start: (owns: (botId: string) => boolean) => void
  /** Fire what is due now, and start the schedules of newly enabled revisions from now. */
  readonly sync: () => Promise<void>
  readonly close: () => Promise<void>
}

const MINUTE_MS = 60_000

/**
 * The ticks a workflow owes for the window (`from`, `to`]: each schedule's latest firing in it.
 * Earlier firings in the same window were missed while no process fired the bot's schedules, and
 * are skipped, so a schedule catches up once however long it was down.
 */
const dueTicks = (
  schedules: ReadonlyArray<string>,
  from: Date,
  to: Date,
): ReadonlyArray<ScheduleTick> =>
  schedules
    .flatMap((cron) => {
      const schedule = parseCron(cron)
      // Checked at publish; a parser change could still reject a stored one.
      if ('reason' in schedule) return []
      let latest: Date | undefined
      for (
        let next = nextFiring(schedule, from);
        next !== undefined && next <= to;
        next = nextFiring(schedule, next)
      ) {
        latest = next
      }
      return latest === undefined ? [] : [{ cron, scheduledAt: latest }]
    })
    .sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime())
    .map(({ cron, scheduledAt }) => ({ cron, scheduledAt: scheduledAt.toISOString() }))

/**
 * Fires enabled workflows' cron schedules, once each across every bot host. Each minute it takes
 * a Postgres session advisory lock for every owned bot with schedules, so one process fires each
 * bot's ticks however the hosts disagree about ownership. Then it advances each workflow's cursor
 * to now and fires the ticks between, in that order: a crash in between loses those ticks rather
 * than firing them twice.
 */
export const makeScheduler = ({ storage, clock, fire, log }: SchedulerOptions): Scheduler => {
  let owns: (botId: string) => boolean = () => false
  let closed = false
  let cancel = () => {}
  /** Bots whose lock this process holds. */
  const locked = new Set<string>()
  /** Syncs run one at a time, so locks and cursors move in order. */
  let syncing = Promise.resolve()

  const syncOnce = async () => {
    const now = new Date(clock.date())
    const workflows = (await storage.scheduledWorkflows()).filter(({ botId }) => owns(botId))
    const bots = new Set(workflows.map(({ botId }) => botId))
    for (const botId of locked) {
      if (bots.has(botId)) continue
      locked.delete(botId)
      await storage.unlockSchedules(botId)
    }
    for (const botId of bots) {
      if (await storage.lockSchedules(botId)) locked.add(botId)
      else locked.delete(botId)
    }
    for (const workflow of workflows) {
      const { cursor } = workflow
      if (!locked.has(workflow.botId) || (cursor !== null && now <= cursor)) continue
      // A newly enabled revision starts from now, owing nothing.
      if (!(await storage.advanceScheduleCursor(workflow, cursor, now)) || cursor === null) continue
      for (const tick of dueTicks(workflow.schedules, cursor, now)) fire(workflow, tick)
    }
  }

  const sync = () => {
    syncing = syncing
      .then(syncOnce)
      .catch((error: unknown) => log(`Firing workflow schedules failed: ${String(error)}`))
    return syncing
  }

  /** Sync at the start of every minute, when cron ticks fall due. */
  const wake = () => {
    if (closed) return
    cancel = clock.schedule(() => void sync().then(wake), MINUTE_MS - (clock.date() % MINUTE_MS))
  }

  return {
    start: (accept) => {
      owns = accept
      void sync().then(wake)
    },
    sync,
    close: async () => {
      closed = true
      cancel()
      await syncing
    },
  }
}
