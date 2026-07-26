import { defineTool, Snowflake } from '@discord-mcp/core'
import { Effect, Schema } from 'effect'
import { DiscordRest } from '../rest.ts'

const GuildGetInput = Schema.Struct({
  guildId: Snowflake.annotate({ description: 'The guild (server) to read.' }),
  withCounts: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        'Include approximate member and presence counts. Costs Discord an extra lookup; leave unset unless you need the numbers.',
    }),
  ),
})

/**
 * Only the fields worth putting in front of a model. Discord returns roughly sixty, most of which
 * are legacy flags that would crowd out the useful ones in a bounded tool result.
 */
const GuildGetOutput = Schema.Struct({
  id: Snowflake,
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  ownerId: Snowflake,
  icon: Schema.NullOr(Schema.String),
  features: Schema.Array(Schema.String),
  premiumTier: Schema.Int,
  approximateMemberCount: Schema.optionalKey(Schema.Int),
  approximatePresenceCount: Schema.optionalKey(Schema.Int),
})

/** The wire shape, decoded before we trust any of it. */
const GuildPayload = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.optionalKey(Schema.NullOr(Schema.String)),
  owner_id: Schema.String,
  icon: Schema.optionalKey(Schema.NullOr(Schema.String)),
  features: Schema.Array(Schema.String),
  premium_tier: Schema.Int,
  approximate_member_count: Schema.optionalKey(Schema.Int),
  approximate_presence_count: Schema.optionalKey(Schema.Int),
})

export const guildGet = defineTool<
  typeof GuildGetInput.Type,
  typeof GuildGetOutput.Type,
  DiscordRest
>({
  name: 'discord_guild_get',
  title: 'Get guild',
  description: [
    'Read a guild (server) the bot is a member of: name, owner, icon, feature flags, and premium tier.',
    '',
    'Requires: the bot must be a member of the guild. No local scope beyond mcp:read.',
    'Read-only; safe to call repeatedly.',
    'If this returns a permission error, call discord_permissions_explain rather than retrying.',
  ].join('\n'),
  toolset: 'operator',
  risk: 'read',
  scopes: ['mcp:read'],
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: GuildGetInput,
  output: GuildGetOutput,
  handler: (args) =>
    Effect.gen(function* () {
      const rest = yield* DiscordRest

      const query = new URLSearchParams()
      if (args.withCounts === true) query.set('with_counts', 'true')

      const raw = yield* rest.request({
        method: 'GET',
        route: `/guilds/${args.guildId}`,
        operationFamily: 'guild',
        ...(args.withCounts === true ? { query } : {}),
      })

      const guild = yield* Schema.decodeUnknownEffect(GuildPayload, { errors: 'all' })(raw)

      return {
        id: guild.id,
        name: guild.name,
        description: guild.description ?? null,
        ownerId: guild.owner_id,
        icon: guild.icon ?? null,
        features: guild.features,
        premiumTier: guild.premium_tier,
        ...(guild.approximate_member_count === undefined
          ? {}
          : { approximateMemberCount: guild.approximate_member_count }),
        ...(guild.approximate_presence_count === undefined
          ? {}
          : { approximatePresenceCount: guild.approximate_presence_count }),
      }
    }),
})
