import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  actionableDiscordMessage,
  DiscordApiError,
  DiscordPermissionError,
  DiscordRateLimitError,
  flattenDiscordErrors,
  isDiscordFailure,
} from './errors.js'
import { RateGuard, RateGuardTrippedError } from './rate-guard.js'
import { DiscordRestClient, type DiscordTransport } from './rest.js'

describe('Discord REST boundary', () => {
  it('forwards Effect cancellation to the in-flight transport', async () => {
    let observedSignal: AbortSignal | undefined
    const transport: DiscordTransport = {
      request: ({ signal }) =>
        new Promise((_resolve, reject) => {
          observedSignal = signal
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        }),
    }
    const rest = new DiscordRestClient(transport)
    const controller = new AbortController()
    const pending = Effect.runPromise(rest.request('GET', '/guilds/123'), {
      signal: controller.signal,
    })
    controller.abort()
    await expect(pending).rejects.toBeDefined()
    expect(observedSignal?.aborted).toBe(true)
  })

  it('flattens nested Discord invalid-form errors into actionable field paths', () => {
    const fields = flattenDiscordErrors({
      components: {
        0: {
          accessory: {
            _errors: [{ code: 'BASE_TYPE_REQUIRED', message: 'This field is required' }],
          },
        },
      },
    })
    expect(fields).toEqual([
      {
        path: 'components.0.accessory',
        code: 'BASE_TYPE_REQUIRED',
        message: 'This field is required',
      },
    ])
    expect(
      actionableDiscordMessage(
        new DiscordApiError({ message: 'Missing access', status: 403, fields }),
      ),
    ).toContain('Do not retry; call discord_permissions_explain')
  })

  it('trips before a runaway invalid-request loop', () => {
    const guard = new RateGuard({ threshold: 2, windowMs: 1_000 })
    guard.record('bot', 'guilds', 403, 100)
    guard.record('bot', 'guilds', 403, 200)
    expect(() => guard.check('bot', 'guilds', 300)).toThrow(RateGuardTrippedError)
    expect(() => guard.check('bot', 'guilds', 2_000)).not.toThrow()
  })

  it('preserves the typed RateGuard failure and emits bounded request telemetry', async () => {
    const guard = new RateGuard({ threshold: 1 })
    guard.record('profile', 'guilds', 403)
    const trips: Array<unknown> = []
    const requests: Array<unknown> = []
    const rest = new DiscordRestClient(
      { request: async () => ({ ok: true }) },
      guard,
      'profile',
      0,
      {
        rateGuardTripped: (event) => trips.push(event),
        requestFinished: (event) => requests.push(event),
      },
    )
    await expect(Effect.runPromise(rest.request('GET', '/guilds/123'))).rejects.toBeInstanceOf(
      RateGuardTrippedError,
    )
    expect(trips).toEqual([{ profile: 'profile', family: 'guilds' }])
    expect(requests).toEqual([])

    guard.clear('profile', 'guilds')
    await expect(Effect.runPromise(rest.request('GET', '/guilds/123'))).resolves.toEqual({
      ok: true,
    })
    expect(requests).toMatchObject([
      { family: 'guilds', method: 'GET', status: '2xx', outcome: 'success' },
    ])
  })

  it.each([
    {
      status: 400,
      rawError: {
        code: 50_035,
        message: 'Invalid Form Body',
        errors: { name: { _errors: [{ code: 'BASE_TYPE_REQUIRED', message: 'Required' }] } },
      },
      expected: 'Correct the invalid fields',
    },
    {
      status: 401,
      rawError: { code: 0, message: '401: Unauthorized' },
      expected: 'check the configured Discord credential',
    },
    {
      status: 403,
      rawError: { code: 50_013, message: 'Missing Permissions' },
      expected: 'discord_permissions_explain',
    },
    {
      status: 429,
      rawError: { code: 0, message: 'You are being rate limited', retry_after: 1.25 },
      expected: 'wait 1250 ms',
    },
    {
      status: 503,
      rawError: { code: 0, message: 'Discord unavailable' },
      expected: 'outcome is unknown',
    },
  ])('renders an actionable Discord $status failure', async ({ status, rawError, expected }) => {
    const rest = new DiscordRestClient(
      {
        request: async () => {
          throw { status, rawError }
        },
      },
      new RateGuard(),
      'bot',
      0,
    )
    let failure: unknown
    try {
      await Effect.runPromise(rest.request('GET', '/channels/12345678901234567'))
    } catch (cause) {
      failure = cause
    }
    expect(isDiscordFailure(failure)).toBe(true)
    if (!isDiscordFailure(failure)) throw new Error('expected a Discord failure')
    if (status === 403) expect(failure).toBeInstanceOf(DiscordPermissionError)
    else if (status === 429) expect(failure).toBeInstanceOf(DiscordRateLimitError)
    else expect(failure).toBeInstanceOf(DiscordApiError)
    expect(actionableDiscordMessage(failure)).toContain(expected)
  })

  it('never retries a non-idempotent write after an ambiguous transport failure', async () => {
    let calls = 0
    const rest = new DiscordRestClient({
      request: async () => {
        calls += 1
        throw new Error('socket closed after request bytes were sent')
      },
    })
    await expect(
      Effect.runPromise(
        rest.request('POST', '/channels/12345678901234567/messages', {
          body: { content: 'hello' },
        }),
      ),
    ).rejects.toMatchObject({ retryable: true })
    expect(calls).toBe(1)
  })
})
