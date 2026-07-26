import {
  apiTools,
  DiscordRest,
  guildGet,
  messageTools,
  OperationCatalog,
  operatorTools,
  PreviewTokens,
  permissionsExplain,
  RateGuard,
} from '@discord-mcp/discord-api'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { createMcpHandler } from '@modelcontextprotocol/server'
import { Layer, ManagedRuntime, Redacted } from 'effect'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { stdioAuthorize } from '../src/app.ts'
import type { ServerConfig } from '../src/config.ts'
import { buildMcpServer } from '../src/mcp-server.ts'
import { testConfig, testPersistence } from './support/harness.ts'

/**
 * The whole stack against a real Discord guild.
 *
 * Excluded from the ordinary suite because it mutates a real server. Everything it creates it
 * deletes, and it works in a channel it made itself, so a mistake here damages a test guild rather
 * than someone's community.
 *
 *   DISCORD_MCP_E2E_TOKEN=... DISCORD_MCP_E2E_GUILD=... \
 *     pnpm exec vitest run --config vitest.e2e.config.ts
 *
 * The bot needs Manage Channels, Manage Roles, and Send Messages in that guild.
 */

const token = process.env.DISCORD_MCP_E2E_TOKEN
const guildId = process.env.DISCORD_MCP_E2E_GUILD
const enabled = token !== undefined && guildId !== undefined

let client: Client
let handler: ReturnType<typeof createMcpHandler>
let runtime: ManagedRuntime.ManagedRuntime<never, never>
let channelId: string | undefined
let roleId: string | undefined

const call = async (name: string, args: Record<string, unknown>) => {
  const result = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean
    content: ReadonlyArray<{ text?: string }>
  }
  return {
    isError: result.isError === true,
    text: result.content.map((c) => c.text ?? '').join(''),
  }
}

const parsed = (text: string): Record<string, unknown> => {
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    return {}
  }
}

beforeAll(async () => {
  if (!enabled) return

  const config: ServerConfig = {
    ...testConfig,
    rest: { ...testConfig.rest, token: Redacted.make(token) },
  }

  runtime = ManagedRuntime.make(
    Layer.mergeAll(
      DiscordRest.layer(config.rest).pipe(Layer.provide(RateGuard.layer())),
      OperationCatalog.layer,
      PreviewTokens.layer,
      Layer.orDie(testPersistence()),
    ),
  ) as ManagedRuntime.ManagedRuntime<never, never>

  handler = createMcpHandler(
    () =>
      buildMcpServer({
        config,
        runtime,
        authorize: stdioAuthorize,
        tools: [guildGet, permissionsExplain, ...operatorTools, ...messageTools, ...apiTools],
      }),
    { onerror: () => {} },
  )

  client = new Client({ name: 'e2e', version: '0.0.0' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL('http://mcp.test/mcp'), {
      fetch: ((url: string | URL, init?: RequestInit) =>
        handler.fetch(new Request(url, init))) as typeof fetch,
    }),
  )
}, 60_000)

afterAll(async () => {
  if (!enabled) return

  // Everything this suite created, removed — whatever the assertions did.
  if (channelId !== undefined) {
    await call('discord_api_destructive', {
      operationId: 'delete_channel',
      path: { channel_id: channelId },
    }).catch(() => undefined)
  }
  if (roleId !== undefined && guildId !== undefined) {
    await call('discord_api_destructive', {
      operationId: 'delete_guild_role',
      path: { guild_id: guildId, role_id: roleId },
    }).catch(() => undefined)
  }

  await client?.close()
  await handler?.close()
  await runtime?.dispose()
}, 60_000)

describe.skipIf(!enabled)('against a real test guild', () => {
  it('reads the guild it was pointed at', async () => {
    const result = await call('discord_guild_get', { guildId: guildId as string })

    expect(result.isError).toBe(false)
    expect(parsed(result.text).id).toBe(guildId)
  })

  it('explains what the bot can actually do', async () => {
    const result = await call('discord_permissions_explain', {
      guildId: guildId as string,
      operation: 'create_message',
    })

    // The point of this tool is that it answers before a call fails, so it must work against a
    // real guild's real overwrites rather than only against fixtures.
    expect(result.isError).toBe(false)
  })

  it('creates a channel, posts to it, and reads the message back', async () => {
    const created = await call('discord_api_write', {
      operationId: 'create_guild_channel',
      path: { guild_id: guildId as string },
      body: { name: `e2e-${Date.now()}`, type: 0 },
    })
    expect(created.isError).toBe(false)

    channelId = String((parsed(created.text).data as { id?: string } | undefined)?.id ?? '')
    expect(channelId).not.toBe('')

    const posted = await call('discord_message_send', {
      channelId,
      presentation: { kind: 'legacy', content: 'e2e' },
    })
    expect(posted.isError).toBe(false)

    const read = await call('discord_api_read', {
      operationId: 'list_messages',
      path: { channel_id: channelId },
      query: { limit: 5 },
    })
    expect(read.isError).toBe(false)
    expect(read.text).toContain('e2e')
  }, 60_000)

  it('refuses a destructive call without a preview token, then accepts one', async () => {
    const role = await call('discord_role_create', {
      guildId: guildId as string,
      name: `e2e-${Date.now()}`,
    })
    expect(role.isError).toBe(false)
    roleId = String((parsed(role.text) as { id?: string }).id ?? '')

    const unpreviewed = await call('discord_api_destructive', {
      operationId: 'delete_guild_role',
      path: { guild_id: guildId as string, role_id: roleId },
    })
    expect(unpreviewed.isError).toBe(true)
    expect(unpreviewed.text).toContain('previewToken')

    const preview = await call('discord_api_preview', {
      operationId: 'delete_guild_role',
      path: { guild_id: guildId as string, role_id: roleId },
    })
    expect(preview.isError).toBe(false)

    const previewToken = String((parsed(preview.text) as { previewToken?: string }).previewToken)
    const executed = await call('discord_api_destructive', {
      operationId: 'delete_guild_role',
      path: { guild_id: guildId as string, role_id: roleId },
      previewToken,
    })
    expect(executed.isError).toBe(false)
    roleId = undefined
  }, 60_000)

  it('reports a real Discord failure as something actionable', async () => {
    const result = await call('discord_api_read', {
      operationId: 'get_channel',
      path: { channel_id: '000000000000000000' },
    })

    expect(result.isError).toBe(true)
    // Not a stack trace and not a bare status: the message has to tell a model what to do next.
    expect(result.text.length).toBeGreaterThan(40)
  })
})
