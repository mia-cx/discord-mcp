import { DefaultRestOptions, type ResponseLike } from '@discordjs/rest'
import { Effect, Layer, Redacted } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RateGuard, rejectionLog } from '../src/rate-guard.ts'
import { DiscordRest } from '../src/rest.ts'

/** One call through the real client, with every attempt answered by `discord`. */
const call = async (discord: () => Promise<ResponseLike>) => {
  const attempts = vi.spyOn(DefaultRestOptions, 'makeRequest').mockImplementation(discord)
  const log = rejectionLog()
  const layer = DiscordRest.layer({
    token: Redacted.make('token'),
    timeoutMs: 1_000,
    retries: 2,
    maxRateLimitWaitMs: 10_000,
  }).pipe(Layer.provide(RateGuard.layer(undefined, log)))
  const error = await Effect.gen(function* () {
    const rest = yield* DiscordRest
    return yield* rest.request({ method: 'GET', route: '/users/@me', operationFamily: 'user' })
  }).pipe(Effect.flip, Effect.provide(layer), Effect.runPromise)
  return { error, attempts: attempts.mock.calls.length, rejections: log.failureCount('process') }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('DiscordRest ban accounting', () => {
  it("ends a call at Discord's first 429 instead of resending it", async () => {
    const limited = () =>
      Promise.resolve(
        new Response(JSON.stringify({ message: 'You are being rate limited.', retry_after: 2 }), {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': '2' },
        }),
      )
    const { error, attempts, rejections } = await call(limited)
    expect(error).toMatchObject({ _tag: 'DiscordRateLimitError', retryAfterMs: 2_000 })
    expect(attempts).toBe(1)
    expect(rejections).toBe(1)
  })

  it('counts an attempt that timed out once, without resending it', async () => {
    const { attempts, rejections } = await call(() =>
      Promise.reject(new DOMException('This operation was aborted', 'AbortError')),
    )
    expect(attempts).toBe(1)
    expect(rejections).toBe(1)
  })

  it('leaves a refused connection uncounted, since Discord never saw it', async () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
    const { rejections } = await call(() => Promise.reject(refused))
    expect(rejections).toBe(0)
  })
})
