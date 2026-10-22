import { defineTool, McpRequestContext, Snowflake, ValidationError } from '@discord-mcp/core'
import { namesToBits, type PermissionName } from '@mia-cx/discord-catalog'
import { Effect, Schema } from 'effect'
import { hashArguments, PreviewTokens } from '../dispatch/preview.ts'
import { DiscordRest } from '../rest.ts'

/**
 * The curated operator surface: the things someone actually asks for, with strict schemas, named
 * permission flags, and errors that say what to do next.
 *
 * Everything destructive requires a preview token bound to the exact call, so a model cannot
 * describe a ban to the user and then execute a different one.
 */

type Deps = DiscordRest | PreviewTokens

const PermissionNameSchema = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
).annotate({
  description: 'A permission name such as "ManageRoles". Raw bitfields are not accepted.',
})

const AuditReason = Schema.optionalKey(
  Schema.String.pipe(Schema.check(Schema.isMaxLength(512))).annotate({
    description: 'Recorded in the guild audit log. Say why, not what.',
  }),
)

/** Bind a destructive call to its preview so the executed call is the described one. */
const redeemPreview = (
  operationId: string,
  args: unknown,
  targets: ReadonlyArray<string>,
  previewToken: string,
) =>
  Effect.gen(function* () {
    const tokens = yield* PreviewTokens
    const { principal } = yield* McpRequestContext
    yield* tokens.redeem(previewToken, {
      principalId: principal.id,
      operationId,
      authProfile: 'bot',
      argumentHash: hashArguments(args),
      targets: [...targets].sort(),
    })
  })

const issuePreview = (operationId: string, args: unknown, targets: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const tokens = yield* PreviewTokens
    const { principal } = yield* McpRequestContext
    return yield* tokens.issue({
      principalId: principal.id,
      operationId,
      authProfile: 'bot',
      argumentHash: hashArguments(args),
      targets: [...targets].sort(),
    })
  })

// ---------------------------------------------------------------- roles

const RoleCreateInput = Schema.Struct({
  guildId: Snowflake,
  name: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(100))),
  permissions: Schema.optionalKey(Schema.Array(PermissionNameSchema)),
  color: Schema.optionalKey(
    Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 0xff_ff_ff }))).annotate({
      description: 'A decimal integer. Write 0x5865f2 in source; Discord receives 5793266.',
    }),
  ),
  hoist: Schema.optionalKey(Schema.Boolean),
  mentionable: Schema.optionalKey(Schema.Boolean),
  auditLogReason: AuditReason,
})

export const roleCreate = defineTool<typeof RoleCreateInput.Type, unknown, DiscordRest>({
  name: 'discord_role_create',
  title: 'Create a role',
  description: [
    'Create a guild role with named permission flags.',
    '',
    'Requires ManageRoles. Discord will not let a bot grant permissions it does not itself hold —',
    'if this fails, call discord_permissions_explain to see what the bot actually has.',
    'The new role is created below the bot’s highest role.',
  ].join('\n'),
  toolset: 'operator',
  risk: 'write',
  scopes: ['mcp:write'],
  annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
  input: RoleCreateInput,
  handler: (args) =>
    Effect.gen(function* () {
      const rest = yield* DiscordRest
      return yield* rest.request({
        method: 'POST',
        route: `/guilds/${args.guildId}/roles`,
        operationFamily: 'role',
        body: {
          name: args.name,
          ...(args.permissions === undefined
            ? {}
            : {
                permissions: namesToBits(
                  args.permissions as ReadonlyArray<PermissionName>,
                ).toString(),
              }),
          ...(args.color === undefined ? {} : { color: args.color }),
          ...(args.hoist === undefined ? {} : { hoist: args.hoist }),
          ...(args.mentionable === undefined ? {} : { mentionable: args.mentionable }),
        },
        ...(args.auditLogReason === undefined ? {} : { auditLogReason: args.auditLogReason }),
      })
    }),
})

const RoleAssignInput = Schema.Struct({
  guildId: Snowflake,
  userId: Snowflake,
  roleId: Snowflake,
  action: Schema.Literals(['add', 'remove']),
  auditLogReason: AuditReason,
})

export const roleAssign = defineTool<typeof RoleAssignInput.Type, unknown, DiscordRest>({
  name: 'discord_role_assign',
  title: 'Add or remove a role from a member',
  description: [
    'Give or take a role from a guild member.',
    '',
    'Requires ManageRoles, and the role must be strictly below the bot’s highest role — Discord',
    'refuses otherwise, and no retry will change that. Call discord_permissions_explain on a 403.',
  ].join('\n'),
  toolset: 'operator',
  risk: 'write',
  scopes: ['mcp:write'],
  annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
  input: RoleAssignInput,
  handler: (args) =>
    Effect.gen(function* () {
      const rest = yield* DiscordRest
      return yield* rest.request({
        method: args.action === 'add' ? 'PUT' : 'DELETE',
        route: `/guilds/${args.guildId}/members/${args.userId}/roles/${args.roleId}`,
        operationFamily: 'role',
        ...(args.auditLogReason === undefined ? {} : { auditLogReason: args.auditLogReason }),
      })
    }),
})

// ---------------------------------------------------------------- members and moderation

const TimeoutInput = Schema.Struct({
  guildId: Snowflake,
  userId: Snowflake,
  /** Either form; the tool converts. Asking for both would be a needless way to get it wrong. */
  durationMinutes: Schema.optionalKey(
    Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 40_320 }))).annotate({
      description: 'Up to 28 days, which is Discord’s maximum.',
    }),
  ),
  until: Schema.optionalKey(
    Schema.String.annotate({ description: 'ISO 8601 timestamp. Use instead of durationMinutes.' }),
  ),
  clear: Schema.optionalKey(
    Schema.Boolean.annotate({ description: 'Remove an existing timeout.' }),
  ),
  auditLogReason: AuditReason,
})

export const memberTimeout = defineTool<typeof TimeoutInput.Type, unknown, DiscordRest>({
  name: 'discord_member_timeout',
  title: 'Time out a member',
  description: [
    'Time a member out, or clear an existing timeout. Accepts a duration in minutes or an absolute',
    'timestamp — supply one, not both.',
    '',
    'Requires ModerateMembers, and the target must be below the bot in the role hierarchy.',
    'Reversible: clear: true removes it. Discord’s maximum is 28 days.',
  ].join('\n'),
  toolset: 'operator',
  risk: 'write',
  scopes: ['mcp:write'],
  annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
  input: TimeoutInput,
  handler: (args) =>
    Effect.gen(function* () {
      const supplied = [args.durationMinutes, args.until, args.clear].filter((v) => v !== undefined)
      if (supplied.length !== 1) {
        return yield* Effect.fail(
          new ValidationError({
            message: 'Supply exactly one of durationMinutes, until, or clear.',
            issues: [
              supplied.length === 0
                ? 'timeout: nothing was supplied, so there is nothing to do.'
                : 'timeout: these are mutually exclusive; supplying more than one is ambiguous.',
            ],
          }),
        )
      }

      const at = yield* Effect.clockWith((c) => c.currentTimeMillis)
      const until =
        args.clear === true
          ? null
          : (args.until ?? new Date(at + (args.durationMinutes ?? 0) * 60_000).toISOString())

      const rest = yield* DiscordRest
      return yield* rest.request({
        method: 'PATCH',
        route: `/guilds/${args.guildId}/members/${args.userId}`,
        operationFamily: 'member',
        body: { communication_disabled_until: until },
        ...(args.auditLogReason === undefined ? {} : { auditLogReason: args.auditLogReason }),
      })
    }),
})

const BanInput = Schema.Struct({
  guildId: Snowflake,
  userId: Snowflake,
  deleteMessageSeconds: Schema.optionalKey(
    Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 604_800 }))).annotate({
      description: 'Also delete this member’s messages from the last N seconds, up to 7 days.',
    }),
  ),
  auditLogReason: AuditReason,
  previewToken: Schema.String,
})

export const memberBan = defineTool<typeof BanInput.Type, unknown, Deps>({
  name: 'discord_member_ban',
  title: 'Ban a member',
  description: [
    'Ban a user from the guild, optionally deleting their recent messages.',
    '',
    'Requires the mcp:destructive scope, BanMembers, and an unexpired preview token from',
    'discord_member_ban_preview bound to this exact user. Bans persist until explicitly lifted and',
    'deleted messages cannot be recovered — show the user what the preview reports first.',
  ].join('\n'),
  toolset: 'operator',
  risk: 'destructive',
  scopes: ['mcp:destructive'],
  annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
  input: BanInput,
  handler: (args) =>
    Effect.gen(function* () {
      const body = {
        ...(args.deleteMessageSeconds === undefined
          ? {}
          : { delete_message_seconds: args.deleteMessageSeconds }),
      }

      yield* redeemPreview(
        'member.ban',
        { guildId: args.guildId, userId: args.userId, body },
        [args.guildId, args.userId],
        args.previewToken,
      )

      const rest = yield* DiscordRest
      return yield* rest.request({
        method: 'PUT',
        route: `/guilds/${args.guildId}/bans/${args.userId}`,
        operationFamily: 'moderation',
        body,
        ...(args.auditLogReason === undefined ? {} : { auditLogReason: args.auditLogReason }),
      })
    }),
})

const BanPreviewInput = Schema.Struct({
  guildId: Snowflake,
  userId: Snowflake,
  deleteMessageSeconds: Schema.optionalKey(Schema.Int),
})

export const memberBanPreview = defineTool<typeof BanPreviewInput.Type, unknown, Deps>({
  name: 'discord_member_ban_preview',
  title: 'Preview a ban',
  description: [
    'Resolve who would be banned and return a token bound to that exact user.',
    '',
    'Required before discord_member_ban. Show what this reports to the user and get their agreement',
    'before executing — the token binds the target, so previewing one ban and executing another is',
    'rejected.',
  ].join('\n'),
  toolset: 'operator',
  risk: 'read',
  scopes: ['mcp:read'],
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: BanPreviewInput,
  handler: (args) =>
    Effect.gen(function* () {
      const rest = yield* DiscordRest

      // Resolve the target so the user sees a name, not an ID they cannot check.
      const member = yield* Effect.result(
        rest.request({
          method: 'GET',
          route: `/guilds/${args.guildId}/members/${args.userId}`,
          operationFamily: 'member',
        }),
      )

      const body = {
        ...(args.deleteMessageSeconds === undefined
          ? {}
          : { delete_message_seconds: args.deleteMessageSeconds }),
      }
      const { token, expiresAt } = yield* issuePreview(
        'member.ban',
        { guildId: args.guildId, userId: args.userId, body },
        [args.guildId, args.userId],
      )

      return {
        action: 'ban',
        guildId: args.guildId,
        userId: args.userId,
        member: member._tag === 'Success' ? member.success : null,
        memberLookup:
          member._tag === 'Success'
            ? 'resolved'
            : 'not currently a member — banning still works and prevents them joining',
        deleteMessageSeconds: args.deleteMessageSeconds ?? 0,
        reversible: false,
        warning:
          'A ban persists until explicitly lifted, and any deleted messages cannot be recovered. Confirm the target with the user before executing.',
        previewToken: token,
        expiresAt: new Date(expiresAt).toISOString(),
      }
    }),
})

const KickInput = Schema.Struct({
  guildId: Snowflake,
  userId: Snowflake,
  auditLogReason: AuditReason,
  previewToken: Schema.String,
})

export const memberKick = defineTool<typeof KickInput.Type, unknown, Deps>({
  name: 'discord_member_kick',
  title: 'Kick a member',
  description: [
    'Remove a member from the guild. They can rejoin with a new invite.',
    '',
    'Requires the mcp:destructive scope, KickMembers, and a preview token from',
    'discord_member_ban_preview for the same user.',
  ].join('\n'),
  toolset: 'operator',
  risk: 'destructive',
  scopes: ['mcp:destructive'],
  annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
  input: KickInput,
  handler: (args) =>
    Effect.gen(function* () {
      yield* redeemPreview(
        'member.kick',
        { guildId: args.guildId, userId: args.userId },
        [args.guildId, args.userId],
        args.previewToken,
      )

      const rest = yield* DiscordRest
      return yield* rest.request({
        method: 'DELETE',
        route: `/guilds/${args.guildId}/members/${args.userId}`,
        operationFamily: 'moderation',
        ...(args.auditLogReason === undefined ? {} : { auditLogReason: args.auditLogReason }),
      })
    }),
})

const UnbanInput = Schema.Struct({
  guildId: Snowflake,
  userId: Snowflake,
  auditLogReason: AuditReason,
})

export const memberUnban = defineTool<typeof UnbanInput.Type, unknown, DiscordRest>({
  name: 'discord_member_unban',
  title: 'Lift a ban',
  description: [
    'Remove a ban so the user can rejoin with an invite. Requires BanMembers.',
    '',
    'No preview token: lifting a ban restores access rather than removing it, so the failure mode',
    'is recoverable in a way a ban is not.',
  ].join('\n'),
  toolset: 'operator',
  risk: 'write',
  scopes: ['mcp:write'],
  annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
  input: UnbanInput,
  handler: (args) =>
    Effect.gen(function* () {
      const rest = yield* DiscordRest
      return yield* rest.request({
        method: 'DELETE',
        route: `/guilds/${args.guildId}/bans/${args.userId}`,
        operationFamily: 'moderation',
        ...(args.auditLogReason === undefined ? {} : { auditLogReason: args.auditLogReason }),
      })
    }),
})

// ---------------------------------------------------------------- listing

const ListInput = Schema.Struct({
  guildId: Snowflake,
  limit: Schema.optionalKey(
    Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 1000 }))),
  ),
  after: Schema.optionalKey(Snowflake),
})

export const memberList = defineTool<typeof ListInput.Type, unknown, DiscordRest>({
  name: 'discord_member_list',
  title: 'List guild members',
  description: [
    'List members, paging by snowflake with `after`.',
    '',
    'Requires the GUILD_MEMBERS privileged intent, enabled at',
    'discord.com/developers/applications/<application-id>/bot. Without it Discord returns only the',
    'bot itself, which looks like an empty guild.',
  ].join('\n'),
  toolset: 'operator',
  risk: 'read',
  scopes: ['mcp:read'],
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: ListInput,
  handler: (args) =>
    Effect.gen(function* () {
      const rest = yield* DiscordRest
      const query = new URLSearchParams({ limit: String(args.limit ?? 100) })
      if (args.after !== undefined) query.set('after', args.after)

      return yield* rest.request({
        method: 'GET',
        route: `/guilds/${args.guildId}/members`,
        operationFamily: 'member',
        query,
      })
    }),
})

const GuildOnlyInput = Schema.Struct({ guildId: Snowflake })

export const roleList = defineTool<typeof GuildOnlyInput.Type, unknown, DiscordRest>({
  name: 'discord_role_list',
  title: 'List roles',
  description: 'List every role in a guild with its position and named permission flags.',
  toolset: 'operator',
  risk: 'read',
  scopes: ['mcp:read'],
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: GuildOnlyInput,
  handler: (args) =>
    Effect.gen(function* () {
      const rest = yield* DiscordRest
      return yield* rest.request({
        method: 'GET',
        route: `/guilds/${args.guildId}/roles`,
        operationFamily: 'role',
      })
    }),
})

export const channelList = defineTool<typeof GuildOnlyInput.Type, unknown, DiscordRest>({
  name: 'discord_channel_list',
  title: 'List channels',
  description: 'List every channel in a guild with its type, position, and parent category.',
  toolset: 'operator',
  risk: 'read',
  scopes: ['mcp:read'],
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: GuildOnlyInput,
  handler: (args) =>
    Effect.gen(function* () {
      const rest = yield* DiscordRest
      return yield* rest.request({
        method: 'GET',
        route: `/guilds/${args.guildId}/channels`,
        operationFamily: 'channel',
      })
    }),
})

const NoInput = Schema.Struct({})

export const guildList = defineTool<typeof NoInput.Type, unknown, DiscordRest>({
  name: 'discord_guild_list',
  title: 'List the bot’s guilds',
  description:
    'List every guild this bot is a member of. Start here when you do not know a guild ID.',
  toolset: 'operator',
  risk: 'read',
  scopes: ['mcp:read'],
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: NoInput,
  handler: () =>
    Effect.gen(function* () {
      const rest = yield* DiscordRest
      return yield* rest.request({
        method: 'GET',
        route: '/users/@me/guilds',
        operationFamily: 'guild',
      })
    }),
})

const AuditLogInput = Schema.Struct({
  guildId: Snowflake,
  limit: Schema.optionalKey(
    Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
  ),
  userId: Schema.optionalKey(Snowflake),
  before: Schema.optionalKey(Snowflake),
})

export const auditLogList = defineTool<typeof AuditLogInput.Type, unknown, DiscordRest>({
  name: 'discord_audit_log_list',
  title: 'Read the guild audit log',
  description: [
    'Read Discord’s own audit log — who changed what and when.',
    '',
    'Requires ViewAuditLog. This is Discord’s log, not this server’s; use it to find out what',
    'happened in the guild rather than what this server did.',
  ].join('\n'),
  toolset: 'operator',
  risk: 'read',
  scopes: ['audit:read'],
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: AuditLogInput,
  handler: (args) =>
    Effect.gen(function* () {
      const rest = yield* DiscordRest
      const query = new URLSearchParams({ limit: String(args.limit ?? 50) })
      if (args.userId !== undefined) query.set('user_id', args.userId)
      if (args.before !== undefined) query.set('before', args.before)

      return yield* rest.request({
        method: 'GET',
        route: `/guilds/${args.guildId}/audit-logs`,
        operationFamily: 'audit',
        query,
      })
    }),
})

export const operatorTools = [
  guildList,
  channelList,
  roleList,
  roleCreate,
  roleAssign,
  memberList,
  memberTimeout,
  memberBanPreview,
  memberBan,
  memberKick,
  memberUnban,
  auditLogList,
]
