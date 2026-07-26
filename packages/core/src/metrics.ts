import { Context, Effect, Layer, Ref } from 'effect'

/**
 * Operational counters and timings.
 *
 * Deliberately in-process and unexported to any wire format. This deployment is a single control
 * plane on one host; a metrics *backend* would be infrastructure an operator has to run, and the
 * question these answer — "is the thing wedged, and where" — is answerable from a tool call.
 *
 * `metrics_snapshot` reads them. Nothing here is authoritative: the audit log records what
 * happened, and these record how much and how fast.
 */

export interface MetricsSnapshot {
  readonly counters: Readonly<Record<string, number>>
  /** Milliseconds, as count / total / max — enough to spot a regression without storing samples. */
  readonly timings: Readonly<
    Record<string, { readonly count: number; readonly totalMs: number; readonly maxMs: number }>
  >
  readonly since: number
}

interface Timing {
  readonly count: number
  readonly totalMs: number
  readonly maxMs: number
}

/**
 * The metric names this system reports.
 *
 * Enumerated rather than free-form: a typo in a metric name produces a counter nobody is watching,
 * which looks exactly like a system where nothing is happening.
 */
export type CounterName =
  | 'discord.request'
  | 'discord.request.failed'
  | 'discord.rate_limit_wait'
  | 'discord.rate_guard_trip'
  | 'gateway.reconnect'
  | 'gateway.event'
  | 'interaction.received'
  | 'interaction.deferred'
  | 'interaction.deadline_missed'
  | 'workflow.queued'
  | 'workflow.queue_overflow'
  | 'workflow.execution.succeeded'
  | 'workflow.execution.failed'
  | 'workflow.execution.timeout'
  | 'workflow.execution.killed'
  | 'workflow.capability.denied'
  | 'sandbox.build.succeeded'
  | 'sandbox.build.failed'
  | 'sandbox.policy_violation'
  | 'blueprint.apply.succeeded'
  | 'blueprint.apply.failed'
  | 'route.request'
  | 'route.auth_failed'
  | 'oauth.refresh_failed'

export type TimingName =
  | 'discord.request'
  | 'workflow.execution'
  | 'sandbox.build'
  | 'blueprint.apply'
  | 'route.request'

export class Metrics extends Context.Service<
  Metrics,
  {
    readonly increment: (name: CounterName, by?: number) => Effect.Effect<void>
    readonly observe: (name: TimingName, ms: number) => Effect.Effect<void>
    /** Wrap an effect so its duration and outcome are both recorded. */
    readonly time: <A, E, R>(
      name: TimingName,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>
    readonly snapshot: Effect.Effect<MetricsSnapshot>
  }
>()('core/Metrics') {
  static readonly layer = Layer.effect(Metrics)(
    Effect.gen(function* () {
      const started = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
      const counters = yield* Ref.make<ReadonlyMap<string, number>>(new Map())
      const timings = yield* Ref.make<ReadonlyMap<string, Timing>>(new Map())

      const observe = (name: TimingName, ms: number) =>
        Ref.update(timings, (current) => {
          const existing = current.get(name) ?? { count: 0, totalMs: 0, maxMs: 0 }
          return new Map(current).set(name, {
            count: existing.count + 1,
            totalMs: existing.totalMs + ms,
            maxMs: Math.max(existing.maxMs, ms),
          })
        })

      return {
        increment: (name, by = 1) =>
          Ref.update(counters, (current) =>
            new Map(current).set(name, (current.get(name) ?? 0) + by),
          ),

        observe,

        time: (name, effect) =>
          Effect.gen(function* () {
            const start = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
            // `ensuring` so a failed or interrupted call is still timed. Recording only successes
            // would hide exactly the case someone is investigating.
            return yield* Effect.ensuring(
              effect,
              Effect.flatMap(
                Effect.clockWith((clock) => clock.currentTimeMillis),
                (end) => observe(name, end - start),
              ),
            )
          }),

        snapshot: Effect.gen(function* () {
          const currentCounters = yield* Ref.get(counters)
          const currentTimings = yield* Ref.get(timings)

          return {
            counters: Object.fromEntries(currentCounters),
            timings: Object.fromEntries(currentTimings),
            since: started,
          }
        }),
      }
    }),
  )

  /**
   * A no-op, for tests and for code paths that run before the layer exists.
   *
   * Metrics are diagnostic: nothing should behave differently because they are absent, and a
   * missing metrics layer should never be able to fail a request.
   */
  static readonly noop = Layer.sync(Metrics)(() => ({
    increment: () => Effect.void,
    observe: () => Effect.void,
    time: (_name, effect) => effect,
    snapshot: Effect.succeed({ counters: {}, timings: {}, since: 0 }),
  }))
}

/**
 * Increment without requiring the service.
 *
 * Used on paths that are already deep in another package's dependency graph, where threading a
 * requirement through would mean touching every caller for a counter.
 */
export const countIfAvailable = (name: CounterName, by = 1): Effect.Effect<void> =>
  Effect.flatMap(Effect.serviceOption(Metrics), (metrics) =>
    metrics._tag === 'Some' ? metrics.value.increment(name, by) : Effect.void,
  )
