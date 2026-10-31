import { Clock, Effect, Redacted } from 'effect'
import { describe, expect, it } from 'vitest'
import { mapDiscordError } from '../src/errors.ts'
import {
  DEFAULT_FAILURE_THRESHOLD,
  isCountedRejection,
  RateGuard,
  rateGuardScope,
} from '../src/rate-guard.ts'
import { createRateLimiter, DiscordRest } from '../src/rest.ts'

const config = { threshold: 3, windowMs: 60_000 }
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

describe('RateGuard', () => {
  it('permits calls below the threshold', async () => {
    const count = await run(
      Effect.gen(function* () {
        const guard = yield* RateGuard
        yield* guard.recordRejection(scope)
        yield* guard.recordRejection(scope)
        yield* guard.check(scope)
        return yield* guard.failureCount(scope)
      }),
    )
    expect(count).toBe(2)
  })

  it('trips at the threshold and refuses to send', async () => {
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        Effect.gen(function* () {
          const guard = yield* RateGuard
          yield* guard.recordRejection(scope)
          yield* guard.recordRejection(scope)
          yield* guard.recordRejection(scope)
          yield* guard.check(scope)
        }),
        RateGuard.layer(config),
      ) as Effect.Effect<void, never>,
    )

    expect(exit._tag).toBe('Failure')
  })

  it('counts each auth-profile and family separately, so one bad call site trips alone', async () => {
    const counts = await run(
      Effect.gen(function* () {
        const guard = yield* RateGuard
        yield* guard.recordRejection(rateGuardScope('bot', 'guild'))
        yield* guard.recordRejection(rateGuardScope('bot', 'guild'))
        yield* guard.recordRejection(rateGuardScope('bot', 'guild'))
        // A different family must still be allowed through.
        yield* guard.check(rateGuardScope('bot', 'channel'))
        yield* guard.check(rateGuardScope('oauth2', 'guild'))
        return yield* guard.failureCount(rateGuardScope('bot', 'channel'))
      }),
    )
    expect(counts).toBe(0)
  })

  it('forgets rejections once they leave the window', async () => {
    // v4 core ships no TestClock, and the guard reads time through the Clock reference, so a
    // hand-wound clock is both sufficient and faster than actually waiting out a 60s window.
    const count = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const guard = yield* RateGuard
          yield* guard.recordRejection(scope)
          yield* guard.recordRejection(scope)
          yield* guard.recordRejection(scope)
          now += 2 * 60_000
          // The breaker is rolling, not latching: a quiet period restores service.
          yield* guard.check(scope)
          return yield* guard.failureCount(scope)
        }),
        RateGuard.layer(config),
      ).pipe(Effect.provideService(Clock.Clock, fakeClock)) as Effect.Effect<number, never>,
    )
    expect(count).toBe(0)
  })
})

describe('a shared rate limiter', () => {
  it('does not count requests it refused before Discord saw them', async () => {
    // Discord allows two guild reads, then the bucket stays empty for a minute.
    let guildReads = 0
    const discord: typeof fetch = async (input) => {
      if (!String(input).includes('/guilds/')) return Response.json({ id: '1', bot: true })
      guildReads += 1
      const remaining = String(Math.max(0, 2 - guildReads))
      return Response.json(
        { id: '1' },
        {
          headers: {
            'x-ratelimit-limit': '2',
            'x-ratelimit-remaining': remaining,
            'x-ratelimit-reset-after': '60',
            'x-ratelimit-bucket': 'guild',
          },
        },
      )
    }
    const limiter = createRateLimiter(
      { timeoutMs: 1000, retries: 0, maxRateLimitWaitMs: 0 },
      discord,
    )
    const request = (route: `/${string}`) =>
      Effect.runPromiseExit(
        Effect.flatMap(DiscordRest, (rest) =>
          rest.request({ method: 'GET', route, operationFamily: 'guild' }),
        ).pipe(Effect.provide(DiscordRest.shared(Redacted.make('token'), limiter))),
      )

    for (let read = 0; read < DEFAULT_FAILURE_THRESHOLD + 5; read++) await request('/guilds/1')
    const unrelated = await request('/users/@me')
    limiter.close()

    expect(guildReads).toBe(2)
    expect(unrelated._tag).toBe('Success')
  })

  it("trips on 429s Discord itself sends, such as a sublimit's", async () => {
    // A sublimit answers 429 while the bucket still reports requests remaining.
    let renames = 0
    const discord: typeof fetch = async () => {
      renames += 1
      return Response.json(
        { message: 'You are being rate limited.', retry_after: 600, global: false },
        {
          status: 429,
          headers: {
            'retry-after': '600',
            'x-ratelimit-limit': '5',
            'x-ratelimit-remaining': '4',
            'x-ratelimit-reset-after': '1',
            'x-ratelimit-scope': 'user',
          },
        },
      )
    }
    const limiter = createRateLimiter(
      { timeoutMs: 1000, retries: 0, maxRateLimitWaitMs: 0 },
      discord,
    )
    const rename = () =>
      Effect.runPromiseExit(
        Effect.flatMap(DiscordRest, (rest) =>
          rest.request({
            method: 'PATCH',
            route: '/channels/1',
            body: {},
            operationFamily: 'channel',
          }),
        ).pipe(Effect.provide(DiscordRest.shared(Redacted.make('token'), limiter))),
      )

    let last = await rename()
    for (let attempt = 0; attempt < DEFAULT_FAILURE_THRESHOLD; attempt++) last = await rename()
    limiter.close()

    expect(renames).toBe(DEFAULT_FAILURE_THRESHOLD)
    expect(String(last)).toContain('RateGuardTripped')
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
