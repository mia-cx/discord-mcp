import { McpInput } from '@discord-mcp/core'
import { Effect, type Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import { operationCatalog } from './catalog.js'
import { DiscordDispatcher, DispatchValidationError } from './dispatcher.js'
import { effectSchemaFromJson } from './effect-schema.js'
import { DiscordRestClient, type DiscordTransport } from './rest.js'

const makeDispatcher = (secret?: string) => {
  let calls = 0
  let lastRequest: Parameters<DiscordTransport['request']>[0] | undefined
  const transport: DiscordTransport = {
    request: async (request) => {
      calls += 1
      lastRequest = request
      return { ok: true }
    },
  }
  return {
    dispatcher: new DiscordDispatcher(
      new DiscordRestClient(transport),
      undefined,
      undefined,
      undefined,
      secret === undefined ? undefined : { resolve: async () => secret },
    ),
    calls: () => calls,
    lastRequest: () => lastRequest,
  }
}

describe('generated Discord operation catalog', () => {
  it('contains every operation and path from the pin', () => {
    expect(operationCatalog.operationCount).toBe(242)
    expect(operationCatalog.pathCount).toBe(150)
    expect(operationCatalog.operations).toHaveLength(242)
    expect(
      operationCatalog.operations.every(({ auth, risk }) => auth.length > 0 && risk.length > 0),
    ).toBe(true)
    expect(
      operationCatalog.operations
        .filter(({ method, risk }) => method === 'GET' && risk !== 'credential')
        .every(({ risk }) => risk === 'read'),
    ).toBe(true)
  })

  it('merges path-item parameters into operations', () => {
    const operation = operationCatalog.describe('get_guild')
    expect(operation.parameters).toContainEqual(
      expect.objectContaining({ name: 'guild_id', in: 'path', required: true }),
    )
  })

  it('supports bounded natural-language search and cursors', () => {
    expect(operationCatalog.search({ query: 'send message' }).operations[0]?.operationId).toBe(
      'create_message',
    )
    expect(operationCatalog.search({ limit: 1 }).nextCursor).toBeDefined()
    expect(operationCatalog.search({ query: 'send message' }).operations[0]).not.toHaveProperty(
      'body',
    )
  })

  it('describes derived OAuth, response, pagination, documentation, and override metadata', () => {
    const listGuilds = operationCatalog.describe('list_my_guilds')
    expect(listGuilds.oauthScopes).toContain('guilds')
    expect(listGuilds.responseBodies['200']?.['application/json']).toMatchObject({
      type: ['array', 'null'],
    })
    expect(listGuilds.pagination).toEqual({
      style: 'cursor',
      parameters: ['before', 'after'],
      limitParameter: 'limit',
    })
    expect(listGuilds.documentationUrl).toContain('74fda0fad044407ea280043a03ffc9bc64c4e49e')
    expect(listGuilds.schemaNames).toContain('MyGuildResponse')
    expect(listGuilds.dispatcherExample).toMatchObject({
      operationId: 'list_my_guilds',
    })
    expect(operationCatalog.describe('execute_webhook').overrides).toContainEqual(
      expect.objectContaining({ field: 'auth' }),
    )
  })

  it('keeps underspecified OpenAPI fragments JSON-only instead of accepting arbitrary values', async () => {
    const schema = McpInput(
      effectSchemaFromJson({}) as unknown as Schema.ConstraintDecoder<unknown, never>,
    )
    expect(await schema['~standard'].validate({ nested: [null, true, 3, 'ok'] })).toHaveProperty(
      'value',
    )
    expect(await schema['~standard'].validate(Symbol('not-json'))).toHaveProperty('issues')
    expect(await schema['~standard'].validate({ invalid: BigInt(1) })).toHaveProperty('issues')
  })

  it('rejects invented arguments and invalid bodies without network access', () => {
    const { dispatcher, calls } = makeDispatcher()
    expect(() =>
      dispatcher.preview('local', {
        operationId: 'get_guild',
        path: { guild_id: '12345678901234567' },
        query: { typo: true },
      }),
    ).toThrow(/Unknown query parameter/)
    expect(() =>
      dispatcher.preview('local', {
        operationId: 'create_message',
        path: { channel_id: '12345678901234567' },
        body: { content: 123 },
      }),
    ).toThrow(DispatchValidationError)
    expect(calls()).toBe(0)
  })

  it('validates required, constrained, and repeated query parameters locally', async () => {
    const { dispatcher, calls, lastRequest } = makeDispatcher()
    expect(() =>
      dispatcher.preview('local', {
        operationId: 'search_guild_members',
        path: { guild_id: '12345678901234567' },
      }),
    ).toThrow(/Missing query parameter: query/)
    expect(() =>
      dispatcher.preview('local', {
        operationId: 'list_messages',
        path: { channel_id: '12345678901234567' },
        query: { limit: 101 },
      }),
    ).toThrow(/Invalid query parameter limit/)
    const input = {
      operationId: 'guild_search',
      path: { guild_id: '12345678901234567' },
      query: {
        author_id: ['12345678901234568', '12345678901234569'],
        include_nsfw: false,
      },
    } as const
    expect(() => dispatcher.preview('local', input)).not.toThrow()
    await Effect.runPromise(dispatcher.dispatch('local', 'read', input))
    expect(lastRequest()?.query?.getAll('author_id')).toEqual([
      '12345678901234568',
      '12345678901234569',
    ])
    expect(lastRequest()?.query?.get('include_nsfw')).toBe('false')
    expect(calls()).toBe(1)
  })

  it('supports only cataloged, bounded audit-log reasons', () => {
    const { dispatcher } = makeDispatcher()
    expect(operationCatalog.describe('delete_message').auditLogReason).toBe(true)
    expect(() =>
      dispatcher.preview('local', {
        operationId: 'delete_message',
        path: {
          channel_id: '12345678901234567',
          message_id: '12345678901234568',
        },
        auditLogReason: 'cleanup after incident',
      }),
    ).not.toThrow()
    expect(() =>
      dispatcher.preview('local', {
        operationId: 'create_message',
        path: { channel_id: '12345678901234567' },
        body: { content: 'hello' },
        auditLogReason: 'not supported for message creation',
      }),
    ).toThrow(/does not accept/)
    expect(() =>
      dispatcher.preview('local', {
        operationId: 'delete_message',
        path: {
          channel_id: '12345678901234567',
          message_id: '12345678901234568',
        },
        auditLogReason: 'é'.repeat(300),
      }),
    ).toThrow(/1–512/)
  })

  it('refuses the five user-context operations under bot auth but allows OAuth2', () => {
    const incompatible = operationCatalog.operations.filter(
      ({ botIncompatible }) => botIncompatible,
    )
    expect(incompatible).toHaveLength(5)
    const { dispatcher } = makeDispatcher()
    expect(() =>
      dispatcher.preview('local', {
        operationId: 'get_my_guild_member',
        path: { guild_id: '12345678901234567' },
      }),
    ).toThrow(/cannot use bot authentication|rejects bot tokens/)
    expect(() =>
      dispatcher.preview('local', {
        operationId: 'get_my_guild_member',
        authMode: 'oauth2',
        path: { guild_id: '12345678901234567' },
      }),
    ).toThrow(/named OAuth profile/)
    expect(() =>
      dispatcher.preview('local', {
        operationId: 'get_my_guild_member',
        authMode: 'oauth2',
        authProfile: 'user',
        path: { guild_id: '12345678901234567' },
      }),
    ).not.toThrow()
  })

  it('requires named secret references for sensitive path parameters', async () => {
    const { dispatcher, calls, lastRequest } = makeDispatcher('webhook-token-value')
    expect(() =>
      dispatcher.preview('local', {
        operationId: 'get_webhook_by_token',
        authMode: 'webhook',
        path: {
          webhook_id: '12345678901234567',
          webhook_token: 'raw-secret-must-not-be-accepted',
        },
      }),
    ).toThrow(/sensitive.*secretRefs/)
    const input = {
      operationId: 'get_webhook_by_token',
      authMode: 'webhook' as const,
      path: { webhook_id: '12345678901234567' },
      secretRefs: { webhook_token: 'release-webhook' },
    }
    expect(dispatcher.preview('local', input).normalized.route).not.toContain('webhook-token-value')
    await Effect.runPromise(dispatcher.dispatch('local', 'read', input))
    expect(calls()).toBe(1)
    expect(lastRequest()?.route).toBe('/webhooks/12345678901234567/webhook-token-value')
    expect(lastRequest()?.auth).toBe(false)
  })

  it('injects sensitive body fields from named secrets instead of MCP input', async () => {
    const { dispatcher, calls, lastRequest } = makeDispatcher('oauth-access-token')
    const path = {
      channel_id: '12345678901234567',
      user_id: '12345678901234568',
    }
    expect(() =>
      dispatcher.preview('local', {
        operationId: 'add_group_dm_user',
        path,
        body: { access_token: 'raw-token', nick: 'Release bot' },
      }),
    ).toThrow(/body\.access_token is sensitive/)
    const input = {
      operationId: 'add_group_dm_user',
      path,
      body: { nick: 'Release bot' },
      secretRefs: { 'body.access_token': 'discord-user-token' },
    }
    expect(dispatcher.preview('local', input).normalized.body).toMatchObject({
      access_token: expect.stringContaining('[secret:'),
    })
    await Effect.runPromise(dispatcher.dispatch('local', 'write', input))
    expect(calls()).toBe(1)
    expect(lastRequest()?.body).toEqual({
      access_token: 'oauth-access-token',
      nick: 'Release bot',
    })
  })

  it('keeps deferred partner SDK credential operations out of generic dispatch', () => {
    const { dispatcher } = makeDispatcher()
    expect(operationCatalog.describe('partner_sdk_token').risk).toBe('credential')
    expect(() =>
      dispatcher.preview('local', {
        operationId: 'partner_sdk_token',
        body: {},
      }),
    ).toThrow(/dedicated service/)
  })

  it('enforces risk-separated dispatch and single-use bound previews', async () => {
    const { dispatcher, calls } = makeDispatcher()
    const input = {
      operationId: 'delete_channel',
      path: { channel_id: '12345678901234567' },
    } as const
    expect(() => dispatcher.dispatch('local', 'read', input)).toThrow(/not read/)
    const preview = dispatcher.preview('local', input)
    expect(preview.previewToken).toBeDefined()
    const previewToken = preview.previewToken
    if (previewToken === undefined) throw new Error('destructive preview must return a token')
    await Effect.runPromise(
      dispatcher.dispatch('local', 'destructive', {
        ...input,
        previewToken,
      }),
    )
    expect(calls()).toBe(1)
    expect(() =>
      dispatcher.dispatch('local', 'destructive', {
        ...input,
        previewToken,
      }),
    ).toThrow(/expired|already used/)
  })
})
