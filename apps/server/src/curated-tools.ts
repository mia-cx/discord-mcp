import { type Principal, requireScopes, type Scope } from '@discord-mcp/auth'
import { JsonValueSchema, McpInput } from '@discord-mcp/core'
import {
  type CatalogOperation,
  curatedOperationInputSchema,
  curatedOperationOutputSchema,
  type DiscordDispatcher,
  type DispatchInput,
  operationCatalog,
} from '@discord-mcp/discord-api'
import { permissionBits } from '@discord-mcp/discord-blueprints'
import type { CallToolResult, McpServer } from '@modelcontextprotocol/server'
import { Effect, Schema } from 'effect'

interface CuratedOperation {
  readonly name: string
  readonly operationId: string
  readonly description: string
}

const definitions: ReadonlyArray<readonly [string, string, string]> = [
  ['guild_list', 'list_my_guilds', 'List Discord guilds visible to the selected profile.'],
  ['channel_list', 'list_guild_channels', 'List every channel in a guild.'],
  ['channel_get', 'get_channel', 'Get one channel.'],
  ['member_list', 'list_guild_members', 'List guild members with cursor pagination.'],
  ['member_get', 'get_guild_member', 'Get one guild member.'],
  ['member_search', 'search_guild_members', 'Search guild members by name.'],
  ['role_list', 'list_guild_roles', 'List guild roles and hierarchy positions.'],
  ['message_get', 'get_message', 'Get one message.'],
  ['message_list', 'list_messages', 'List messages in a channel.'],
  ['message_delete', 'delete_message', 'Delete one message.'],
  ['message_bulk_delete', 'bulk_delete_messages', 'Bulk-delete recent channel messages.'],
  ['message_crosspost', 'crosspost_message', 'Crosspost a news-channel message.'],
  ['message_thread_create', 'create_thread_from_message', 'Create a thread from a message.'],
  ['channel_create', 'create_guild_channel', 'Create a guild channel.'],
  ['channel_update', 'update_channel', 'Update a channel or thread.'],
  ['channel_delete', 'delete_channel', 'Delete a channel.'],
  ['channel_reorder', 'bulk_update_guild_channels', 'Atomically reorder guild channels.'],
  [
    'channel_overwrite_set',
    'set_channel_permission_overwrite',
    'Set a channel permission overwrite.',
  ],
  [
    'channel_overwrite_delete',
    'delete_channel_permission_overwrite',
    'Delete a channel permission overwrite.',
  ],
  ['forum_post_create', 'create_thread', 'Create a post in a forum or media channel.'],
  ['thread_list', 'get_active_guild_threads', 'List active guild threads.'],
  ['thread_update', 'update_channel', 'Update thread metadata.'],
  ['role_create', 'create_guild_role', 'Create a guild role.'],
  ['role_update', 'update_guild_role', 'Update a guild role.'],
  ['role_delete', 'delete_guild_role', 'Delete a guild role.'],
  ['role_reorder', 'bulk_update_guild_roles', 'Atomically reorder guild roles.'],
  ['role_assign', 'add_guild_member_role', 'Assign a role to a member.'],
  ['role_remove', 'delete_guild_member_role', 'Remove a role from a member.'],
  ['member_update', 'update_guild_member', 'Update guild member properties.'],
  ['member_timeout', 'update_guild_member', 'Apply or clear a guild member timeout.'],
  ['member_kick', 'delete_guild_member', 'Kick a member from a guild.'],
  ['member_ban', 'ban_user_from_guild', 'Ban a user from a guild.'],
  ['member_unban', 'unban_user_from_guild', 'Remove a guild ban.'],
  ['ban_list', 'list_guild_bans', 'List guild bans.'],
  ['automod_rule_list', 'list_auto_moderation_rules', 'List AutoMod rules.'],
  ['automod_rule_create', 'create_auto_moderation_rule', 'Create an AutoMod rule.'],
  ['automod_rule_update', 'update_auto_moderation_rule', 'Update an AutoMod rule.'],
  ['automod_rule_delete', 'delete_auto_moderation_rule', 'Delete an AutoMod rule.'],
  ['audit_log_list', 'list_guild_audit_log_entries', 'List Discord guild audit-log entries.'],
  ['webhook_list', 'get_guild_webhooks', 'List guild webhooks.'],
  ['webhook_create', 'create_webhook', 'Create a webhook.'],
  ['webhook_delete', 'delete_webhook', 'Delete a webhook.'],
  ['invite_create', 'create_channel_invite', 'Create a channel invite.'],
  ['invite_list', 'list_guild_invites', 'List guild invites.'],
  ['invite_revoke', 'invite_revoke', 'Revoke an invite.'],
  ['scheduled_event_list', 'list_guild_scheduled_events', 'List guild scheduled events.'],
  ['scheduled_event_create', 'create_guild_scheduled_event', 'Create a scheduled event.'],
  ['scheduled_event_update', 'update_guild_scheduled_event', 'Update a scheduled event.'],
  ['scheduled_event_delete', 'delete_guild_scheduled_event', 'Delete a scheduled event.'],
  ['emoji_list', 'list_guild_emojis', 'List guild emoji.'],
  ['emoji_create', 'create_guild_emoji', 'Create a guild emoji.'],
  ['emoji_delete', 'delete_guild_emoji', 'Delete a guild emoji.'],
  ['sticker_list', 'list_guild_stickers', 'List guild stickers.'],
  ['sticker_create', 'create_guild_sticker', 'Create a guild sticker.'],
  ['sticker_delete', 'delete_guild_sticker', 'Delete a guild sticker.'],
  ['bot_get_profile', 'get_my_user', 'Get the bot user profile.'],
  ['bot_update_profile', 'update_my_user', 'Update the bot user profile.'],
  ['application_get', 'get_my_application', 'Get the current Discord application.'],
  ['application_update', 'update_my_application', 'Update the current Discord application.'],
  [
    'application_command_list',
    'list_guild_application_commands',
    'List application commands in a guild.',
  ],
  [
    'application_command_publish',
    'bulk_set_guild_application_commands',
    'Publish the exact guild command set.',
  ],
  [
    'application_command_delete',
    'delete_guild_application_command',
    'Delete a guild application command.',
  ],
]

export const curatedCatalogOperations: ReadonlyArray<CuratedOperation> = definitions.map(
  ([name, operationId, description]) => ({
    name: `discord_${name}`,
    operationId,
    description,
  }),
)

export const curatedToolsForOperation = (operationId: string): ReadonlyArray<string> =>
  curatedCatalogOperations
    .filter((operation) => operation.operationId === operationId)
    .map((operation) => operation.name)

export const curatedOperationForTool = (name: string): CatalogOperation | undefined => {
  const operationId = curatedCatalogOperations.find(
    (operation) => operation.name === name,
  )?.operationId
  return operationId === undefined ? undefined : operationCatalog.get(operationId)
}

interface CuratedArgs {
  readonly authProfile?: string
  readonly authMode?: 'bot' | 'oauth2' | 'webhook' | 'interaction'
  readonly path?: Readonly<Record<string, string>>
  readonly query?: Readonly<Record<string, unknown>>
  readonly body?: unknown
  readonly secretRefs?: Readonly<Record<string, string>>
  readonly auditLogReason?: string
  readonly previewToken?: string
  readonly files?: ReadonlyArray<{
    readonly blobId: string
    readonly filename?: string
    readonly contentType?: string
  }>
  readonly previewOnly?: boolean
}

const requiredScope = (risk: string): Scope =>
  risk === 'read'
    ? 'mcp:read'
    : risk === 'destructive'
      ? 'mcp:destructive'
      : risk === 'bot_admin'
        ? 'bot:admin'
        : 'mcp:write'

const semanticTools = new Set([
  'discord_channel_create',
  'discord_channel_overwrite_set',
  'discord_channel_overwrite_delete',
  'discord_role_create',
  'discord_role_update',
  'discord_role_delete',
  'discord_role_assign',
  'discord_role_remove',
  'discord_member_timeout',
])

export const registerCuratedCatalogTools = (
  server: McpServer,
  dispatcher: DiscordDispatcher,
  principal: Principal,
  attempt: (
    run: () => unknown | Promise<unknown>,
    metadata?: { readonly operationId?: string; readonly authProfile?: string },
  ) => Promise<CallToolResult>,
): void => {
  const names = new Set<string>()
  for (const definition of curatedCatalogOperations) {
    if (names.has(definition.name)) throw new Error(`Duplicate curated tool: ${definition.name}`)
    names.add(definition.name)
    const operation = operationCatalog.describe(definition.operationId)
    if (operation.risk === 'credential') {
      throw new Error(`Curated tool ${definition.name} cannot expose a credential operation`)
    }
    if (semanticTools.has(definition.name)) continue
    const inputSchema = curatedOperationInputSchema(operation) as unknown as Schema.Codec<
      unknown,
      unknown,
      never,
      never
    >
    const outputSchema = curatedOperationOutputSchema(operation) as unknown as Schema.Codec<
      unknown,
      unknown,
      never,
      never
    >
    server.registerTool(
      definition.name,
      {
        title: definition.description.replace(/\.$/, ''),
        description: `${definition.description} Uses the fixed catalog operation ${definition.operationId}; set previewOnly for guarded calls.`,
        inputSchema: McpInput(inputSchema),
        outputSchema: McpInput(outputSchema),
        annotations: {
          readOnlyHint: operation.risk === 'read',
          destructiveHint: operation.risk === 'destructive' || operation.risk === 'bot_admin',
          idempotentHint: operation.risk === 'read',
          openWorldHint: true,
        },
      },
      async (rawArgs, context) => {
        const args = rawArgs as CuratedArgs
        return attempt(
          async () => {
            requireScopes(principal, [requiredScope(operation.risk)])
            const input: DispatchInput = {
              operationId: definition.operationId,
              ...(args.authProfile === undefined ? {} : { authProfile: args.authProfile }),
              ...(args.authMode === undefined ? {} : { authMode: args.authMode }),
              ...(args.path === undefined ? {} : { path: args.path }),
              ...(args.query === undefined ? {} : { query: args.query }),
              ...(args.body === undefined ? {} : { body: args.body }),
              ...(args.secretRefs === undefined ? {} : { secretRefs: args.secretRefs }),
              ...(args.auditLogReason === undefined ? {} : { auditLogReason: args.auditLogReason }),
              ...(args.previewToken === undefined ? {} : { previewToken: args.previewToken }),
              ...(args.files === undefined ? {} : { files: args.files }),
            }
            if (args.previewOnly) return dispatcher.preview(principal.id, input)
            return Effect.runPromise(
              dispatcher.dispatch<unknown>(principal.id, operation.risk, input),
              {
                signal: context.mcpReq.signal,
              },
            )
          },
          {
            operationId: definition.operationId,
            authProfile: args.authProfile ?? 'bot',
          },
        )
      },
    )
  }
  registerSemanticTools(server, dispatcher, principal, attempt)
}

const ChannelDefinition = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('text'),
    name: Schema.String,
    parentId: Schema.optionalKey(Schema.String),
    topic: Schema.optionalKey(Schema.NullOr(Schema.String)),
    nsfw: Schema.optionalKey(Schema.Boolean),
    rateLimitPerUser: Schema.optionalKey(Schema.Int),
  }),
  Schema.Struct({
    kind: Schema.Literal('announcement'),
    name: Schema.String,
    parentId: Schema.optionalKey(Schema.String),
    topic: Schema.optionalKey(Schema.NullOr(Schema.String)),
    nsfw: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({
    kind: Schema.Literal('voice'),
    name: Schema.String,
    parentId: Schema.optionalKey(Schema.String),
    bitrate: Schema.optionalKey(Schema.Int),
    userLimit: Schema.optionalKey(Schema.Int),
  }),
  Schema.Struct({
    kind: Schema.Literal('stage'),
    name: Schema.String,
    parentId: Schema.optionalKey(Schema.String),
    bitrate: Schema.optionalKey(Schema.Int),
    userLimit: Schema.optionalKey(Schema.Int),
  }),
  Schema.Struct({ kind: Schema.Literal('category'), name: Schema.String }),
  Schema.Struct({
    kind: Schema.Literals(['forum', 'media']),
    name: Schema.String,
    parentId: Schema.optionalKey(Schema.String),
    topic: Schema.optionalKey(Schema.NullOr(Schema.String)),
    nsfw: Schema.optionalKey(Schema.Boolean),
    rateLimitPerUser: Schema.optionalKey(Schema.Int),
    availableTags: Schema.optionalKey(Schema.Array(JsonValueSchema)),
    defaultReactionEmoji: Schema.optionalKey(JsonValueSchema),
    defaultSortOrder: Schema.optionalKey(Schema.Int),
    defaultForumLayout: Schema.optionalKey(Schema.Int),
  }),
])

const channelType: Readonly<Record<string, number>> = {
  text: 0,
  voice: 2,
  category: 4,
  announcement: 5,
  stage: 13,
  forum: 15,
  media: 16,
}

const registerSemanticTools = (
  server: McpServer,
  dispatcher: DiscordDispatcher,
  principal: Principal,
  attempt: (
    run: () => unknown | Promise<unknown>,
    metadata?: { readonly operationId?: string; readonly authProfile?: string },
  ) => Promise<CallToolResult>,
): void => {
  const outputFor = (operationId: string) =>
    McpInput(
      curatedOperationOutputSchema(
        operationCatalog.describe(operationId),
      ) as unknown as Schema.Codec<unknown, unknown, never, never>,
    )
  const dispatch = async (
    operationId: string,
    input: Omit<DispatchInput, 'operationId'>,
    signal: AbortSignal,
    previewOnly = false,
  ) => {
    const operation = operationCatalog.describe(operationId)
    requireScopes(principal, [requiredScope(operation.risk)])
    const full = { operationId, ...input }
    if (previewOnly) return dispatcher.preview(principal.id, full)
    return Effect.runPromise(dispatcher.dispatch(principal.id, operation.risk, full), { signal })
  }
  server.registerTool(
    'discord_channel_create',
    {
      title: 'Create Discord channel',
      description:
        'Create one guild channel from a discriminated semantic kind; kind-specific fields cannot be mixed.',
      inputSchema: McpInput(Schema.Struct({ guildId: Schema.String, channel: ChannelDefinition })),
      outputSchema: outputFor('create_guild_channel'),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ guildId, channel }, context) =>
      attempt(() => {
        const semantic = channel as typeof channel & {
          readonly parentId?: string
          readonly availableTags?: ReadonlyArray<unknown>
          readonly defaultReactionEmoji?: unknown
          readonly defaultSortOrder?: number
          readonly defaultForumLayout?: number
        }
        const {
          kind,
          parentId,
          availableTags,
          defaultReactionEmoji,
          defaultSortOrder,
          defaultForumLayout,
          ...fields
        } = semantic
        return dispatch(
          'create_guild_channel',
          {
            path: { guild_id: guildId },
            body: {
              ...fields,
              type: channelType[kind],
              ...(parentId === undefined ? {} : { parent_id: parentId }),
              ...(availableTags === undefined ? {} : { available_tags: availableTags }),
              ...(defaultReactionEmoji === undefined
                ? {}
                : { default_reaction_emoji: defaultReactionEmoji }),
              ...(defaultSortOrder === undefined ? {} : { default_sort_order: defaultSortOrder }),
              ...(defaultForumLayout === undefined
                ? {}
                : { default_forum_layout: defaultForumLayout }),
            },
          },
          context.mcpReq.signal,
        )
      }),
  )
  const OverwriteInput = Schema.Struct({
    channelId: Schema.String,
    targetId: Schema.String,
    targetType: Schema.Literals(['role', 'member']),
    allow: Schema.optionalKey(Schema.Array(Schema.String)),
    deny: Schema.optionalKey(Schema.Array(Schema.String)),
  })
  server.registerTool(
    'discord_channel_overwrite_set',
    {
      title: 'Set Discord channel permission overwrite',
      description:
        'Set a permission overwrite using named permission flags; the same flag cannot be allowed and denied.',
      inputSchema: McpInput(OverwriteInput),
      outputSchema: outputFor('set_channel_permission_overwrite'),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ channelId, targetId, targetType, allow, deny }, context) =>
      attempt(() => {
        const allowed = new Set(allow ?? [])
        const conflict = (deny ?? []).find((name) => allowed.has(name))
        if (conflict) throw new Error(`${conflict} cannot appear in both allow and deny`)
        return dispatch(
          'set_channel_permission_overwrite',
          {
            path: { channel_id: channelId, overwrite_id: targetId },
            body: {
              type: targetType === 'member' ? 1 : 0,
              allow: permissionBits(allow ?? []).toString(),
              deny: permissionBits(deny ?? []).toString(),
            },
          },
          context.mcpReq.signal,
        )
      }),
  )
  server.registerTool(
    'discord_channel_overwrite_delete',
    {
      title: 'Delete Discord channel permission overwrite',
      description: 'Preview or delete one channel permission overwrite.',
      inputSchema: McpInput(
        Schema.Struct({
          channelId: Schema.String,
          targetId: Schema.String,
          previewOnly: Schema.optionalKey(Schema.Boolean),
          previewToken: Schema.optionalKey(Schema.String),
        }),
      ),
      outputSchema: outputFor('delete_channel_permission_overwrite'),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ channelId, targetId, previewOnly, previewToken }, context) =>
      attempt(() =>
        dispatch(
          'delete_channel_permission_overwrite',
          {
            path: { channel_id: channelId, overwrite_id: targetId },
            ...(previewToken === undefined ? {} : { previewToken }),
          },
          context.mcpReq.signal,
          previewOnly,
        ),
      ),
  )

  const RoleFields = {
    name: Schema.optionalKey(Schema.String),
    permissions: Schema.optionalKey(Schema.Array(Schema.String)),
    color: Schema.optionalKey(Schema.Int),
    hoist: Schema.optionalKey(Schema.Boolean),
    mentionable: Schema.optionalKey(Schema.Boolean),
  }
  server.registerTool(
    'discord_role_create',
    {
      title: 'Create Discord role',
      description: 'Create a role with named permissions after checking the bot holds each grant.',
      inputSchema: McpInput(
        Schema.Struct({ guildId: Schema.String, ...RoleFields, name: Schema.String }),
      ),
      outputSchema: outputFor('create_guild_role'),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ guildId, permissions, color, ...fields }, context) =>
      attempt(async () => {
        await assertCanGrantPermissions(
          dispatcher,
          guildId,
          permissions ?? [],
          context.mcpReq.signal,
        )
        return dispatch(
          'create_guild_role',
          {
            path: { guild_id: guildId },
            body: {
              ...fields,
              permissions: permissionBits(permissions ?? []).toString(),
              ...(color === undefined ? {} : { colors: { primary_color: color } }),
            },
          },
          context.mcpReq.signal,
        )
      }),
  )
  server.registerTool(
    'discord_role_update',
    {
      title: 'Update Discord role',
      description: 'Update a manageable role using named permissions and local hierarchy checks.',
      inputSchema: McpInput(
        Schema.Struct({ guildId: Schema.String, roleId: Schema.String, ...RoleFields }),
      ),
      outputSchema: outputFor('update_guild_role'),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ guildId, roleId, permissions, color, ...fields }, context) =>
      attempt(async () => {
        await assertManageableRole(dispatcher, guildId, roleId, context.mcpReq.signal)
        if (permissions) {
          await assertCanGrantPermissions(dispatcher, guildId, permissions, context.mcpReq.signal)
        }
        return dispatch(
          'update_guild_role',
          {
            path: { guild_id: guildId, role_id: roleId },
            body: {
              ...fields,
              ...(permissions === undefined
                ? {}
                : { permissions: permissionBits(permissions).toString() }),
              ...(color === undefined ? {} : { colors: { primary_color: color } }),
            },
          },
          context.mcpReq.signal,
        )
      }),
  )
  for (const action of ['assign', 'remove'] as const) {
    server.registerTool(
      `discord_role_${action}`,
      {
        title: `${action === 'assign' ? 'Assign' : 'Remove'} Discord role`,
        description: `${action === 'assign' ? 'Assign' : 'Remove'} a locally manageable role for a member.`,
        inputSchema: McpInput(
          Schema.Struct({
            guildId: Schema.String,
            userId: Schema.String,
            roleId: Schema.String,
          }),
        ),
        outputSchema: outputFor(
          action === 'assign' ? 'add_guild_member_role' : 'delete_guild_member_role',
        ),
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      },
      async ({ guildId, userId, roleId }, context) =>
        attempt(async () => {
          await assertManageableRole(dispatcher, guildId, roleId, context.mcpReq.signal)
          return dispatch(
            action === 'assign' ? 'add_guild_member_role' : 'delete_guild_member_role',
            { path: { guild_id: guildId, user_id: userId, role_id: roleId } },
            context.mcpReq.signal,
          )
        }),
    )
  }
  server.registerTool(
    'discord_role_delete',
    {
      title: 'Delete Discord role',
      description:
        'Preview or delete a role after rejecting @everyone, managed roles, and hierarchy violations.',
      inputSchema: McpInput(
        Schema.Struct({
          guildId: Schema.String,
          roleId: Schema.String,
          previewOnly: Schema.optionalKey(Schema.Boolean),
          previewToken: Schema.optionalKey(Schema.String),
        }),
      ),
      outputSchema: outputFor('delete_guild_role'),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ guildId, roleId, previewOnly, previewToken }, context) =>
      attempt(async () => {
        await assertManageableRole(dispatcher, guildId, roleId, context.mcpReq.signal)
        return dispatch(
          'delete_guild_role',
          {
            path: { guild_id: guildId, role_id: roleId },
            ...(previewToken === undefined ? {} : { previewToken }),
          },
          context.mcpReq.signal,
          previewOnly,
        )
      }),
  )
  server.registerTool(
    'discord_member_timeout',
    {
      title: 'Set Discord member timeout',
      description: 'Set or clear a timeout using either a duration in seconds or an absolute time.',
      inputSchema: McpInput(
        Schema.Struct({
          guildId: Schema.String,
          userId: Schema.String,
          durationSeconds: Schema.optionalKey(Schema.Int),
          until: Schema.optionalKey(Schema.String),
          clear: Schema.optionalKey(Schema.Boolean),
          auditLogReason: Schema.optionalKey(Schema.String),
        }),
      ),
      outputSchema: outputFor('update_guild_member'),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ guildId, userId, durationSeconds, until, clear, auditLogReason }, context) =>
      attempt(() => {
        const choices =
          Number(durationSeconds !== undefined) +
          Number(until !== undefined) +
          Number(clear === true)
        if (choices !== 1) throw new Error('choose exactly one of durationSeconds, until, or clear')
        if (durationSeconds !== undefined && (durationSeconds < 1 || durationSeconds > 2_419_200)) {
          throw new Error('durationSeconds must be between 1 and 2419200 (28 days)')
        }
        const timestamp =
          clear === true
            ? null
            : durationSeconds === undefined
              ? new Date(until as string)
              : new Date(Date.now() + durationSeconds * 1_000)
        if (timestamp instanceof Date && Number.isNaN(timestamp.getTime())) {
          throw new Error('until must be a valid timestamp')
        }
        return dispatch(
          'update_guild_member',
          {
            path: { guild_id: guildId, user_id: userId },
            body: {
              communication_disabled_until: timestamp === null ? null : timestamp.toISOString(),
            },
            ...(auditLogReason === undefined ? {} : { auditLogReason }),
          },
          context.mcpReq.signal,
        )
      }),
  )
}

const botRoleState = async (
  dispatcher: DiscordDispatcher,
  guildId: string,
  signal: AbortSignal,
) => {
  const [roles, user] = await Promise.all([
    Effect.runPromise(
      dispatcher.rest.request<ReadonlyArray<Record<string, unknown>>>(
        'GET',
        `/guilds/${guildId}/roles`,
      ),
      { signal },
    ),
    Effect.runPromise(dispatcher.rest.request<Record<string, unknown>>('GET', '/users/@me'), {
      signal,
    }),
  ])
  const member = await Effect.runPromise(
    dispatcher.rest.request<Record<string, unknown>>(
      'GET',
      `/guilds/${guildId}/members/${String(user.id)}`,
    ),
    { signal },
  )
  const botRoleIds = new Set(Array.isArray(member.roles) ? member.roles.map(String) : [])
  const botRoles = roles.filter(({ id }) => botRoleIds.has(String(id)))
  const permissions = botRoles.reduce(
    (bits, role) => bits | BigInt(String(role.permissions ?? '0')),
    BigInt(String(roles.find(({ id }) => String(id) === guildId)?.permissions ?? '0')),
  )
  return {
    roles,
    permissions,
    highest: Math.max(-1, ...botRoles.map(({ position }) => Number(position ?? -1))),
  }
}

const assertManageableRole = async (
  dispatcher: DiscordDispatcher,
  guildId: string,
  roleId: string,
  signal: AbortSignal,
): Promise<void> => {
  if (roleId === guildId) throw new Error('@everyone cannot be mutated as a normal role')
  const state = await botRoleState(dispatcher, guildId, signal)
  const role = state.roles.find(({ id }) => String(id) === roleId)
  if (!role) throw new Error(`role ${roleId} does not exist`)
  if (role.managed === true) throw new Error('managed/integration roles cannot be mutated')
  if (Number(role.position ?? 0) >= state.highest) {
    throw new Error('target role is at or above the bot hierarchy; move the bot role first')
  }
}

const assertCanGrantPermissions = async (
  dispatcher: DiscordDispatcher,
  guildId: string,
  permissions: ReadonlyArray<string>,
  signal: AbortSignal,
): Promise<void> => {
  const requested = permissionBits(permissions)
  const held = (await botRoleState(dispatcher, guildId, signal)).permissions
  if ((held & permissionBits(['Administrator'])) === 0n && (held & requested) !== requested) {
    throw new Error('the role grants named permissions the bot does not hold')
  }
}
