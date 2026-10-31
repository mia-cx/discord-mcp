import { Clock, Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { mapDiscordError } from '../src/errors.ts'
import { isCountedRejection, RateGuard, rateGuardScope } from '../src/rate-guard.ts'

const config = { threshold: 3, processThreshold: 5, windowMs: 60_000 }
const scope = rateGuardScope('bot', 'guild')

let now = 1_700_000_000_000
const fakeClock: Clock.Clock = {
  currentTimeMillisUnsafe: () => now,
  currentTimeMillis: Effect.sync(() => now),
  currentTimeNanosUnsafe: () => BigInt(now) * 1_000_000n,
  currentTimeNanos: Effect.sync(() => BigInt(now) * 1_000_000n),
  sleep: () => Effect.void,
}

const run = <A, E>(effect: Effect.Effect<A, E, RateGuard>) =>
  Effect.runPromise(Effect.provide(effect, RateGuard.layer(config)) as Effect.Effect<A, E>)

/** Send one call in `scope` that Discord answers with `status`. */
const call = (scope: string, status: number) =>
  Effect.flatMap(RateGuard, (guard) =>
    Effect.flatMap(guard.admit([scope]), (settle) => settle(status)),
  )

describe('RateGuard', () => {
  it('permits calls below the threshold', async () => {
    const count = await run(
      Effect.gen(function* () {
        yield* call(scope, 403)
        yield* call(scope, 403)
        yield* call(scope, 200)
        return yield* Effect.flatMap(RateGuard, (guard) => guard.failureCount(scope))
      }),
    )
    expect(count).toBe(2)
  })

  it('trips at the threshold and refuses to send', async () => {
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        Effect.gen(function* () {
          for (let i = 0; i < 3; i++) yield* call(scope, 403)
          yield* call(scope, 200)
        }),
        RateGuard.layer(config),
      ),
    )

    expect(exit._tag).toBe('Failure')
  })

  it('counts calls still awaiting Discord, so a parallel burst cannot pass the threshold', async () => {
    const exit = await run(
      Effect.gen(function* () {
        const guard = yield* RateGuard
        for (let i = 0; i < 3; i++) yield* guard.admit([scope])
        return yield* Effect.exit(guard.admit([scope]))
      }),
    )
    expect(exit._tag).toBe('Failure')
  })

  it('counts a call that never answered, since a cancelled request may still reach Discord', async () => {
    const count = await run(
      Effect.gen(function* () {
        yield* call(scope, 0)
        return yield* Effect.flatMap(RateGuard, (guard) => guard.failureCount(scope))
      }),
    )
    expect(count).toBe(1)
  })

  it('counts each credential and family separately, so one bad call site trips alone', async () => {
    const counts = await run(
      Effect.gen(function* () {
        for (let i = 0; i < 3; i++) yield* call(rateGuardScope('bot', 'guild'), 403)
        // A different family must still be allowed through.
        yield* call(rateGuardScope('bot', 'channel'), 200)
        yield* call(rateGuardScope('oauth2', 'guild'), 200)
        return yield* Effect.flatMap(RateGuard, (guard) =>
          guard.failureCount(rateGuardScope('bot', 'channel')),
        )
      }),
    )
    expect(counts).toBe(0)
  })

  it('trips for every scope once the process total reaches its own threshold', async () => {
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        Effect.gen(function* () {
          for (let i = 0; i < 5; i++) yield* call(rateGuardScope(`bot-${i}`, 'guild'), 401)
          yield* call(rateGuardScope('fresh', 'guild'), 200)
        }),
        RateGuard.layer(config),
      ),
    )
    expect(exit._tag).toBe('Failure')
  })

  it('forgets rejections once they leave the window', async () => {
    // v4 core ships no TestClock, and the guard reads time through the Clock reference, so a
    // hand-wound clock is both sufficient and faster than actually waiting out a 60s window.
    const count = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          for (let i = 0; i < 3; i++) yield* call(scope, 403)
          now += 2 * 60_000
          // The breaker is rolling, not latching: a quiet period restores service.
          yield* call(scope, 200)
          return yield* Effect.flatMap(RateGuard, (guard) => guard.failureCount(scope))
        }),
        RateGuard.layer(config),
      ).pipe(Effect.provideService(Clock.Clock, fakeClock)),
    )
    expect(count).toBe(0)
  })
})

describe('isCountedRejection', () => {
  it('counts only what Cloudflare counts', () => {
    // 400s are free against the ban budget; counting them would trip the breaker on a model that
    // is merely learning a schema, which is the opposite of the intent.
    expect(isCountedRejection(401)).toBe(true)
    expect(isCountedRejection(403)).toBe(true)
    expect(isCountedRejection(429)).toBe(true)
    expect(isCountedRejection(400)).toBe(false)
    expect(isCountedRejection(404)).toBe(false)
    expect(isCountedRejection(200)).toBe(false)
    expect(isCountedRejection(500)).toBe(false)
  })
})

describe('mapDiscordError', () => {
  it('turns a 403 into a permission error pointing at the diagnostic tool', () => {
    const e = mapDiscordError(403, { code: 50013, message: 'Missing Permissions' })
    expect(e._tag).toBe('DiscordPermissionError')
    expect(e.suggestion).toMatch(/discord_permissions_explain/)
  })

  it('refuses to blame the arguments for a 401', () => {
    const e = mapDiscordError(401, { message: '401: Unauthorized' })
    expect(e._tag).toBe('DiscordApiError')
    expect(e.suggestion).toMatch(/DISCORD_TOKEN/)
    if (e._tag === 'DiscordApiError') expect(e.retryable).toBe(false)
  })

  it('flattens an invalid form body into fields the model can fix', () => {
    const e = mapDiscordError(400, {
      code: 50035,
      message: 'Invalid Form Body',
      errors: {
        components: {
          '0': { accessory: { _errors: [{ code: 'BASE_TYPE_REQUIRED', message: 'Required' }] } },
        },
      },
    })

    expect(e._tag).toBe('DiscordApiError')
    if (e._tag === 'DiscordApiError') {
      expect(e.issues).toContain('components.0.accessory: Required [BASE_TYPE_REQUIRED]')
      expect(e.retryable).toBe(false)
    }
  })

  it('treats 5xx as transient but a 404 as a decision', () => {
    const server = mapDiscordError(503, { message: 'Service Unavailable' })
    const missing = mapDiscordError(404, { message: 'Unknown Guild', code: 10004 })

    if (server._tag === 'DiscordApiError') expect(server.retryable).toBe(true)
    if (missing._tag === 'DiscordApiError') expect(missing.retryable).toBe(false)
  })
})
