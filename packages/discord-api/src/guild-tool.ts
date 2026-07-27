import { defineTool, Snowflake } from '@discord-mcp/core'
import type { RESTGetAPIGuildResult } from 'discord-api-types/v10'
import { Effect, Schema } from 'effect'
import type { DiscordRestClient } from './rest.js'

const GuildGetInput = Schema.Struct({
  guildId: Snowflake,
  withCounts: Schema.optionalKey(Schema.Boolean),
})

export const createGuildGetTool = (rest: DiscordRestClient) =>
  defineTool<
    { readonly guildId: string; readonly withCounts?: boolean },
    RESTGetAPIGuildResult,
    never
  >({
    name: 'discord_guild_get',
    title: 'Get Discord guild',
    description:
      'Returns one guild visible to the bot. Requires View Guild. On 403, call discord_permissions_explain.',
    toolset: 'operator',
    gate: 'always',
    risk: 'read',
    scopes: ['mcp:read'],
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    input: GuildGetInput,
    handler: ({ guildId, withCounts }) =>
      rest
        .request<RESTGetAPIGuildResult>(
          'GET',
          `/guilds/${encodeURIComponent(guildId)}`,
          withCounts === undefined
            ? {}
            : { query: new URLSearchParams({ with_counts: String(withCounts) }) },
        )
        .pipe(Effect.withLogSpan('discord:get_guild')),
  })
