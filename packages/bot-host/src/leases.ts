import { randomUUID } from 'node:crypto'
import type { Storage } from '@discord-mcp/storage'
import type { Clock } from './clock.ts'

/** How long a lease lasts without renewal: a dead host's work moves after at most this long. */
export const LEASE_TTL_MS = 15_000
/**
 * A holder stops relying on a lease this long before it expires, so another host that claims it
 * on a clock running up to this far ahead still never overlaps.
 */
const SKEW_MARGIN_MS = 5_000

/** This process's leases in Postgres, which keep each piece of work on one process at a time. */
export interface Leases {
  /** This process, as lease holder. */
  readonly holder: string
  /** Claim `name`, or extend it if this process holds it. Resolves whether it holds it now. */
  readonly claim: (name: string) => Promise<boolean>
  /** Whether this process holds `name` and renewed it recently enough to rely on. */
  readonly holds: (name: string) => boolean
  /** The names of the leases this process holds. */
  readonly names: () => ReadonlyArray<string>
  /** Extend every lease this process holds; any it lost go to `onLost`. */
  readonly renew: () => Promise<void>
  readonly release: (name: string) => Promise<void>
  /**
   * Take `name` for `ms` if nobody holds it, this process included. Resolves 0 once taken, or the
   * milliseconds until the current holder's turn ends. Never renewed or released.
   */
  readonly take: (name: string, ms: number) => Promise<number>
  /** The names of live leases starting with `prefix`, whoever holds them. */
  readonly live: (prefix: string) => Promise<ReadonlyArray<string>>
  /** Give up every lease this process holds. */
  readonly close: () => Promise<void>
}

/**
 * `onLost` hears each lease this process can no longer rely on: another process took it, or it
 * could not be renewed in time. It is called before the lease expires for anyone else. Leases
 * last `ttlMs` without renewal.
 */
export const createLeases = (
  storage: Storage,
  clock: Clock,
  onLost: (name: string) => void,
  ttlMs = LEASE_TTL_MS,
): Leases => {
  const holder = randomUUID()
  /** Held leases, each with the time until which it may be relied on. */
  const held = new Map<string, { until: number }>()
  let turns = 0
  let cancelLapse = () => {}

  // Wake when the first held lease lapses, so a hung renewal still gives the lease up in time.
  const lapse = () => {
    cancelLapse()
    const now = clock.date()
    for (const [name, { until }] of held) {
      if (until > now) continue
      held.delete(name)
      onLost(name)
    }
    if (held.size === 0) return
    const next = Math.min(...[...held.values()].map(({ until }) => until))
    cancelLapse = clock.schedule(lapse, next - now)
  }
  const reliableUntil = (since: number) => since + ttlMs - SKEW_MARGIN_MS

  return {
    holder,
    claim: async (name) => {
      const since = clock.date()
      const lease = await storage.claimLease(name, holder, since, ttlMs)
      if (lease.holder !== holder) return false
      held.set(name, { until: reliableUntil(since) })
      // An answer slow enough to outlast the reliable window holds nothing.
      lapse()
      return held.has(name)
    },
    holds: (name) => (held.get(name)?.until ?? 0) > clock.date(),
    names: () => [...held.keys()],
    renew: async () => {
      const since = clock.date()
      const before = [...held]
      // Only these: a lease whose release failed must expire, not stay renewed with nobody on it.
      const names = before.map(([name]) => name)
      const renewed = new Set(await storage.renewLeases(holder, names, since, ttlMs))
      for (const [name, lease] of before) {
        // Claimed again or released while renewing: that answer is newer than this one.
        if (held.get(name) !== lease) continue
        if (renewed.has(name)) {
          lease.until = reliableUntil(since)
        } else {
          held.delete(name)
          onLost(name)
        }
      }
      lapse()
    },
    release: async (name) => {
      held.delete(name)
      lapse()
      await storage.releaseLease(name, holder)
    },
    take: async (name, ms) => {
      turns += 1
      const turn = `${holder}#${turns}`
      const now = clock.date()
      const lease = await storage.claimLease(name, turn, now, ms)
      return lease.holder === turn ? 0 : Math.max(lease.expiresAt - now, 0)
    },
    live: (prefix) => storage.liveLeases(prefix, clock.date()),
    close: async () => {
      cancelLapse()
      held.clear()
      await storage.releaseLeases(holder)
    },
  }
}
