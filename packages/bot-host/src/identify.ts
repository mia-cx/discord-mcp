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
  /** Spend one Identify from the bot's budget and return 0, or return the wait until it reopens. */
  readonly spend: () => number
  /**
   * Call `identify` once shard `shardId`'s concurrency bucket is free, at once if it is free now.
   * Shards in a bucket identify in the order they asked. The returned function withdraws the ask.
   */
  readonly whenFree: (shardId: number, identify: () => void) => () => void
}

/**
 * Discord resets a bot's token once it spends its daily Identifies. The gate spends at most half
 * of what remains, leaving the rest to the bot's other clients and to the next process.
 */
export const createIdentifyGate = (clock: Clock, limit: SessionStartLimit): IdentifyGate => {
  let allowance = Math.floor(limit.remaining / 2)
  let resetsAt = clock.now() + limit.resetAfter
  /** When each concurrency bucket next frees. */
  const freeAt = new Map<number, number>()
  return {
    spend: () => {
      const now = clock.now()
      if (now >= resetsAt) {
        allowance = Math.floor(limit.total / 2)
        resetsAt = now + DAY_MS
      }
      if (allowance === 0) return resetsAt - now
      allowance -= 1
      return 0
    },
    whenFree: (shardId, identify) => {
      const bucket = shardId % limit.maxConcurrency
      const now = clock.now()
      const at = Math.max(now, freeAt.get(bucket) ?? now)
      // A withdrawn ask keeps its slot, delaying the bucket by at most one interval.
      freeAt.set(bucket, at + IDENTIFY_INTERVAL_MS)
      if (at === now) {
        identify()
        return () => {}
      }
      return clock.schedule(identify, at - now)
    },
  }
}
