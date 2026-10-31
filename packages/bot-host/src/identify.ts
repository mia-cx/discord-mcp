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

/** Paces one bot's Identifies across all its shards. */
export interface IdentifyGate {
  /** 0 while the bot has Identifies left today, otherwise the wait until its budget reopens. */
  readonly budgetWait: () => number
  /**
   * Call `identify` once shard `shardId`'s concurrency bucket is free, at once if it is free now,
   * and charge it to the budget. Shards in a bucket identify in the order they asked. The
   * returned function withdraws the ask.
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
 * Discord resets a bot's token once it spends its daily Identifies. The gate spends about half of
 * what remains, leaving the rest to the bot's other clients and to the next process. Shards that
 * passed `budgetWait` before it ran out still identify, so it can overspend by one per shard.
 */
export const createIdentifyGate = (clock: Clock, limit: SessionStartLimit): IdentifyGate => {
  let allowance = Math.floor(limit.remaining / 2)
  let resetsAt = clock.now() + limit.resetAfter
  const buckets = new Map<number, Bucket>()
  /** Reopen the budget once Discord's window resets. Returns the current time. */
  const refill = () => {
    const now = clock.now()
    if (now >= resetsAt) {
      allowance = Math.floor(limit.total / 2)
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
    refill()
    allowance -= 1
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
    budgetWait: () => {
      const now = refill()
      return allowance > 0 ? 0 : resetsAt - now
    },
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
