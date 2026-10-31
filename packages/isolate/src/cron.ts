/**
 * Five-field cron, evaluated in UTC.
 *
 * UTC because a server's local zone is not a contract: a schedule that silently shifts by an hour
 * twice a year is a bug an operator cannot see until it fires at the wrong time.
 *
 * Supported per field: `*`, a number, a list (`1,15`), a range (`1-5`), and a step (`*​/5`,
 * `0-30/10`). Names for months and weekdays are not accepted — `JAN` and `MON` invite the
 * question of whose locale, and a number never does.
 */

export interface CronRejection {
  readonly reason: string
}

interface Field {
  readonly min: number
  readonly max: number
  readonly name: string
}

const FIELDS: ReadonlyArray<Field> = [
  { min: 0, max: 59, name: 'minute' },
  { min: 0, max: 23, name: 'hour' },
  { min: 1, max: 31, name: 'day of month' },
  { min: 1, max: 12, name: 'month' },
  // 0 and 7 both mean Sunday, as every cron does.
  { min: 0, max: 7, name: 'day of week' },
]

export interface CronSchedule {
  readonly minutes: ReadonlySet<number>
  readonly hours: ReadonlySet<number>
  readonly daysOfMonth: ReadonlySet<number>
  readonly months: ReadonlySet<number>
  readonly daysOfWeek: ReadonlySet<number>
  /** True when the day-of-month field is unrestricted, which changes how weekdays combine. */
  readonly anyDayOfMonth: boolean
  readonly anyDayOfWeek: boolean
}

const parseField = (raw: string, field: Field): ReadonlySet<number> | CronRejection => {
  const values = new Set<number>()

  for (const term of raw.split(',')) {
    const [rangePart, stepPart] = term.split('/')
    if (rangePart === undefined) return { reason: `Empty term in the ${field.name} field.` }

    const step = stepPart === undefined ? 1 : Number(stepPart)
    if (!Number.isInteger(step) || step < 1) {
      return { reason: `"${stepPart}" is not a step in the ${field.name} field.` }
    }

    let from: number
    let to: number

    if (rangePart === '*') {
      from = field.min
      to = field.max
    } else if (rangePart.includes('-')) {
      const [low, high] = rangePart.split('-')
      from = Number(low)
      to = Number(high)
    } else {
      from = Number(rangePart)
      to = from
    }

    if (!Number.isInteger(from) || !Number.isInteger(to) || from > to) {
      return { reason: `"${term}" is not valid in the ${field.name} field.` }
    }
    if (from < field.min || to > field.max) {
      return {
        reason: `"${term}" is outside ${field.min}–${field.max} in the ${field.name} field.`,
      }
    }

    for (let value = from; value <= to; value += step) values.add(value)
  }

  return values
}

export const parseCron = (expression: string): CronSchedule | CronRejection => {
  const parts = expression.trim().split(/\s+/)
  if (parts.length !== 5) {
    return {
      reason: `A schedule has five fields — minute, hour, day of month, month, day of week — and "${expression}" has ${parts.length}.`,
    }
  }

  const parsed: Array<ReadonlySet<number>> = []
  for (let index = 0; index < FIELDS.length; index += 1) {
    const field = FIELDS[index]
    const raw = parts[index]
    if (field === undefined || raw === undefined) break

    const result = parseField(raw, field)
    if ('reason' in result) return result
    parsed.push(result)
  }

  const [minutes, hours, daysOfMonth, months, daysOfWeekRaw] = parsed
  if (
    minutes === undefined ||
    hours === undefined ||
    daysOfMonth === undefined ||
    months === undefined ||
    daysOfWeekRaw === undefined
  ) {
    return { reason: `"${expression}" could not be parsed.` }
  }

  // 7 and 0 are the same day; normalising here means the matcher does not have to know.
  const daysOfWeek = new Set(daysOfWeekRaw)
  if (daysOfWeek.has(7)) daysOfWeek.add(0)

  return {
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek,
    anyDayOfMonth: parts[2] === '*',
    anyDayOfWeek: parts[4] === '*',
  }
}

/**
 * Whether a schedule fires at a given instant.
 *
 * Day-of-month and day-of-week are OR-ed when both are restricted, which is what every cron does
 * and what people expect from `0 0 1,15 * MON` — surprising, but changing it here would surprise
 * more.
 */
export const matches = (schedule: CronSchedule, at: Date): boolean =>
  schedule.minutes.has(at.getUTCMinutes()) &&
  schedule.hours.has(at.getUTCHours()) &&
  matchesDate(schedule, at)

/** The minimum interval a schedule may fire at, so a workflow cannot be scheduled every minute. */
export const MIN_SCHEDULE_INTERVAL_MINUTES = 5

/**
 * How far ahead to look before calling a schedule unfireable.
 *
 * Four years and a day, not one year: `0 12 29 2 *` is a perfectly good schedule whose next firing
 * can be nearly four years away, and a one-year horizon reports it as never firing.
 */
const SEARCH_DAYS = 4 * 366 + 1

/**
 * The next firing at or after `after`, or undefined if the schedule cannot fire.
 *
 * Day-by-day, then minute-by-minute within a matching day. The arithmetic version is where cron
 * implementations get day-of-week and month length wrong; scanning is slower and right.
 */
export const nextFiring = (schedule: CronSchedule, after: Date): Date | undefined => {
  const candidate = new Date(after)
  candidate.setUTCSeconds(0, 0)
  candidate.setUTCMinutes(candidate.getUTCMinutes() + 1)

  for (let day = 0; day <= SEARCH_DAYS; day += 1) {
    if (matchesDate(schedule, candidate)) {
      // Only the first day starts partway through; every later one starts at midnight.
      const startHour = day === 0 ? candidate.getUTCHours() : 0
      const startMinute = day === 0 ? candidate.getUTCMinutes() : 0

      for (let hour = startHour; hour < 24; hour += 1) {
        if (!schedule.hours.has(hour)) continue
        for (let minute = hour === startHour ? startMinute : 0; minute < 60; minute += 1) {
          if (!schedule.minutes.has(minute)) continue
          return new Date(
            Date.UTC(
              candidate.getUTCFullYear(),
              candidate.getUTCMonth(),
              candidate.getUTCDate(),
              hour,
              minute,
            ),
          )
        }
      }
    }

    candidate.setUTCDate(candidate.getUTCDate() + 1)
    candidate.setUTCHours(0, 0, 0, 0)
  }

  return undefined
}

/** The date half of a match: month, day of month, day of week. */
const matchesDate = (schedule: CronSchedule, at: Date): boolean => {
  if (!schedule.months.has(at.getUTCMonth() + 1)) return false

  const dayOfMonth = schedule.daysOfMonth.has(at.getUTCDate())
  const dayOfWeek = schedule.daysOfWeek.has(at.getUTCDay())

  if (schedule.anyDayOfMonth && schedule.anyDayOfWeek) return true
  if (schedule.anyDayOfMonth) return dayOfWeek
  if (schedule.anyDayOfWeek) return dayOfMonth
  return dayOfMonth || dayOfWeek
}

/**
 * Reject a schedule that would fire more often than the floor allows.
 *
 * Checked by looking at actual firings rather than by pattern-matching the expression: `*​/1` and
 * `0,1,2,...` are the same schedule, and only one of them looks suspicious.
 */
export const checkScheduleFloor = (
  schedule: CronSchedule,
  from: Date,
): CronRejection | undefined => {
  let previous = nextFiring(schedule, from)
  if (previous === undefined) return undefined

  for (let count = 0; count < 10; count += 1) {
    const next = nextFiring(schedule, previous)
    if (next === undefined) return undefined

    const gapMinutes = (next.getTime() - previous.getTime()) / 60_000
    if (gapMinutes < MIN_SCHEDULE_INTERVAL_MINUTES) {
      return {
        reason: `This schedule fires every ${gapMinutes} minutes, under the ${MIN_SCHEDULE_INTERVAL_MINUTES}-minute floor. A workflow that runs this often will exhaust its action budget rather than keep up.`,
      }
    }
    previous = next
  }

  return undefined
}
