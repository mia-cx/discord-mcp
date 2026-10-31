import type { Clock } from './clock.ts'

/** Discord allows one Identify per five seconds in each concurrency bucket. */
const IDENTIFY_INTERVAL_MS = 5_000
const DAY_MS = 24 * 60 * 60 * 1000

/** A bot's Identify limits, from `session_start_limit` in `GET /gateway/bot`. */
export interface SessionStartLimit {
  /** Identifies Discord allows per 24 hours. */
  readonly total: number
  readonly remaining: number
  /** Milliseconds until `remaining` resets to `total`. */
  readonly resetAfter: number
  /** Shards that may identify at once: one per bucket of shard ID modulo this. */
  readonly maxConcurrency: number
}

/** One Identify taken from a bot's daily budget, held until it is sent or given back. */
export interface Reservation {
  /** The Identify went out. */
  readonly spend: () => void
  /** The connection closed before it identified, so the Identify returns to the budget. */
  readonly release: () => void
}

/** Paces one bot's Identifies across all its shards. */
export interface IdentifyGate {
  /** Take one Identify from the bot's daily budget, or `undefined` when it is spent. */
  readonly reserve: () => Reservation | undefined
  /** Milliseconds until a spent budget reopens. */
  readonly reopensIn: () => number
  /**
   * Call `identify` once shard `shardId`'s concurrency bucket is free, at once if it is free now.
   * Shards in a bucket identify in the order they asked. The returned function withdraws the ask.
   */
  readonly whenFree: (shardId: number, identify: () => void) => () => void
}

interface Bucket {
  /** Shards waiting to identify, first come first served. */
  readonly waiting: Array<() => void>
  freeAt: number
  /** Cancels the wake-up for the first waiting shard. */
  cancel: () => void
}

/**
 * Discord resets a bot's token once it spends its daily Identifies. The gate reserves at most half
 * of what remains, leaving the rest to the bot's other clients and to the next process.
 */
export const createIdentifyGate = (clock: Clock, limit: SessionStartLimit): IdentifyGate => {
  let allowance = Math.floor(limit.remaining / 2)
  let resetsAt = clock.now() + limit.resetAfter
  /** Reservations not yet sent or given back. */
  let held = 0
  const buckets = new Map<number, Bucket>()
  /**
   * Reopen the budget once Discord's window resets. Held reservations will be sent in the new
   * window, so they count against it. Returns the current time.
   */
  const refill = () => {
    const now = clock.now()
    if (now >= resetsAt) {
      allowance = Math.floor(limit.total / 2) - held
      resetsAt = now + DAY_MS
    }
    return now
  }
  // Identify the bucket's next shard if it is free, else wake when it frees. Spacing counts from
  // each Identify actually sent, so timers that fire late never send two at once.
  const drain = (bucket: Bucket) => {
    const [next] = bucket.waiting
    if (next === undefined) return
    const now = clock.now()
    if (now < bucket.freeAt) {
      bucket.cancel = clock.schedule(() => drain(bucket), bucket.freeAt - now)
      return
    }
    bucket.waiting.shift()
    bucket.freeAt = now + IDENTIFY_INTERVAL_MS
    next()
    drain(bucket)
  }
  const bucketOf = (shardId: number) => {
    const key = shardId % limit.maxConcurrency
    const bucket = buckets.get(key) ?? {
      waiting: [],
      freeAt: Number.NEGATIVE_INFINITY,
      cancel: () => {},
    }
    buckets.set(key, bucket)
    return bucket
  }
  return {
    reserve: () => {
      refill()
      if (allowance === 0) return undefined
      allowance -= 1
      held += 1
      let settled = false
      const settle = (refund: boolean) => {
        if (settled) return
        settled = true
        held -= 1
        if (refund) allowance += 1
      }
      return { spend: () => settle(false), release: () => settle(true) }
    },
    reopensIn: () => resetsAt - refill(),
    whenFree: (shardId, identify) => {
      const bucket = bucketOf(shardId)
      // Its own function, so withdrawing removes this ask and no other.
      const ask = () => identify()
      bucket.waiting.push(ask)
      if (bucket.waiting.length === 1) drain(bucket)
      return () => {
        const index = bucket.waiting.indexOf(ask)
        if (index === -1) return
        bucket.waiting.splice(index, 1)
        if (index > 0) return
        bucket.cancel()
        drain(bucket)
      }
    },
  }
}
