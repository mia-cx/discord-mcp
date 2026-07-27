import { type Principal, requireScopes } from '@discord-mcp/auth'
import { McpInput } from '@discord-mcp/core'
import type { DiscordDispatcher, DiscordRestClient } from '@discord-mcp/discord-api'
import {
  BlueprintApplier,
  type BlueprintBindings,
  BlueprintBindingsSchema,
  digest,
  explainPermissions,
  type GuildSnapshot,
  GuildSnapshotSchema,
  PreviewTokens,
  planBlueprint,
  type ServerBlueprint,
  ServerBlueprintSchema,
} from '@discord-mcp/discord-blueprints'
import { type Database, VersionedDocumentStore } from '@discord-mcp/persistence'
import type { CallToolResult, McpServer } from '@modelcontextprotocol/server'
import { Effect, Schema } from 'effect'
import { BlueprintDiscordExecutor, SqliteBlueprintJournal } from './blueprint-apply.js'
import type { MetricsRegistry } from './observability.js'

interface BlueprintToolDependencies {
  readonly server: McpServer
  readonly rest: DiscordRestClient
  readonly dispatcher: DiscordDispatcher
  readonly principal: Principal
  readonly database?: Database
  readonly previewKey?: Buffer
  readonly metrics?: MetricsRegistry
  readonly attempt: (run: () => unknown | Promise<unknown>) => Promise<CallToolResult>
  readonly runEffect: <A, E>(program: Effect.Effect<A, E, never>, signal: AbortSignal) => Promise<A>
}

const loadBlueprintBindings = (database: Database, blueprintId: string): BlueprintBindings => {
  const rows = database.all<{
    logical_type: 'role' | 'channel' | 'automod'
    logical_key: string
    discord_id: string
  }>(
    `SELECT logical_type, logical_key, discord_id FROM server_blueprint_bindings
     WHERE blueprint_id = ?`,
    blueprintId,
  )
  return {
    roles: Object.fromEntries(
      rows
        .filter(({ logical_type }) => logical_type === 'role')
        .map(({ logical_key, discord_id }) => [logical_key, discord_id]),
    ),
    channels: Object.fromEntries(
      rows
        .filter(({ logical_type }) => logical_type === 'channel')
        .map(({ logical_key, discord_id }) => [logical_key, discord_id]),
    ),
    autoModerationRules: Object.fromEntries(
      rows
        .filter(({ logical_type }) => logical_type === 'automod')
        .map(({ logical_key, discord_id }) => [logical_key, discord_id]),
    ),
  }
}

const discordEmoji = (
  value: unknown,
): { readonly emojiId?: string; readonly emojiName?: string } => {
  if (typeof value !== 'object' || value === null) return {}
  const emoji = value as Record<string, unknown>
  return {
    ...(emoji.emoji_id === undefined || emoji.emoji_id === null
      ? {}
      : { emojiId: String(emoji.emoji_id) }),
    ...(emoji.emoji_name === undefined || emoji.emoji_name === null
      ? {}
      : { emojiName: String(emoji.emoji_name) }),
  }
}

const discordChannelKind = (type: number): GuildSnapshot['channels'][number]['kind'] => {
  const kind = {
    0: 'text',
    2: 'voice',
    4: 'category',
    5: 'announcement',
    13: 'stage',
    15: 'forum',
    16: 'media',
  } as const
  const resolved = kind[type as keyof typeof kind]
  if (!resolved) throw new Error(`unsupported Discord channel type ${type}`)
  return resolved
}

const captureGuild = async (
  rest: DiscordRestClient,
  runEffect: BlueprintToolDependencies['runEffect'],
  guildId: string,
  signal: AbortSignal,
) => {
  if (!/^\d{17,21}$/.test(guildId)) throw new Error('guildId must be a Discord snowflake')
  const [guild, channels, roles, user] = await runEffect(
    Effect.all(
      [
        rest.request<Record<string, unknown>>('GET', `/guilds/${guildId}`, {
          query: new URLSearchParams({ with_counts: 'true' }),
        }),
        rest.request<ReadonlyArray<Record<string, unknown>>>('GET', `/guilds/${guildId}/channels`),
        rest.request<ReadonlyArray<Record<string, unknown>>>('GET', `/guilds/${guildId}/roles`),
        rest.request<Record<string, unknown>>('GET', '/users/@me'),
      ],
      { concurrency: 4 },
    ),
    signal,
  )
  const botId = String(user.id)
  const member = await runEffect(
    rest.request<Record<string, unknown>>('GET', `/guilds/${guildId}/members/${botId}`),
    signal,
  )
  const [onboarding, welcomeScreen, autoModerationRules] = await runEffect(
    Effect.all(
      [
        rest
          .request<Record<string, unknown>>('GET', `/guilds/${guildId}/onboarding`)
          .pipe(Effect.catch(() => Effect.succeed(null))),
        rest
          .request<Record<string, unknown>>('GET', `/guilds/${guildId}/welcome-screen`)
          .pipe(Effect.catch(() => Effect.succeed(null))),
        rest
          .request<ReadonlyArray<Record<string, unknown>>>(
            'GET',
            `/guilds/${guildId}/auto-moderation/rules`,
          )
          .pipe(Effect.catch(() => Effect.succeed([]))),
      ],
      { concurrency: 2 },
    ),
    signal,
  )
  const snapshot: GuildSnapshot = {
    guildId,
    ownerId: String(guild.owner_id),
    botMemberId: botId,
    botRoleIds: Array.isArray(member.roles) ? member.roles.map(String) : [],
    settings: guild,
    roles: roles.map((role) => ({
      id: String(role.id),
      name: String(role.name),
      permissions: String(role.permissions ?? '0'),
      color: Number(role.color ?? 0),
      hoist: Boolean(role.hoist),
      mentionable: Boolean(role.mentionable),
      position: Number(role.position ?? 0),
      managed: Boolean(role.managed),
    })),
    channels: channels.map((channel) => ({
      id: String(channel.id),
      kind: discordChannelKind(Number(channel.type)),
      name: String(channel.name),
      ...(channel.parent_id === undefined || channel.parent_id === null
        ? {}
        : { parentId: String(channel.parent_id) }),
      ...(channel.topic === undefined ? {} : { topic: channel.topic as string | null }),
      ...(channel.nsfw === undefined ? {} : { nsfw: Boolean(channel.nsfw) }),
      ...(channel.bitrate === undefined ? {} : { bitrate: Number(channel.bitrate) }),
      ...(channel.user_limit === undefined ? {} : { userLimit: Number(channel.user_limit) }),
      ...(channel.rate_limit_per_user === undefined
        ? {}
        : { rateLimitPerUser: Number(channel.rate_limit_per_user) }),
      ...(channel.default_thread_rate_limit_per_user === undefined
        ? {}
        : {
            defaultThreadRateLimitPerUser: Number(channel.default_thread_rate_limit_per_user),
          }),
      ...(channel.default_auto_archive_duration === undefined
        ? {}
        : { defaultAutoArchiveDuration: Number(channel.default_auto_archive_duration) }),
      ...(channel.default_forum_layout === undefined
        ? {}
        : { defaultForumLayout: Number(channel.default_forum_layout) }),
      ...(channel.default_sort_order === undefined
        ? {}
        : {
            defaultSortOrder:
              channel.default_sort_order === null ? null : Number(channel.default_sort_order),
          }),
      ...(channel.default_reaction_emoji === undefined
        ? {}
        : {
            defaultReactionEmoji:
              channel.default_reaction_emoji === null
                ? null
                : discordEmoji(channel.default_reaction_emoji),
          }),
      ...(Array.isArray(channel.available_tags)
        ? {
            forumTags: channel.available_tags.map((tag) => {
              const value = tag as Record<string, unknown>
              return {
                ...(value.id === undefined ? {} : { id: String(value.id) }),
                name: String(value.name),
                moderated: Boolean(value.moderated),
                ...(value.emoji_id === undefined || value.emoji_id === null
                  ? {}
                  : { emojiId: String(value.emoji_id) }),
                ...(value.emoji_name === undefined || value.emoji_name === null
                  ? {}
                  : { emojiName: String(value.emoji_name) }),
              }
            }),
          }
        : {}),
      position: Number(channel.position ?? 0),
      overwrites: Array.isArray(channel.permission_overwrites)
        ? channel.permission_overwrites.map((overwrite) => {
            const value = overwrite as Record<string, unknown>
            return {
              id: String(value.id),
              type: Number(value.type) === 1 ? ('member' as const) : ('role' as const),
              allow: String(value.allow ?? '0'),
              deny: String(value.deny ?? '0'),
            }
          })
        : [],
    })),
    ...(welcomeScreen === null ? {} : { welcomeScreen }),
    ...(onboarding === null ? {} : { onboarding }),
    autoModerationRules,
  }
  return {
    guild,
    onboarding,
    welcomeScreen,
    autoModerationRules,
    snapshot,
    botEffectivePermissions: explainPermissions({
      snapshot,
      memberId: botId,
      roleIds: snapshot.botRoleIds,
    }),
  }
}

export const registerBlueprintTools = ({
  server,
  rest,
  dispatcher,
  principal,
  database,
  previewKey,
  metrics,
  attempt,
  runEffect,
}: BlueprintToolDependencies): void => {
  const previews = new PreviewTokens(previewKey ?? Buffer.alloc(32, 7))

  const PermissionsInput = Schema.Struct({
    snapshot: GuildSnapshotSchema,
    memberId: Schema.String,
    roleIds: Schema.Array(Schema.String),
    channelId: Schema.optionalKey(Schema.String),
  })
  server.registerTool(
    'discord_permissions_explain',
    {
      description: 'Compute named effective Discord permissions and explain every overwrite stage.',
      inputSchema: McpInput(PermissionsInput),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) =>
      attempt(() => {
        requireScopes(principal, ['server:plan'])
        return explainPermissions({
          snapshot: args.snapshot as GuildSnapshot,
          memberId: args.memberId,
          roleIds: args.roleIds,
          ...(args.channelId === undefined ? {} : { channelId: args.channelId }),
        })
      }),
  )

  const GuildInspectInput = Schema.Struct({ guildId: Schema.String })
  for (const [name, description] of [
    ['discord_guild_inspect', 'Inspect guild settings and a normalized blueprint snapshot.'],
    ['discord_server_snapshot', 'Capture a normalized guild snapshot for blueprint planning.'],
  ] as const) {
    server.registerTool(
      name,
      {
        description,
        inputSchema: McpInput(GuildInspectInput),
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      },
      async ({ guildId }, context) =>
        attempt(() => {
          requireScopes(principal, ['mcp:read'])
          return captureGuild(rest, runEffect, guildId, context.mcpReq.signal)
        }),
    )
  }

  const BlueprintPlanInput = Schema.Struct({
    blueprintId: Schema.optionalKey(Schema.String),
    revision: Schema.optionalKey(Schema.Int),
    blueprint: Schema.optionalKey(ServerBlueprintSchema),
    snapshot: GuildSnapshotSchema,
    bindings: Schema.optionalKey(BlueprintBindingsSchema),
    deleteManaged: Schema.optionalKey(Schema.Boolean),
  })
  server.registerTool(
    'discord_server_blueprint_plan',
    {
      description:
        'Plan an idempotent server reconciliation locally. Planning never mutates Discord.',
      inputSchema: McpInput(BlueprintPlanInput),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) =>
      attempt(() => {
        requireScopes(principal, ['server:plan'])
        let blueprint = args.blueprint as ServerBlueprint | undefined
        let bindings = args.bindings as BlueprintBindings | undefined
        if (database) {
          if (!args.blueprintId) {
            throw new Error('blueprintId is required; planning operates on published revisions')
          }
          const published = new VersionedDocumentStore(database, 'server-blueprint').getPublished(
            args.blueprintId,
            args.revision,
            principal.id,
          )
          blueprint = {
            ...(published.document as ServerBlueprint),
            id: args.blueprintId,
            revision: published.revision,
          }
          bindings = loadBlueprintBindings(database, args.blueprintId)
        }
        if (!blueprint) throw new Error('blueprint is required')
        const plan = planBlueprint({
          blueprint,
          snapshot: args.snapshot as GuildSnapshot,
          bindings: bindings ?? { roles: {}, channels: {} },
          ...(args.deleteManaged === undefined ? {} : { deleteManaged: args.deleteManaged }),
        })
        return {
          ...plan,
          previewToken: previews.issue({
            principalId: principal.id,
            guildId: blueprint.guildId,
            blueprintDigest: plan.blueprintDigest,
            snapshotDigest: plan.snapshotDigest,
            actionsDigest: digest(plan.actions),
          }),
          expiresInMs: 60_000,
        }
      }),
  )

  const BlueprintApplyInput = Schema.Struct({
    blueprintId: Schema.String,
    revision: Schema.optionalKey(Schema.Int),
    deleteManaged: Schema.optionalKey(Schema.Boolean),
    previewToken: Schema.String,
    resumeExecutionId: Schema.optionalKey(Schema.String),
  })
  server.registerTool(
    'discord_server_blueprint_apply',
    {
      description:
        'Apply an exact published blueprint plan with a bound preview token and durable resume journal.',
      inputSchema: McpInput(BlueprintApplyInput),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args, context) =>
      attempt(async () => {
        requireScopes(principal, ['server:apply'])
        if (args.deleteManaged === true) requireScopes(principal, ['mcp:destructive'])
        if (!database) throw new Error('blueprint persistence is unavailable')
        const published = new VersionedDocumentStore(database, 'server-blueprint').getPublished(
          args.blueprintId,
          args.revision,
          principal.id,
        )
        const blueprint: ServerBlueprint = {
          ...(published.document as ServerBlueprint),
          id: args.blueprintId,
          revision: published.revision,
        }
        const currentSnapshot = (
          await captureGuild(rest, runEffect, blueprint.guildId, context.mcpReq.signal)
        ).snapshot
        const plan = planBlueprint({
          blueprint,
          snapshot: currentSnapshot,
          bindings: loadBlueprintBindings(database, args.blueprintId),
          ...(args.deleteManaged === undefined ? {} : { deleteManaged: args.deleteManaged }),
        })
        previews.verify(args.previewToken, {
          principalId: principal.id,
          guildId: blueprint.guildId,
          blueprintDigest: plan.blueprintDigest,
          snapshotDigest: plan.snapshotDigest,
          actionsDigest: digest(plan.actions),
        })
        const applier = new BlueprintApplier(
          new SqliteBlueprintJournal(database, args.blueprintId, published.revision, principal.id),
          new BlueprintDiscordExecutor(
            database,
            dispatcher,
            principal.id,
            args.blueprintId,
            blueprint.guildId,
          ),
        )
        const started = performance.now()
        try {
          const result = await applier.apply(plan, args.resumeExecutionId)
          metrics?.increment('discord_mcp_blueprint_apply_total', { outcome: 'success' })
          metrics?.observe(
            'discord_mcp_blueprint_apply_duration_milliseconds',
            performance.now() - started,
            { outcome: 'success' },
          )
          return result
        } catch (cause) {
          metrics?.increment('discord_mcp_blueprint_apply_total', { outcome: 'failure' })
          metrics?.observe(
            'discord_mcp_blueprint_apply_duration_milliseconds',
            performance.now() - started,
            { outcome: 'failure' },
          )
          throw cause
        }
      }),
  )
}
