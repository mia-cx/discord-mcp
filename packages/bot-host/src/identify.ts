import type { Clock } from './clock.ts'

/** Discord allows one Identify per five seconds in each concurrency bucket. */
export const IDENTIFY_INTERVAL_MS = 5_000
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
  /** Asking other hosts for the bucket's turn. */
  claiming: boolean
  /** Cancels the wake-up for the first waiting shard. */
  cancel: () => void
}

/** Turns at identifying, shared with every other host running the bot's shards. */
export interface SharedTurns {
  /** How long each turn lasts: Discord's five seconds and some to spare. */
  readonly ms: number
  /**
   * Take a bucket's turn. Resolves 0 once taken, or the milliseconds until the current turn
   * ends. Never rejects.
   */
  readonly claim: (bucket: number) => Promise<number>
}

/**
 * Discord resets a bot's token once it spends its daily Identifies. The gate reserves at most half
 * of what remains, leaving the rest to the bot's other clients and to the next process. With
 * `turns`, each turn is also taken from other hosts identifying the bot's other shards.
 */
export const createIdentifyGate = (
  clock: Clock,
  limit: SessionStartLimit,
  turns?: SharedTurns,
): IdentifyGate => {
  const spacingMs = turns?.ms ?? IDENTIFY_INTERVAL_MS
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
  const drain = (key: number, bucket: Bucket) => {
    if (bucket.waiting.length === 0 || bucket.claiming) return
    const now = clock.now()
    if (now < bucket.freeAt) {
      bucket.cancel = clock.schedule(() => drain(key, bucket), bucket.freeAt - now)
      return
    }
    if (turns === undefined) return identify(key, bucket)
    bucket.claiming = true
    void turns.claim(key).then((waitMs) => {
      bucket.claiming = false
      if (waitMs === 0) return identify(key, bucket)
      bucket.freeAt = clock.now() + waitMs
      drain(key, bucket)
    })
  }
  const identify = (key: number, bucket: Bucket) => {
    bucket.freeAt = clock.now() + spacingMs
    // A shard withdrawn while claiming leaves the turn to the next, if any.
    bucket.waiting.shift()?.()
    drain(key, bucket)
  }
  const bucketOf = (shardId: number) => {
    const key = shardId % limit.maxConcurrency
    const bucket = buckets.get(key) ?? {
      waiting: [],
      freeAt: Number.NEGATIVE_INFINITY,
      claiming: false,
      cancel: () => {},
    }
    buckets.set(key, bucket)
    return { key, bucket }
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
        // A reset this reservation waited through must charge it before it stops being held.
        refill()
        held -= 1
        if (refund) allowance += 1
      }
      return { spend: () => settle(false), release: () => settle(true) }
    },
    reopensIn: () => resetsAt - refill(),
    whenFree: (shardId, send) => {
      const { key, bucket } = bucketOf(shardId)
      // Its own function, so withdrawing removes this ask and no other.
      const ask = () => send()
      bucket.waiting.push(ask)
      if (bucket.waiting.length === 1) drain(key, bucket)
      return () => {
        const index = bucket.waiting.indexOf(ask)
        if (index === -1) return
        bucket.waiting.splice(index, 1)
        if (index > 0) return
        bucket.cancel()
        drain(key, bucket)
      }
    },
  }
}
