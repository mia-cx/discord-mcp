import { describe, expect, it } from 'vitest'
import { mapDiscordError } from '../src/errors.ts'
import { isCountedRejection, rateGuardScope, rejectionLog } from '../src/rate-guard.ts'

const config = { threshold: 3, processThreshold: 5, maxInFlight: 4, windowMs: 60_000 }
const scope = rateGuardScope('bot', 'guild')

/** A log on a hand-wound clock, and a call in `scope` that Discord answers. */
const guard = () => {
  const clock = { now: 1_700_000_000_000 }
  const log = rejectionLog(config, () => clock.now)
  const call = (target: string, rejected: boolean) => {
    const admission = log.admit([target])
    if ('refused' in admission) return admission.refused
    admission.settle(rejected)
  }
  return { clock, log, call }
}

describe('rejectionLog', () => {
  it('permits calls below the threshold', () => {
    const { log, call } = guard()
    call(scope, true)
    call(scope, true)
    expect(call(scope, false)).toBeUndefined()
    expect(log.failureCount(scope)).toBe(2)
  })

  it('trips at the threshold and refuses to send', () => {
    const { call } = guard()
    for (let i = 0; i < 3; i++) call(scope, true)
    expect(call(scope, false)?._tag).toBe('RateGuardTrippedError')
  })

  it('caps calls awaiting Discord, so a parallel burst cannot outrun the count', () => {
    const { log } = guard()
    for (let i = 0; i < 4; i++) log.admit([rateGuardScope(`bot-${i}`, 'guild')])
    expect('refused' in log.admit([scope])).toBe(true)
  })

  it('counts each credential and family separately, so one bad call site trips alone', () => {
    const { log, call } = guard()
    for (let i = 0; i < 3; i++) call(rateGuardScope('bot', 'guild'), true)
    // A different family must still be allowed through.
    expect(call(rateGuardScope('bot', 'channel'), false)).toBeUndefined()
    expect(call(rateGuardScope('oauth2', 'guild'), false)).toBeUndefined()
    expect(log.failureCount(rateGuardScope('bot', 'channel'))).toBe(0)
  })

  it('trips for every scope once the process total reaches its own threshold', () => {
    const { call } = guard()
    for (let i = 0; i < 5; i++) call(rateGuardScope(`bot-${i}`, 'guild'), true)
    expect(call(rateGuardScope('fresh', 'guild'), false)?._tag).toBe('RateGuardTrippedError')
  })

  it('forgets rejections once they leave the window', () => {
    const { clock, log, call } = guard()
    for (let i = 0; i < 3; i++) call(scope, true)
    clock.now += 2 * 60_000
    // The breaker is rolling, not latching: a quiet period restores service.
    expect(call(scope, false)).toBeUndefined()
    expect(log.failureCount(scope)).toBe(0)
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
