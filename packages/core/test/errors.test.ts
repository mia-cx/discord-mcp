import { Cause, Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  AuthorizationError,
  DiscordPermissionError,
  DiscordRateLimitError,
  RateGuardTrippedError,
  ValidationError,
} from '../src/errors.ts'
import { flattenDiscordErrors, renderCause } from '../src/mcp/result.ts'

describe('flattenDiscordErrors', () => {
  it('flattens the nested invalid-form-body tree into field paths', () => {
    const body = {
      components: {
        '0': {
          accessory: {
            _errors: [{ code: 'BASE_TYPE_REQUIRED', message: 'This field is required' }],
          },
        },
      },
    }

    expect(flattenDiscordErrors(body)).toEqual([
      'components.0.accessory: This field is required [BASE_TYPE_REQUIRED]',
    ])
  })

  it('reports every issue, not just the first', () => {
    const body = {
      embeds: {
        '0': { title: { _errors: [{ code: 'BASE_TYPE_MAX_LENGTH', message: 'Too long' }] } },
        '1': { url: { _errors: [{ code: 'URL_TYPE_INVALID_URL', message: 'Not a URL' }] } },
      },
    }

    expect(flattenDiscordErrors(body)).toEqual([
      'embeds.0.title: Too long [BASE_TYPE_MAX_LENGTH]',
      'embeds.1.url: Not a URL [URL_TYPE_INVALID_URL]',
    ])
  })

  it('handles root-level errors and non-object input', () => {
    expect(flattenDiscordErrors({ _errors: [{ code: 'X', message: 'bad' }] })).toEqual([
      '(root): bad [X]',
    ])
    expect(flattenDiscordErrors(undefined)).toEqual([])
    expect(flattenDiscordErrors('nope')).toEqual([])
  })
})

describe('renderCause', () => {
  const render = (e: unknown) => renderCause(Cause.fail(e))

  it('tells the agent not to retry a permission failure, and where to go instead', () => {
    const out = render(
      new DiscordPermissionError({
        message: 'Missing Permissions',
        missingPermission: 'ManageRoles',
        suggestion: 'Do not retry; call discord_permissions_explain.',
      }),
    )

    expect(out.retryable).toBe(false)
    expect(out.missingPermission).toBe('ManageRoles')
    expect(out.suggestion).toMatch(/discord_permissions_explain/)
  })

  it('names the missing scopes on an authorization failure', () => {
    const out = render(
      new AuthorizationError({ message: 'nope', missingScopes: ['mcp:destructive'] }),
    )
    expect(out.suggestion).toContain('mcp:destructive')
    expect(out.retryable).toBe(false)
  })

  it('marks a rate limit retryable and states the wait', () => {
    const out = render(
      new DiscordRateLimitError({ message: 'slow down', retryAfterMs: 2500, global: false }),
    )
    expect(out.retryable).toBe(true)
    expect(out.retryAfterMs).toBe(2500)
    expect(out.suggestion).toContain('2500ms')
  })

  it('refuses retries once the circuit breaker has tripped', () => {
    const out = render(
      new RateGuardTrippedError({
        message: 'tripped',
        scope: 'bot/guild',
        failures: 25,
        windowMs: 600_000,
      }),
    )
    expect(out.retryable).toBe(false)
    expect(out.suggestion).toMatch(/Do not retry/)
    expect(out.suggestion).toContain('bot/guild')
  })

  it('lists the fields to fix on a validation failure', () => {
    const out = render(
      new ValidationError({ message: 'bad input', issues: ['guildId: must be 17-21 digits'] }),
    )
    expect(out.suggestion).toContain('guildId: must be 17-21 digits')
  })

  it('tells the agent a defect is a server bug, not an argument problem', () => {
    const out = renderCause(Cause.die(new Error('boom')))
    expect(out.code).toBe('InternalError')
    expect(out.suggestion).toMatch(/bug in discord-mcp/)
    // A stack trace must never reach a remote MCP caller.
    expect(JSON.stringify(out)).not.toContain('boom')
  })

  it('treats interruption as cancellation rather than an error to diagnose', async () => {
    const exit = await Effect.runPromiseExit(Effect.interrupt as Effect.Effect<never, never, never>)
    expect(exit._tag).toBe('Failure')
    if (exit._tag === 'Failure') {
      expect(renderCause(exit.cause).code).toBe('Interrupted')
    }
  })
})
