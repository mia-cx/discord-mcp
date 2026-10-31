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

/** Statuses that count toward the ban budget. 400s are free and must not be recorded. */
export const isCountedRejection = (status: number): boolean =>
  status === 401 || status === 403 || status === 429

/** A refused call names the scope over threshold; an admitted one is settled with its status. */
export type Admission =
  | { readonly refused: { readonly scope: string; readonly count: number } }
  | { readonly settle: (status: number, now: number) => void }

/**
 * Timestamps of counted rejections in a rolling window. Create one per process and hand it to every
 * `RateGuard.layer` and to the login routes: Cloudflare counts every request from the IP together.
 */
export const rejectionLog = (config: RateGuardConfig = defaultRateGuardConfig) => {
  const rejections = new Map<string, ReadonlyArray<number>>()
  const pending = new Map<string, number>()
  const live = (scope: string, now: number) => {
    const kept = (rejections.get(scope) ?? []).filter((t) => t > now - config.windowMs)
    if (kept.length === 0) rejections.delete(scope)
    else rejections.set(scope, kept)
    return kept.length
  }
  const adjust = (scopes: ReadonlyArray<string>, delta: number) => {
    for (const scope of scopes) {
      const next = (pending.get(scope) ?? 0) + delta
      if (next === 0) pending.delete(scope)
      else pending.set(scope, next)
    }
  }
  return {
    count: live,
    /**
     * Admit one Discord call counted in every scope and the process. Until it settles it counts as a
     * rejection, so concurrent calls cannot all pass a threshold that only finished calls reach.
     */
    admit: (scopes: ReadonlyArray<string>, now: number): Admission => {
      const all = [...scopes, PROCESS_SCOPE]
      for (const scope of all) {
        const count = live(scope, now) + (pending.get(scope) ?? 0)
        const limit = scope === PROCESS_SCOPE ? config.processThreshold : config.threshold
        if (count >= limit) return { refused: { scope, count } }
      }
      adjust(all, 1)
      let open = true
      return {
        // Settling twice is a no-op, so callers can settle again on every exit path.
        settle: (status, at) => {
          if (!open) return
          open = false
          adjust(all, -1)
          if (!isCountedRejection(status)) return
          // Pruning every scope keeps the map bounded by the live rejections the thresholds allow.
          for (const known of [...rejections.keys()]) live(known, at)
          for (const scope of all) rejections.set(scope, [...(rejections.get(scope) ?? []), at])
        },
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
    /**
     * Admit one call in `scopes`, or fail with `RateGuardTrippedError` when a scope or the process
     * is over threshold. Settle the admitted call with Discord's status; 0 means no response.
     */
    readonly admit: (
      scopes: ReadonlyArray<string>,
    ) => Effect.Effect<(status: number) => Effect.Effect<void>, RateGuardTrippedError>
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
      admit: (scopes) =>
        Effect.flatMap(now, (time) => {
          const admission = log.admit(scopes, time)
          if ('settle' in admission) {
            return Effect.succeed((status: number) =>
              Effect.map(now, (at) => admission.settle(status, at)),
            )
          }
          const { scope, count } = admission.refused
          return Effect.fail(
            new RateGuardTrippedError({
              message: `Blocked before sending: ${count} rejected or pending Discord responses for ${scope} within the last ${Math.round(config.windowMs / 60_000)} minutes.`,
              scope,
              failures: count,
              windowMs: config.windowMs,
            }),
          )
        }),
    })
  }
}
