import { RateGuardTrippedError } from '@discord-mcp/core'
import { Context, Effect, Layer } from 'effect'

/**
 * Cloudflare bans the source IP after 10,000 401/403/429 responses in 10 minutes. The default
 * threshold here is three orders of magnitude below that, because the failure mode is not gradual
 * drift — it is an agent in a tight retry loop, which reaches thousands in minutes.
 */
export const DEFAULT_FAILURE_THRESHOLD = 25
/** Every caller in one process shares its IP, so their rejections together stay an order below. */
export const DEFAULT_PROCESS_THRESHOLD = 1_000
export const DEFAULT_WINDOW_MS = 10 * 60 * 1000

export interface RateGuardConfig {
  readonly threshold: number
  readonly processThreshold: number
  readonly windowMs: number
}

export const defaultRateGuardConfig: RateGuardConfig = {
  threshold: DEFAULT_FAILURE_THRESHOLD,
  processThreshold: DEFAULT_PROCESS_THRESHOLD,
  windowMs: DEFAULT_WINDOW_MS,
}

/** Rejections are counted per credential and operation family, so one bad call site trips alone. */
export const rateGuardScope = (credential: string, operationFamily: string): string =>
  `${credential}/${operationFamily}`

/** The scope that totals every rejection the process records. */
const PROCESS_SCOPE = 'process'

/**
 * Timestamps of counted rejections in a rolling window. Create one per process and hand it to every
 * `RateGuard.layer` and to the login routes: Cloudflare counts every request from the IP together.
 */
export const rejectionLog = (config: RateGuardConfig = defaultRateGuardConfig) => {
  const rejections = new Map<string, ReadonlyArray<number>>()
  const live = (scope: string, now: number) => {
    const kept = (rejections.get(scope) ?? []).filter((t) => t > now - config.windowMs)
    if (kept.length === 0) rejections.delete(scope)
    else rejections.set(scope, kept)
    return kept.length
  }
  return {
    count: live,
    /** The over-threshold scope and its count when a call in `scope` must not be sent. */
    refusal: (scope: string, now: number) => {
      const count = live(scope, now)
      if (count >= config.threshold) return { scope, count }
      const total = live(PROCESS_SCOPE, now)
      return total >= config.processThreshold ? { scope: PROCESS_SCOPE, count: total } : undefined
    },
    /** Record a 401/403/429. Other statuses must not be counted — 400s are free. */
    record: (scope: string, now: number) => {
      // Pruning every scope keeps the map bounded by the live rejections the thresholds allow.
      for (const known of [...rejections.keys()]) live(known, now)
      for (const target of [scope, PROCESS_SCOPE]) {
        rejections.set(target, [...(rejections.get(target) ?? []), now])
      }
    },
  }
}

export type RejectionLog = ReturnType<typeof rejectionLog>

/**
 * A rolling circuit breaker over repeated 401/403/429 responses.
 *
 * Tripping stops outbound calls and tells the agent to diagnose permissions or credentials rather
 * than retry. It does not reset on success: a loop that alternates between a working call and a
 * failing one still walks toward the ban.
 */
export class RateGuard extends Context.Service<
  RateGuard,
  {
    /** Fails with `RateGuardTrippedError` when the scope or the process is already over threshold. */
    readonly check: (scope: string) => Effect.Effect<void, RateGuardTrippedError>
    /** Record a 401/403/429. Other statuses must not be counted — 400s are free. */
    readonly recordRejection: (scope: string) => Effect.Effect<void>
    readonly failureCount: (scope: string) => Effect.Effect<number>
  }
>()('discord-api/RateGuard') {
  /** Pass a shared `log` to count across runtimes, such as one per HTTP request. */
  static readonly layer = (
    config: RateGuardConfig = defaultRateGuardConfig,
    log: RejectionLog = rejectionLog(config),
  ) => {
    const now = Effect.clockWith((clock) => clock.currentTimeMillis)
    return Layer.succeed(RateGuard)({
      failureCount: (scope) => Effect.map(now, (time) => log.count(scope, time)),
      check: (scope) =>
        Effect.flatMap(now, (time) => {
          const refusal = log.refusal(scope, time)
          return refusal === undefined
            ? Effect.void
            : Effect.fail(
                new RateGuardTrippedError({
                  message: `Blocked before sending: ${refusal.count} rejected Discord responses for ${refusal.scope} within the last ${Math.round(config.windowMs / 60_000)} minutes.`,
                  scope: refusal.scope,
                  failures: refusal.count,
                  windowMs: config.windowMs,
                }),
              )
        }),
      recordRejection: (scope) => Effect.map(now, (time) => log.record(scope, time)),
    })
  }
}

/** Statuses that count toward the ban budget. 400s are free and must not be recorded. */
export const isCountedRejection = (status: number): boolean =>
  status === 401 || status === 403 || status === 429
