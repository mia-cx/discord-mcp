import type { Principal } from '@discord-mcp/auth'
import {
  DiscordRestClient,
  type DiscordTransport,
  operationCatalog,
} from '@discord-mcp/discord-api'
import { GatewayLifecycle } from '@discord-mcp/discord-gateway'
import { Database, VersionedDocumentStore } from '@discord-mcp/persistence'
import { WorkflowStore } from '@discord-mcp/workflow-runtime'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { createMcpHandler, InMemoryTransport } from '@modelcontextprotocol/server'
import { afterEach, describe, expect, it } from 'vitest'
import { curatedCatalogOperations } from './curated-tools.js'
import { createServer } from './server.js'
import { buildToolServer } from './tool-surface.js'

const guildFixture = (name: string) => ({
  id: '12345678901234567',
  name,
  icon: null,
  description: null,
  home_header: null,
  splash: null,
  discovery_splash: null,
  features: [],
  banner: null,
  owner_id: '12345678901234568',
  application_id: null,
  region: 'deprecated',
  afk_channel_id: null,
  afk_timeout: 60,
  system_channel_id: null,
  system_channel_flags: 0,
  widget_enabled: false,
  widget_channel_id: null,
  verification_level: 0,
  roles: [],
  default_message_notifications: 0,
  mfa_level: 0,
  explicit_content_filter: 0,
  max_presences: null,
  max_members: 100,
  max_stage_video_channel_users: 50,
  max_video_channel_users: 25,
  vanity_url_code: null,
  premium_tier: 0,
  premium_subscription_count: 0,
  preferred_locale: 'en-US',
  rules_channel_id: null,
  safety_alerts_channel_id: null,
  public_updates_channel_id: null,
  premium_progress_bar_enabled: false,
  nsfw: false,
  nsfw_level: 0,
  emojis: [],
  stickers: [],
  incidents_data: null,
})

describe('MCP tracer bullet', () => {
  const close: Array<() => Promise<void>> = []

  afterEach(async () => {
    await Promise.all(close.splice(0).map((run) => run()))
  })

  it('lists and calls discord_guild_get through the real MCP protocol stack', async () => {
    const requests: Array<{ route: string; signal: AbortSignal }> = []
    const transport: DiscordTransport = {
      request: async ({ route, signal }) => {
        requests.push({ route, signal })
        return guildFixture('Test guild')
      },
    }
    const server = createServer(new DiscordRestClient(transport))
    const client = new Client({ name: 'test-client', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    close.push(
      () => client.close(),
      () => server.close(),
    )

    const listed = await client.listTools()
    expect(listed.tools.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'discord_api_search',
        'discord_api_read',
        'discord_message_validate',
        'discord_message_send',
      ]),
    )
    expect(listed.tools.map(({ name }) => name)).not.toEqual(
      expect.arrayContaining(['discord_workflow_create', 'discord_gateway_status']),
    )
    expect(listed.tools.every(({ inputSchema }) => inputSchema.type === 'object')).toBe(true)

    const result = await client.callTool({
      name: 'discord_guild_get',
      arguments: { guildId: '12345678901234567', withCounts: true },
    })
    expect(result.isError).not.toBe(true)
    expect(result.structuredContent).toMatchObject({
      ok: true,
      data: { name: 'Test guild' },
      meta: { truncated: false },
    })
    expect(requests[0]?.route).toBe('/guilds/12345678901234567')
  })

  it('drives the fetch-native Streamable HTTP handler without a listening socket', async () => {
    const handler = createMcpHandler(() =>
      buildToolServer({
        rest: new DiscordRestClient({
          request: async () => guildFixture('Fetch-native guild'),
        }),
      }),
    )
    const transport = new StreamableHTTPClientTransport(new URL('https://mcp.example.test/mcp'), {
      fetch: (input, init) => handler.fetch(new Request(input, init)),
    })
    const client = new Client({ name: 'fetch-native-client', version: '1.0.0' })
    await client.connect(transport)
    try {
      expect(
        (await client.listTools()).tools.some(({ name }) => name === 'discord_guild_get'),
      ).toBe(true)
      const result = await client.callTool({
        name: 'discord_guild_get',
        arguments: { guildId: '12345678901234567' },
      })
      expect(result.structuredContent).toMatchObject({
        ok: true,
        data: { name: 'Fetch-native guild' },
      })
    } finally {
      await client.close()
      await handler.close()
    }
  }, 10_000)

  it('rejects malformed snowflakes before making a Discord request', async () => {
    let calls = 0
    const server = createServer(
      new DiscordRestClient({
        request: async () => {
          calls += 1
          return {}
        },
      }),
    )
    const client = new Client({ name: 'test-client', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    close.push(
      () => client.close(),
      () => server.close(),
    )

    const result = await client.callTool({
      name: 'discord_guild_get',
      arguments: { guildId: 'not-an-id' },
    })
    expect(result.isError).toBe(true)
    expect(calls).toBe(0)
  })

  it('sends an exact Gateway voice-state update without exposing raw Gateway payloads', async () => {
    const payloads: Array<unknown> = []
    const gateway = new GatewayLifecycle('lazy', {
      connect: async () => {},
      destroy: async () => {},
      send: async (payload) => {
        payloads.push(payload)
      },
    })
    const server = buildToolServer({
      rest: new DiscordRestClient({ request: async () => ({}) }),
      gateway,
    })
    const client = new Client({ name: 'voice-state-client', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    close.push(
      () => client.close(),
      () => server.close(),
    )

    const result = await client.callTool({
      name: 'discord_voice_state_set',
      arguments: {
        guildId: '12345678901234567',
        channelId: '12345678901234569',
        selfMute: true,
      },
    })
    expect(result.isError).not.toBe(true)
    expect(payloads).toEqual([
      {
        op: 4,
        d: {
          guild_id: '12345678901234567',
          channel_id: '12345678901234569',
          self_mute: true,
          self_deaf: false,
        },
      },
    ])
  })

  it('advertises and enforces operation-specific curated schemas through MCP', async () => {
    let calls = 0
    let response: unknown = []
    const server = createServer(
      new DiscordRestClient({
        request: async () => {
          calls += 1
          return response
        },
      }),
    )
    const client = new Client({ name: 'curated-schema-client', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    close.push(
      () => client.close(),
      () => server.close(),
    )

    const tool = (await client.listTools()).tools.find(
      ({ name }) => name === 'discord_message_list',
    )
    expect(tool?.inputSchema).toMatchObject({
      type: 'object',
      required: ['path'],
      properties: {
        path: {
          type: 'object',
          required: ['channel_id'],
          additionalProperties: false,
        },
        query: {
          type: 'object',
          additionalProperties: false,
          properties: {
            limit: {
              type: 'integer',
              allOf: expect.arrayContaining([expect.objectContaining({ maximum: 100 })]),
            },
          },
        },
      },
      additionalProperties: false,
    })
    expect(tool?.outputSchema).toBeDefined()
    if (!tool?.outputSchema) throw new Error('discord_message_list output schema is missing')
    expect(tool.outputSchema.type).toBe('object')
    expect(tool.outputSchema.anyOf).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'object',
          required: ['ok', 'data', 'meta', 'warnings'],
          additionalProperties: false,
        }),
        expect.objectContaining({
          type: 'object',
          required: ['ok', 'error', 'meta'],
          additionalProperties: false,
        }),
      ]),
    )

    const malformed = await client.callTool({
      name: 'discord_message_list',
      arguments: {
        path: { channel_id: 'not-a-snowflake', invented: 'value' },
        query: { limit: 101 },
      },
    })
    expect(malformed.isError).toBe(true)
    expect(calls).toBe(0)

    const result = await client.callTool({
      name: 'discord_message_list',
      arguments: {
        path: { channel_id: '12345678901234567' },
        query: { limit: 25 },
      },
    })
    expect(result.isError).not.toBe(true)
    expect(result.structuredContent).toMatchObject({ ok: true, data: [] })
    expect(calls).toBe(1)

    response = [{ content: '', embeds: [], attachments: [], components: [] }]
    const redacted = await client.callTool({
      name: 'discord_api_read',
      arguments: {
        operationId: 'list_messages',
        path: { channel_id: '12345678901234567' },
      },
    })
    expect(redacted.isError).not.toBe(true)
    expect(redacted.structuredContent).toMatchObject({
      ok: true,
      data: response,
      warnings: [expect.stringMatching(/MESSAGE_CONTENT/)],
    })

    response = { underdescribed: true }
    const invalidResponse = await client.callTool({
      name: 'discord_message_list',
      arguments: { path: { channel_id: '12345678901234567' } },
    })
    expect(invalidResponse.isError).toBe(true)
    expect(invalidResponse.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: expect.stringMatching(/output schema|invalid/i) }),
      ]),
    )
  })

  it('publishes the complete unique curated inventory with object-root schemas', async () => {
    const database = new Database(':memory:')
    database.migrate()
    const server = buildToolServer({
      rest: new DiscordRestClient({ request: async () => ({}) }),
      database,
      gateway: new GatewayLifecycle('lazy', {
        connect: async () => {},
        destroy: async () => {},
        send: async () => {},
      }),
      toolsets: new Set(['operator', 'automation', 'admin', 'api']),
    })
    const client = new Client({ name: 'inventory-client', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    close.push(
      () => client.close(),
      async () => {
        await server.close()
        database.close()
      },
    )
    const listed = await client.listTools()
    const names = listed.tools.map(({ name }) => name)
    expect(new Set(names).size).toBe(names.length)
    expect(names).toEqual(
      expect.arrayContaining([
        ...curatedCatalogOperations.map(({ name }) => name),
        'discord_guild_get',
        'discord_guild_inspect',
        'discord_server_snapshot',
        'discord_message_validate',
        'discord_message_send',
        'discord_message_edit',
        'discord_webhook_execute',
        'discord_server_blueprint_plan',
        'discord_server_blueprint_apply',
        'discord_message_template_publish',
        'discord_blob_put',
        'discord_oauth_profile_authorize',
        'discord_workflow_create',
        'discord_workflow_validate',
        'discord_workflow_enable',
        'discord_workflow_rollback',
        'discord_workflow_executions_tail',
        'discord_events_tail',
        'discord_presence_set',
        'discord_voice_state_set',
        'discord_gateway_status',
      ]),
    )
    expect(listed.tools.every(({ inputSchema }) => inputSchema.type === 'object')).toBe(true)
    expect(
      listed.tools.every(({ title, outputSchema }) => title && outputSchema?.type === 'object'),
    ).toBe(true)
    for (const tool of listed.tools) {
      expect(tool.description, `${tool.name} omits its local scope`).toContain(
        'Required local scope:',
      )
      expect(tool.description, `${tool.name} omits Discord authorization requirements`).toMatch(
        /Required Discord (?:guild )?permissions/,
      )
      if (tool.annotations?.destructiveHint) {
        expect(tool.description, `${tool.name} omits destructive behavior`).toContain(
          'Destructive behavior:',
        )
      }
      if (tool.annotations?.openWorldHint) {
        expect(tool.description, `${tool.name} omits its next diagnostic`).toMatch(
          /call discord_[a-z0-9_]+/,
        )
      }
    }
    const byName = new Map(listed.tools.map((tool) => [tool.name, tool]))
    for (const definition of curatedCatalogOperations) {
      const tool = byName.get(definition.name)
      expect(tool?.title, `${definition.name} has no title`).toBeTruthy()
      expect(tool?.outputSchema?.type, `${definition.name} has no object output schema`).toBe(
        'object',
      )
      const pathSchema = tool?.inputSchema.properties?.path as
        | Readonly<Record<string, unknown>>
        | undefined
      if (pathSchema) {
        const operation = operationCatalog.describe(definition.operationId)
        const expected = operation.parameters
          .filter((parameter) => parameter.in === 'path' && !parameter.sensitive)
          .map((parameter) => parameter.name)
          .sort()
        expect(Object.keys((pathSchema.properties as object | undefined) ?? {}).sort()).toEqual(
          expected,
        )
        expect(pathSchema.additionalProperties).toBe(false)
      }
    }
    expect(listed.tools).toMatchSnapshot()
  })

  it('truncates oversized responses with an explicit continuation', async () => {
    const server = buildToolServer({
      rest: new DiscordRestClient({
        request: async () => ({ id: '12345678901234567', description: 'x'.repeat(2_000) }),
      }),
      maximumResponseBytes: 500,
    })
    const client = new Client({ name: 'truncation-client', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    close.push(
      () => client.close(),
      () => server.close(),
    )

    const result = await client.callTool({
      name: 'discord_guild_get',
      arguments: { guildId: '12345678901234567' },
    })
    expect(result.structuredContent).toMatchObject({
      ok: true,
      data: {
        truncated: true,
        continuation: expect.stringContaining('discord://'),
      },
      meta: { truncated: true },
      warnings: [expect.stringContaining('truncated')],
    })
  })

  it('truncates response previews by UTF-8 bytes without splitting a code point', async () => {
    const server = buildToolServer({
      rest: new DiscordRestClient({
        request: async () => ({ id: '12345678901234567', description: '🦀'.repeat(2_000) }),
      }),
      maximumResponseBytes: 3_000,
    })
    const client = new Client({ name: 'utf8-truncation-client', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    close.push(
      () => client.close(),
      () => server.close(),
    )

    const result = await client.callTool({
      name: 'discord_guild_get',
      arguments: { guildId: '12345678901234567' },
    })
    const data = (result.structuredContent as { readonly data?: unknown } | undefined)?.data as
      | { readonly preview?: string; readonly truncated?: boolean }
      | undefined
    expect(data?.truncated).toBe(true)
    expect(data?.preview).not.toContain('�')
    expect(Buffer.byteLength(data?.preview ?? '')).toBeLessThanOrEqual(2_000)
  })

  it('applies mention safety to raw MCP message dispatch', async () => {
    const requests: Array<Parameters<DiscordTransport['request']>[0]> = []
    const principal: Principal = {
      id: 'message-writer',
      name: 'Message writer',
      kind: 'pat',
      scopes: new Set(['mcp:write']),
    }
    const server = buildToolServer({
      rest: new DiscordRestClient({
        request: async (request) => {
          requests.push(request)
          return { id: '12345678901234568' }
        },
      }),
      principal,
      toolsets: new Set(['api']),
    })
    const client = new Client({ name: 'mention-policy-client', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    close.push(
      () => client.close(),
      () => server.close(),
    )

    const safe = await client.callTool({
      name: 'discord_api_write',
      arguments: {
        operationId: 'create_message',
        path: { channel_id: '12345678901234567' },
        body: { content: '@everyone is not parsed' },
      },
    })
    expect(safe.isError).not.toBe(true)
    expect(requests[0]?.body).toMatchObject({
      allowed_mentions: { parse: [], replied_user: false },
    })
    const broad = await client.callTool({
      name: 'discord_api_write',
      arguments: {
        operationId: 'create_message',
        path: { channel_id: '12345678901234567' },
        body: {
          content: '@everyone',
          allowed_mentions: { parse: ['everyone'] },
        },
      },
    })
    expect(broad.isError).toBe(true)
    expect(requests).toHaveLength(1)
  })

  it('long-polls durable workflow tails and applies status and event filters', async () => {
    const database = new Database(':memory:')
    database.migrate()
    const now = new Date().toISOString()
    database.run(
      `INSERT INTO workflows
       (id, owner_principal_id, slug, name, created_at, updated_at)
       VALUES (?, 'local-administrator', 'tail-test', 'Tail test', ?, ?)`,
      'workflow-tail-test',
      now,
      now,
    )
    const server = buildToolServer({
      rest: new DiscordRestClient({ request: async () => ({}) }),
      database,
      toolsets: new Set(['automation']),
    })
    const client = new Client({ name: 'tail-client', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    const timer = setTimeout(() => {
      database.run(
        `INSERT INTO workflow_executions
         (id, workflow_id, revision, trigger_type, status, correlation_id, started_at)
         VALUES ('execution-tail-test', 'workflow-tail-test', 1, 'manual', 'succeeded',
                 'correlation-tail-test', ?)`,
        new Date().toISOString(),
      )
      database.run(
        `INSERT INTO workflow_events
         (workflow_id, event_type, payload_json, correlation_id, received_at)
         VALUES ('workflow-tail-test', 'message.created', '{}', 'correlation-tail-test', ?)`,
        new Date().toISOString(),
      )
      database.run(
        `INSERT INTO component_bindings
         (handle, owner_type, owner_id, action_type, action_key, created_at)
         VALUES ('tail-component-handle', 'workflow', 'workflow-tail-test', 'event', 'approve', ?)`,
        new Date().toISOString(),
      )
      database.run(
        `INSERT INTO component_events
         (owner_type, owner_id, binding_handle, action_key, interaction_id, payload_json,
          correlation_id, received_at)
         VALUES ('workflow', 'workflow-tail-test', 'tail-component-handle', 'approve',
                 '12345678901234567', '{}', '12345678901234567', ?)`,
        new Date().toISOString(),
      )
    }, 25)
    try {
      const executions = await client.callTool({
        name: 'discord_workflow_executions_tail',
        arguments: {
          workflowId: 'workflow-tail-test',
          statuses: ['succeeded'],
          waitMs: 1_000,
        },
      })
      expect(executions.structuredContent).toMatchObject({
        ok: true,
        data: [{ id: 'execution-tail-test', status: 'succeeded' }],
      })
      const events = await client.callTool({
        name: 'discord_events_tail',
        arguments: {
          workflowId: 'workflow-tail-test',
          eventTypes: ['message.created'],
          waitMs: 1_000,
        },
      })
      expect(events.structuredContent).toMatchObject({
        ok: true,
        data: [{ event_type: 'message.created' }],
      })
      const componentEvents = await client.callTool({
        name: 'discord_events_tail',
        arguments: {
          inbox: 'component',
          workflowId: 'workflow-tail-test',
          eventTypes: ['approve'],
        },
      })
      expect(componentEvents.structuredContent).toMatchObject({
        ok: true,
        data: [{ action_key: 'approve', interaction_id: '12345678901234567' }],
      })
    } finally {
      clearTimeout(timer)
      await client.close()
      await server.close()
      database.close()
    }
  })

  it('interrupts a durable workflow tail when the MCP request is cancelled', async () => {
    const database = new Database(':memory:')
    database.migrate()
    const server = buildToolServer({
      rest: new DiscordRestClient({ request: async () => ({}) }),
      database,
      toolsets: new Set(['automation']),
    })
    const client = new Client({ name: 'tail-cancellation-client', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    const controller = new AbortController()
    const pending = client.callTool(
      {
        name: 'discord_events_tail',
        arguments: { waitMs: 30_000 },
      },
      { signal: controller.signal },
    )
    controller.abort(new Error('test cancellation'))
    try {
      await expect(pending).rejects.toThrow(/cancel|abort/i)
    } finally {
      await client.close()
      await server.close()
      database.close()
    }
  })

  it('does not expose another remote principal workflow or published resource', async () => {
    const database = new Database(':memory:')
    database.migrate()
    const now = new Date().toISOString()
    for (const id of ['alice', 'bob']) {
      database.run(
        "INSERT INTO principals(id, name, kind, created_at) VALUES (?, ?, 'pat', ?)",
        id,
        id,
        now,
      )
    }
    const workflows = new WorkflowStore(database, {
      build: async () => {
        throw new Error('not used')
      },
    })
    const workflow = workflows.create({
      ownerPrincipalId: 'bob',
      slug: 'bob-private',
      name: 'Bob private workflow',
      source: 'export default {}',
    })
    const templates = new VersionedDocumentStore(database, 'message-template')
    const template = templates.create({
      ownerPrincipalId: 'bob',
      name: 'Bob private template',
      document: { secretMarker: 'private' },
    })
    const published = templates.publish(template.id, 'bob')
    const principal: Principal = {
      id: 'alice',
      name: 'Alice',
      kind: 'pat',
      scopes: new Set(['workflow:read', 'template:read']),
    }
    const server = buildToolServer({
      rest: new DiscordRestClient({ request: async () => ({}) }),
      database,
      workflows,
      principal,
      toolsets: new Set(['automation']),
    })
    const client = new Client({ name: 'isolation-client', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    try {
      const workflowResult = await client.callTool({
        name: 'discord_workflow_get',
        arguments: { workflowId: workflow.id },
      })
      expect(workflowResult.isError).toBe(true)
      const templateResult = await client.readResource({
        uri: `discord://message-templates/${template.id}/revisions/${published.revision}`,
      })
      const content = templateResult.contents[0]
      expect(content && 'text' in content ? JSON.parse(content.text) : undefined).toEqual({
        missing: true,
      })
    } finally {
      await client.close()
      await server.close()
      database.close()
    }
  })
})
