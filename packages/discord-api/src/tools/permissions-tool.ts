import { defineTool, Snowflake, ValidationError } from '@discord-mcp/core'
import {
  computeEffectivePermissions,
  explainMissing,
  type OverwriteLike,
  type PermissionName,
  type RoleLike,
} from '@mia-cx/discord-catalog'
import { Effect, Schema } from 'effect'
import { DiscordRest } from '../rest.ts'

const GuildPayload = Schema.Struct({ owner_id: Schema.String })
const RolePayload = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    permissions: Schema.String,
    position: Schema.Int,
    managed: Schema.optionalKey(Schema.Boolean),
  }),
)
const MemberPayload = Schema.Struct({
  user: Schema.Struct({ id: Schema.String }),
  roles: Schema.Array(Schema.String),
})
/** Announcement, public, and private threads inherit their parent channel's overwrites. */
const THREAD_TYPES = new Set([10, 11, 12])
const ChannelPayload = Schema.Struct({
  id: Schema.String,
  type: Schema.Int,
  guild_id: Schema.optionalKey(Schema.String),
  parent_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  name: Schema.optionalKey(Schema.String),
  permission_overwrites: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        type: Schema.Int,
        allow: Schema.String,
        deny: Schema.String,
      }),
    ),
  ),
})

const Input = Schema.Struct({
  guildId: Snowflake,
  memberId: Schema.optionalKey(
    Snowflake.annotate({
      description:
        'Whose permissions to compute. Defaults to this bot — usually what you want after a 403.',
    }),
  ),
  channelId: Schema.optionalKey(
    Snowflake.annotate({
      description: 'Include channel overwrites. Omit for guild-level permissions only.',
    }),
  ),
  check: Schema.optionalKey(
    Schema.Array(Schema.String).annotate({
      description:
        'Permission names to explain specifically, e.g. ["ManageRoles","SendMessages"]. Each gets a sentence naming the role or overwrite responsible.',
    }),
  ),
})

export const permissionsExplain = defineTool<typeof Input.Type, unknown, DiscordRest>({
  name: 'discord_permissions_explain',
  title: 'Explain effective permissions',
  description: [
    'Compute effective permissions for a member (or this bot) in a guild or channel, and explain',
    'which role or overwrite produced each important allow and deny.',
    '',
    'Call this after any permission failure instead of retrying with different arguments. Retrying',
    'a 403 cannot succeed and repeated rejections are rate-limited by this server before they reach',
    'Discord. Returns permission names, never raw bitfields.',
    '',
    'Requires the bot to be in the guild. Reads only; it changes nothing.',
  ].join('\n'),
  toolset: 'operator',
  risk: 'read',
  scopes: ['mcp:read'],
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: Input,
  handler: (args) =>
    Effect.gen(function* () {
      const rest = yield* DiscordRest

      const guild = yield* Schema.decodeUnknownEffect(GuildPayload)(
        yield* rest.request({
          method: 'GET',
          route: `/guilds/${args.guildId}`,
          operationFamily: 'guild',
        }),
      )
      const roles = yield* Schema.decodeUnknownEffect(RolePayload)(
        yield* rest.request({
          method: 'GET',
          route: `/guilds/${args.guildId}/roles`,
          operationFamily: 'role',
        }),
      )

      // Default to the bot itself: after a 403 that is almost always the subject.
      const memberRoute: `/${string}` =
        args.memberId === undefined
          ? `/guilds/${args.guildId}/members/@me`
          : `/guilds/${args.guildId}/members/${args.memberId}`
      const member = yield* Schema.decodeUnknownEffect(MemberPayload)(
        yield* rest.request({ method: 'GET', route: memberRoute, operationFamily: 'member' }),
      )

      let overwrites: ReadonlyArray<OverwriteLike> = []
      let channelName: string | undefined
      if (args.channelId !== undefined) {
        const getChannel = (id: string) =>
          Effect.flatMap(
            rest.request({ method: 'GET', route: `/channels/${id}`, operationFamily: 'channel' }),
            Schema.decodeUnknownEffect(ChannelPayload),
          )
        const channel = yield* getChannel(args.channelId)
        if (channel.guild_id !== args.guildId) {
          return yield* Effect.fail(
            new ValidationError({
              message: `Channel ${args.channelId} is not in guild ${args.guildId}.`,
              issues: ['channelId: pass a channel from the same guild as guildId.'],
            }),
          )
        }
        channelName = channel.name
        const source =
          THREAD_TYPES.has(channel.type) && typeof channel.parent_id === 'string'
            ? yield* getChannel(channel.parent_id)
            : channel
        overwrites = (source.permission_overwrites ?? []).map((o) => ({
          id: o.id,
          type: o.type === 1 ? 1 : 0,
          allow: o.allow,
          deny: o.deny,
        }))
      }

      const explanation = computeEffectivePermissions({
        guildId: args.guildId,
        guildOwnerId: guild.owner_id,
        memberId: member.user.id,
        memberRoleIds: member.roles,
        roles: roles as ReadonlyArray<RoleLike>,
        ...(overwrites.length > 0 ? { overwrites } : {}),
        ...(args.channelId === undefined ? {} : { channelId: args.channelId }),
      })

      const requested = (args.check ?? []) as ReadonlyArray<PermissionName>

      return {
        subject: args.memberId ?? 'this bot',
        guildId: args.guildId,
        ...(args.channelId === undefined ? {} : { channelId: args.channelId, channelName }),
        permissions: explanation.permissions,
        ...(explanation.shortCircuit === undefined
          ? {}
          : {
              shortCircuit: explanation.shortCircuit,
              note:
                explanation.shortCircuit === 'owner'
                  ? 'This member owns the guild, so every permission applies and channel overwrites are ignored.'
                  : 'This member has Administrator, so every permission applies and channel overwrites are ignored.',
            }),
        derivation: explanation.steps,
        ...(requested.length === 0
          ? {}
          : {
              checks: requested.map((name) => ({
                permission: name,
                granted: explanation.permissions.includes(name),
                explanation: explainMissing(explanation, name),
              })),
            }),
      }
    }),
})
