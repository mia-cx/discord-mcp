import { RateGuardTrippedError } from '@discord-mcp/core'
import { Context, Effect, Layer, Ref } from 'effect'

/**
 * Cloudflare bans the source IP after 10,000 401/403/429 responses in 10 minutes. The default
 * threshold here is three orders of magnitude below that, because the failure mode is not gradual
 * drift — it is an agent in a tight retry loop, which reaches thousands in minutes.
 */
export const DEFAULT_FAILURE_THRESHOLD = 25
export const DEFAULT_WINDOW_MS = 10 * 60 * 1000

export interface RateGuardConfig {
  readonly threshold: number
  readonly windowMs: number
}

export const defaultRateGuardConfig: RateGuardConfig = {
  threshold: DEFAULT_FAILURE_THRESHOLD,
  windowMs: DEFAULT_WINDOW_MS,
}

/** Rejections are counted per auth-profile and operation family, so one bad call site trips alone. */
export const rateGuardScope = (authProfile: string, operationFamily: string): string =>
  `${authProfile}/${operationFamily}`

interface GuardState {
  /** Monotonic timestamps of counted rejections, oldest first. */
  readonly rejections: ReadonlyMap<string, ReadonlyArray<number>>
}

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
    /** Fails with `RateGuardTrippedError` when the scope is already over threshold. */
    readonly check: (scope: string) => Effect.Effect<void, RateGuardTrippedError>
    /** Record a 401/403/429. Other statuses must not be counted — 400s are free. */
    readonly recordRejection: (scope: string) => Effect.Effect<void>
    readonly failureCount: (scope: string) => Effect.Effect<number>
  }
>()('discord-api/RateGuard') {
  static readonly layer = (config: RateGuardConfig = defaultRateGuardConfig) =>
    Layer.effect(RateGuard)(
      Effect.gen(function* () {
        const state = yield* Ref.make<GuardState>({ rejections: new Map() })

        const liveCount = (scope: string) =>
          Effect.map(
            Effect.all([Ref.get(state), Effect.clockWith((c) => c.currentTimeMillis)]),
            ([s, now]) => {
              const cutoff = now - config.windowMs
              return (s.rejections.get(scope) ?? []).filter((t) => t > cutoff).length
            },
          )

        return {
          failureCount: liveCount,

          check: (scope) =>
            Effect.flatMap(liveCount(scope), (count) =>
              count < config.threshold
                ? Effect.void
                : Effect.fail(
                    new RateGuardTrippedError({
                      message: `Blocked before sending: ${count} rejected Discord responses for ${scope} within the last ${Math.round(config.windowMs / 60_000)} minutes.`,
                      scope,
                      failures: count,
                      windowMs: config.windowMs,
                    }),
                  ),
            ),

          recordRejection: (scope) =>
            Effect.flatMap(
              Effect.clockWith((c) => c.currentTimeMillis),
              (now) =>
                Ref.update(state, (s) => {
                  const cutoff = now - config.windowMs
                  const kept = (s.rejections.get(scope) ?? []).filter((t) => t > cutoff)
                  const next = new Map(s.rejections)
                  next.set(scope, [...kept, now])
                  return { rejections: next }
                }),
            ),
        }
      }),
    )
}

/** Statuses that count toward the ban budget. 400s are free and must not be recorded. */
export const isCountedRejection = (status: number): boolean =>
  status === 401 || status === 403 || status === 429
