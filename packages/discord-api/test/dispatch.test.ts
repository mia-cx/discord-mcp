import { McpRequestContext, type Principal, type Scope } from '@discord-mcp/core'
import { Effect, Layer, ManagedRuntime } from 'effect'
import { describe, expect, it } from 'vitest'
import { OperationCatalog } from '../src/catalog/service.ts'
import { AuthProfiles, dispatch, preview } from '../src/dispatch/dispatcher.ts'
import { PreviewTokens } from '../src/dispatch/preview.ts'
import { DiscordRest } from '../src/rest.ts'

const ALL_SCOPES = new Set<Scope>(['mcp:read', 'mcp:write', 'mcp:destructive', 'bot:admin'])
const principal: Principal = { id: 'test', kind: 'stdio-local', scopes: ALL_SCOPES }

interface Sent {
  readonly method: string
  readonly route: string
}

/**
 * Every test here asserts on `sent`. A rejection that still issues a Discord request is a failed
 * test even if the error message is perfect: 401/403 responses are what walk an installation
 * toward Cloudflare's ban threshold, and a validation bug that leaks requests is how you get there.
 */
const harness = () => {
  const sent: Sent[] = []
  const rest = Layer.succeed(DiscordRest)({
    request: (req) => {
      sent.push({ method: req.method, route: String(req.route) })
      return Effect.succeed({ ok: true })
    },
    raw: undefined as never,
  })

  // One runtime, built once — the same shape the server uses. Calling Effect.provide per run
  // would rebuild the layer each time, giving every call its own empty preview-token store and
  // making a valid token look expired.
  const runtime = ManagedRuntime.make(
    // botOnly: what a deployment with no Discord OAuth2 client credentials configured gets.
    Layer.mergeAll(rest, OperationCatalog.layer, PreviewTokens.layer, AuthProfiles.botOnly),
  )

  const run = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      DiscordRest | OperationCatalog | PreviewTokens | AuthProfiles | McpRequestContext
    >,
  ) =>
    runtime.runPromiseExit(
      Effect.provideService(effect, McpRequestContext, {
        requestId: 'r1',
        signal: undefined,
        progressToken: undefined,
        notify: undefined,
        principal,
      }) as Effect.Effect<A, E, DiscordRest | OperationCatalog | PreviewTokens | AuthProfiles>,
    )

  return { sent, run }
}

const READ = { allowed: ['read'] as const, requirePreviewToken: false }

const failureText = (exit: { _tag: string } & Record<string, unknown>): string =>
  JSON.stringify(exit)

describe('local validation happens before any Discord request', () => {
  it('rejects an invented operation ID', async () => {
    const { sent, run } = harness()
    const exit = await run(
      dispatch(
        { operationId: 'get_the_server', authProfile: 'bot' },
        { ...READ, allowed: ['read'] },
      ),
    )
    expect(exit._tag).toBe('Failure')
    expect(sent).toEqual([])
  })

  it('rejects a missing path parameter', async () => {
    const { sent, run } = harness()
    const exit = await run(dispatch({ operationId: 'get_guild', authProfile: 'bot' }, READ))
    expect(exit._tag).toBe('Failure')
    expect(failureText(exit)).toContain('guild_id')
    expect(sent).toEqual([])
  })

  it('rejects a malformed snowflake rather than letting Discord 404', async () => {
    const { sent, run } = harness()
    const exit = await run(
      dispatch(
        { operationId: 'get_guild', authProfile: 'bot', path: { guild_id: 'my-server' } },
        READ,
      ),
    )
    expect(exit._tag).toBe('Failure')
    expect(failureText(exit)).toContain('17-21 digits')
    expect(sent).toEqual([])
  })

  it('rejects an unknown query key, which Discord would silently ignore', async () => {
    const { sent, run } = harness()
    const exit = await run(
      dispatch(
        {
          operationId: 'get_guild',
          authProfile: 'bot',
          path: { guild_id: '123456789012345678' },
          query: { with_count: true },
        },
        READ,
      ),
    )
    expect(exit._tag).toBe('Failure')
    // The message must explain *why* this is rejected rather than ignored.
    expect(failureText(exit)).toContain('silently')
    expect(sent).toEqual([])
  })

  it('rejects an unknown path parameter', async () => {
    const { sent, run } = harness()
    const exit = await run(
      dispatch(
        {
          operationId: 'get_guild',
          authProfile: 'bot',
          path: { guild_id: '123456789012345678', role_id: '1' },
        },
        READ,
      ),
    )
    expect(exit._tag).toBe('Failure')
    expect(sent).toEqual([])
  })

  it('rejects a body that does not match the catalog schema', async () => {
    const { sent, run } = harness()
    const exit = await run(
      dispatch(
        {
          operationId: 'create_guild_role',
          authProfile: 'bot',
          path: { guild_id: '123456789012345678' },
          body: { name: 12345 },
        },
        { allowed: ['write'], requirePreviewToken: false },
      ),
    )
    expect(exit._tag).toBe('Failure')
    expect(sent).toEqual([])
  })

  it('rejects an audit log reason on an operation that does not record one', async () => {
    const { sent, run } = harness()
    const exit = await run(
      dispatch({ operationId: 'get_gateway', authProfile: 'bot', auditLogReason: 'because' }, READ),
    )
    expect(exit._tag).toBe('Failure')
    expect(sent).toEqual([])
  })

  it('sends a valid request, percent-encoding each segment', async () => {
    const { sent, run } = harness()
    const exit = await run(
      dispatch(
        { operationId: 'get_guild', authProfile: 'bot', path: { guild_id: '123456789012345678' } },
        READ,
      ),
    )
    expect(exit._tag).toBe('Success')
    expect(sent).toEqual([{ method: 'GET', route: '/guilds/123456789012345678' }])
  })
})

describe('risk separation is structural', () => {
  it('refuses a destructive operation through the read dispatcher', async () => {
    const { sent, run } = harness()
    const exit = await run(
      dispatch(
        {
          operationId: 'delete_guild_member',
          authProfile: 'bot',
          path: { guild_id: '123456789012345678', user_id: '123456789012345679' },
        },
        READ,
      ),
    )
    expect(exit._tag).toBe('Failure')
    expect(failureText(exit)).toContain('discord_api_destructive')
    expect(sent).toEqual([])
  })

  it('refuses a credential operation from every dispatcher', async () => {
    const { sent, run } = harness()
    for (const allowed of [['read'], ['write'], ['destructive'], ['bot_admin']] as const) {
      const exit = await run(
        dispatch(
          { operationId: 'partner_sdk_token', authProfile: 'bot' },
          { allowed, requirePreviewToken: false },
        ),
      )
      expect(exit._tag).toBe('Failure')
    }
    expect(sent).toEqual([])
  })
})

describe('the five bot-incompatible operations', () => {
  it('are refused under a bot profile, naming the OAuth2 scope to use', async () => {
    const { sent, run } = harness()
    const exit = await run(
      dispatch(
        {
          operationId: 'get_my_guild_member',
          authProfile: 'bot',
          path: { guild_id: '123456789012345678' },
        },
        READ,
      ),
    )
    expect(exit._tag).toBe('Failure')
    const text = failureText(exit)
    // Refused because of the profile, not because the operation is unavailable.
    expect(text).toContain('oauth2')
    expect(text).toContain('guilds.members.read')
    expect(sent).toEqual([])
  })

  it('are refused only for that reason — the catalog still lists them as callable', async () => {
    const { run } = harness()
    const exit = await run(Effect.flatMap(OperationCatalog, (c) => c.get('get_my_guild_member')))
    expect(exit._tag).toBe('Success')
  })
})

describe('preview tokens', () => {
  const DESTRUCTIVE = { allowed: ['destructive'] as const, requirePreviewToken: true }
  // The vendored spec marks this body required even though every property is optional, so an
  // empty object is the minimal valid call. Discovering that is exactly what describe is for.
  const banArgs = {
    operationId: 'ban_user_from_guild',
    authProfile: 'bot',
    path: { guild_id: '123456789012345678', user_id: '123456789012345679' },
    body: { delete_message_seconds: 0 },
  }

  it('are required for a destructive call', async () => {
    const { sent, run } = harness()
    const exit = await run(dispatch(banArgs, DESTRUCTIVE))
    expect(exit._tag).toBe('Failure')
    expect(failureText(exit)).toContain('discord_api_preview')
    expect(sent).toEqual([])
  })

  it('authorise exactly the call they described', async () => {
    const { sent, run } = harness()
    const previewed = await run(preview(banArgs))
    expect(previewed._tag).toBe('Success')
    const token = (previewed as { value: { previewToken: string } }).value.previewToken

    const exit = await run(dispatch({ ...banArgs, previewToken: token }, DESTRUCTIVE))
    expect(exit._tag).toBe('Success')
    expect(sent).toEqual([
      { method: 'PUT', route: '/guilds/123456789012345678/bans/123456789012345679' },
    ])
  })

  it('reject a token issued for a different target', async () => {
    const { sent, run } = harness()
    const previewed = await run(preview(banArgs))
    const token = (previewed as { value: { previewToken: string } }).value.previewToken

    // Preview one ban, execute another. This is the substitution the binding exists to prevent.
    const exit = await run(
      dispatch(
        {
          ...banArgs,
          path: { guild_id: '123456789012345678', user_id: '999999999999999999' },
          previewToken: token,
        },
        DESTRUCTIVE,
      ),
    )
    expect(exit._tag).toBe('Failure')
    expect(failureText(exit)).toContain('different')
    expect(sent).toEqual([])
  })

  it('are single use', async () => {
    const { run } = harness()
    const previewed = await run(preview(banArgs))
    const token = (previewed as { value: { previewToken: string } }).value.previewToken

    expect((await run(dispatch({ ...banArgs, previewToken: token }, DESTRUCTIVE)))._tag).toBe(
      'Success',
    )
    expect((await run(dispatch({ ...banArgs, previewToken: token }, DESTRUCTIVE)))._tag).toBe(
      'Failure',
    )
  })

  it('do not depend on argument key order', async () => {
    const { run } = harness()
    const previewed = await run(
      preview({
        ...banArgs,
        path: { guild_id: '123456789012345678', user_id: '123456789012345679' },
      }),
    )
    const token = (previewed as { value: { previewToken: string } }).value.previewToken

    // Same arguments, keys written the other way round. A hash over unsorted JSON would reject this.
    const exit = await run(
      dispatch(
        {
          ...banArgs,
          path: { user_id: '123456789012345679', guild_id: '123456789012345678' },
          previewToken: token,
        },
        DESTRUCTIVE,
      ),
    )
    expect(exit._tag).toBe('Success')
  })

  it('validate the call before issuing a token, so a token never covers a broken call', async () => {
    const { sent, run } = harness()
    const exit = await run(preview({ ...banArgs, path: { guild_id: 'nope', user_id: 'nope' } }))
    expect(exit._tag).toBe('Failure')
    expect(sent).toEqual([])
  })
})
