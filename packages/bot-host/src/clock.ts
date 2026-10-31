/** The time and randomness the bot host depends on, injectable so tests control both. */
export interface Clock {
  /** Milliseconds on a monotonic clock. */
  readonly now: () => number
  /** Run `callback` after `ms`; the returned function cancels it. */
  readonly schedule: (callback: () => void, ms: number) => () => void
  /** A number in [0, 1), like `Math.random`. */
  readonly random: () => number
}

export const systemClock: Clock = {
  now: () => performance.now(),
  schedule: (callback, ms) => {
    const timer = setTimeout(callback, ms)
    return () => clearTimeout(timer)
  },
  random: Math.random,
}
