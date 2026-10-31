/** The time and randomness the bot host depends on, injectable so tests control both. */
export interface Clock {
  /** Milliseconds on a monotonic clock. */
  readonly now: () => number
  /** Milliseconds since the Unix epoch, for what happens at a time of day, like cron schedules. */
  readonly date: () => number
  /** Run `callback` after `ms`; the returned function cancels it. */
  readonly schedule: (callback: () => void, ms: number) => () => void
  /** A number in [0, 1), like `Math.random`. */
  readonly random: () => number
}

export const systemClock: Clock = {
  now: () => performance.now(),
  date: () => Date.now(),
  schedule: (callback, ms) => {
    const timer = setTimeout(callback, ms)
    return () => clearTimeout(timer)
  },
  random: Math.random,
}
