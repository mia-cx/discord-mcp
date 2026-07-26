import { guildGet } from '@discord-mcp/discord-api'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { guildFixture, type StubbedRequest, stubRest, withClient } from './support/harness.ts'

const tools = [guildGet]

/** Every result carries structured content; these tests read that rather than the prose. */
// biome-ignore lint/suspicious/noExplicitAny: MCP's CallToolResult is intentionally loose.
const structured = (result: any) => result.structuredContent

describe('discord_guild_get through a real MCP client', () => {
  it('advertises a schema derived from Effect Schema', async () => {
    await withClient(
      stubRest(() => Effect.succeed(guildFixture)),
      tools,
      async (client) => {
        const { tools: listed } = await client.listTools()
        const tool = listed.find((t) => t.name === 'discord_guild_get')

        expect(tool).toBeDefined()
        expect(tool?.inputSchema.type).toBe('object')
        expect(tool?.inputSchema.required).toEqual(['guildId'])
        expect(tool?.annotations?.readOnlyHint).toBe(true)
        // The snowflake constraint must survive the bridge, or a model learns the shape too late.
        expect(JSON.stringify(tool?.inputSchema)).toContain('\\\\d{17,21}')
      },
    )
  })

  it('returns a decoded guild for a valid request', async () => {
    const recorded: Array<StubbedRequest> = []
    await withClient(
      stubRest(() => Effect.succeed(guildFixture), recorded),
      tools,
      async (client) => {
        const result = await client.callTool({
          name: 'discord_guild_get',
          arguments: { guildId: '123456789012345678' },
        })

        expect(result.isError).toBe(false)
        expect(structured(result).ok).toBe(true)
        expect(structured(result).data).toMatchObject({
          id: '123456789012345678',
          name: 'Test Guild',
          ownerId: '987654321098765432',
          premiumTier: 2,
        })
        expect(recorded).toEqual([{ method: 'GET', route: '/guilds/123456789012345678' }])
      },
    )
  })

  it('rejects a malformed snowflake locally, without a Discord request', async () => {
    const recorded: Array<StubbedRequest> = []
    await withClient(
      stubRest(() => Effect.succeed(guildFixture), recorded),
      tools,
      async (client) => {
        const result = await client.callTool({
          name: 'discord_guild_get',
          arguments: { guildId: 'not-a-snowflake' },
        })

        expect(result.isError).toBe(true)
        // Nothing reached the network: an invalid argument must never spend Discord budget.
        expect(recorded).toEqual([])
      },
    )
  })

  it('names the offending field so the model can self-correct', async () => {
    await withClient(
      stubRest(() => Effect.succeed(guildFixture)),
      tools,
      async (client) => {
        const result = await client.callTool({
          name: 'discord_guild_get',
          arguments: { guildId: 'nope' },
        })

        const text = JSON.stringify(result.content)
        expect(text).toContain('guildId')
      },
    )
  })
})
