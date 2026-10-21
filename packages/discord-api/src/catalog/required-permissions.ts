import type { PermissionName } from '../permissions.ts'
import { source } from './generated/index.ts'
import type { OperationEntry } from './types.ts'

/**
 * What Discord requires of the caller before it performs each cataloged operation.
 *
 * Discord's OpenAPI document carries no permission metadata, so this table is maintained by hand
 * from Discord's developer documentation and checked for coverage by `pnpm spec:check`. A relay
 * that acts for a person, not for the bot, reads it to decide which operations that person may
 * reach, then re-checks each call against the person's effective permissions from
 * {@link computeEffectivePermissions}.
 *
 * Each rule is conservative on its own terms. A consumer that skips a part of a rule it cannot
 * verify ends up stricter than the rule, never looser:
 *
 * - `requires: 'none'` means Discord checks no permission bit and no ownership beyond a valid
 *   token. Routes on the caller's own account (`@me`) are `none`: the token is the ownership.
 * - `requires: 'unknown'` means Discord documents nothing for this route. Treat it as denied.
 * - `requires: 'any-of'` is satisfied by any one grant in `anyOf`. A grant holds when every
 *   permission is present in its scope and, if it has `only`, that condition is verified. A grant
 *   whose `only` the consumer cannot verify does not hold.
 * - Each `conditional` adds a requirement when its `when` holds. A consumer that cannot decide
 *   `when` from the request must assume it holds.
 * - `hierarchy` rules compare role positions on top of the grants. A consumer that does not
 *   evaluate them must not treat the operation as allowed.
 *
 * Scopes name where Discord computes permissions. Guild scope uses guild-level role permissions;
 * an empty permission list there means guild membership alone. Channel scope applies channel
 * overwrites as well, and always lists `ViewChannel`, because without it Discord ignores every
 * other channel permission. Threads inherit their parent's permissions. Channel requirements apply
 * to guild channels only: DM and group DM channels have no permission bits, only recipients.
 *
 * Where an endpoint's documentation names no permission, the entry requires only access to its
 * scope. Effects without a rejection still count: `MentionEveryone` is listed where the call would
 * otherwise ping everyone, because a relay must not let a person do that through the bot.
 *
 * This table and `computeEffectivePermissions` together are not a complete authorization engine
 * for a person. They state which permissions each operation needs; the consumer must enforce the
 * rest itself:
 *
 * - Timeouts. A timed-out member, unless owner or administrator, keeps only `ViewChannel` and
 *   `ReadMessageHistory`. `computeEffectivePermissions` does not model this.
 * - Thread access. Resolve a thread with its parent's overwrites. Private threads also need thread
 *   membership or `ManageThreads`, which nothing here checks.
 * - Resource scope. The resolver computes permission bits only. The consumer verifies each `only`
 *   and `when`, such as authorship or a body field, against the request and its target.
 * - Response filtering. Guild-wide reads return what the bot can see, not what the person can see.
 * - Rendering-only permissions. `EmbedLinks` and `UseExternalEmojis` are not listed, so a call that
 *   passes this table still renders with the bot's permissions.
 */
export type PermissionScope = { readonly level: 'guild' | 'channel' } & (
  | {
      /** The path parameter holding the guild or channel ID. */
      readonly pathParam: string
      readonly lookup?: never
    }
  | {
      /** Where to find the ID when no path parameter holds it: a body field or a fetched resource. */
      readonly lookup: string
      readonly pathParam?: never
    }
)

export interface PermissionGrant {
  /** Every one of these, evaluated in `scope`. */
  readonly permissions: ReadonlyArray<PermissionName>
  /** Absent only for grants that rest entirely on `only`. */
  readonly scope?: PermissionScope
  /** A further condition that is not a permission bit: ownership, authorship, a held token. */
  readonly only?: string
}

/** One or more grants; at least one must hold. */
export type Grants = readonly [PermissionGrant, ...PermissionGrant[]]

export interface ConditionalRequirement {
  /** A property of the request or its target, such as a body field being set. */
  readonly when: string
  readonly anyOf: Grants
}

export type HierarchyRule = 'member-below' | 'role-below' | 'held-permissions-only'

export const hierarchyRules: Readonly<Record<HierarchyRule, string>> = {
  'member-below':
    "The target member's highest role must be below the caller's highest role, and the target cannot be the guild owner. The guild owner is exempt as caller.",
  'role-below':
    "Each target role must be below the caller's highest role. Managed roles cannot be assigned or edited. The guild owner is exempt.",
  'held-permissions-only':
    'The caller can allow or deny only permissions it holds itself. Administrator and the guild owner hold every permission.',
}

export interface HierarchyRequirement {
  readonly rule: HierarchyRule
  /** What the rule compares against, such as the `user_id` path parameter or a body field. */
  readonly target: string
}

export type OperationPermissions =
  | {
      readonly requires: 'none' | 'unknown'
      readonly note: string
      readonly sources: ReadonlyArray<string>
    }
  | {
      readonly requires: 'any-of'
      readonly anyOf: Grants
      readonly conditional?: ReadonlyArray<ConditionalRequirement>
      readonly hierarchy?: ReadonlyArray<HierarchyRequirement>
      readonly note?: string
      readonly sources: ReadonlyArray<string>
    }

/** The documentation revision this table was last checked against. */
export const permissionSources = {
  docs: 'https://github.com/discord/discord-api-docs',
  docsCommit: 'fd75e22e8c327f60c3ceaa366878c8b223043142',
  checkedOn: '2026-10-22',
  spec: `https://github.com/discord/discord-api-spec/blob/${source.commit}/specs/openapi.json`,
} as const

const docs = (anchor: string) => `https://docs.discord.com/developers/${anchor}`
const SPEC = permissionSources.spec
const FLAGS = docs('topics/permissions#permissions-bitwise-permission-flags')
const ALLOWED_MENTIONS = docs('resources/message#allowed-mentions-object')
const HIERARCHY = docs('topics/permissions#permission-hierarchy')
const IMPLICIT = docs('topics/permissions#implicit-permissions')
const THREADS = docs('topics/threads#editing-%26-deleting-threads')
const EVENTS = docs(
  'resources/guild-scheduled-event#guild-scheduled-event-permissions-requirements',
)
const STAGE_MODERATOR = docs('resources/stage-instance#definitions')

const GUILD: PermissionScope = { level: 'guild', pathParam: 'guild_id' }
const CHANNEL: PermissionScope = { level: 'channel', pathParam: 'channel_id' }

const inGuild = (...permissions: PermissionName[]): PermissionGrant => ({
  permissions,
  scope: GUILD,
})
const inChannel = (...permissions: PermissionName[]): PermissionGrant => ({
  permissions: ['ViewChannel', ...permissions],
  scope: CHANNEL,
})
const inChannelAt = (lookup: string, ...permissions: PermissionName[]): PermissionGrant => ({
  permissions: ['ViewChannel', ...permissions],
  scope: { level: 'channel', lookup },
})
const inGuildAt = (lookup: string, ...permissions: PermissionName[]): PermissionGrant => ({
  permissions,
  scope: { level: 'guild', lookup },
})
const holding = (only: string, grant: PermissionGrant = { permissions: [] }): PermissionGrant => ({
  ...grant,
  only,
})
const when = (condition: string, ...anyOf: Grants): ConditionalRequirement => ({
  when: condition,
  anyOf,
})

const requires = (
  anyOf: Grants,
  sources: ReadonlyArray<string>,
  extra: {
    readonly conditional?: ReadonlyArray<ConditionalRequirement>
    readonly hierarchy?: ReadonlyArray<HierarchyRequirement>
    readonly note?: string
  } = {},
): OperationPermissions => ({ requires: 'any-of', anyOf, ...extra, sources })
const none = (note: string, ...sources: string[]): OperationPermissions => ({
  requires: 'none',
  note,
  sources,
})
const unknown = (note: string): OperationPermissions => ({
  requires: 'unknown',
  note,
  sources: [SPEC],
})

const OWN_APPLICATION = holding(
  "application_id is the caller's own application: its bot token, or a client-credentials Bearer token for it.",
)
const WEBHOOK_TOKEN = holding(
  "The path's webhook_token is the webhook's token, or for interaction responses the interaction token.",
)
const OWN_LOBBY = holding(
  "lobby_id belongs to the caller's application (bot token), or the caller is a lobby member (Bearer token).",
)
const WEBHOOK_CHANNEL = "the webhook's channel_id (GET /webhooks/{webhook_id})"
const INVITE_CHANNEL = "the invite's channel (GET /invites/{code})"
const INVITE_GUILD = "the invite's guild (GET /invites/{code})"
const EVENT_CHANNEL = "the event's channel_id (GET the scheduled event)"
const MESSAGE_AUTHOR = 'The caller authored the message.'
const VOICE_CHANNEL = when('channel_id is a voice channel', inChannel('Connect'))
const NOT_THREAD_SEND = when('channel_id is not a thread', inChannel('SendMessages'))
const THREAD_SEND = when('channel_id is a thread', inChannel('SendMessagesInThreads'))
const TARGET_MEMBER: HierarchyRequirement = { rule: 'member-below', target: 'user_id' }

/** Edit and delete rules shared by emojis, stickers, and soundboard sounds. */
const expression = (anchor: string, kind: string) =>
  requires(
    [
      inGuild('ManageGuildExpressions'),
      holding(`The caller created the ${kind}.`, inGuild('CreateGuildExpressions')),
    ],
    [docs(anchor)],
  )
const expressionRead = (anchor: string, field: string) =>
  requires([inGuild()], [docs(anchor)], {
    note: `${field} included only with CreateGuildExpressions or ManageGuildExpressions.`,
  })

/** Modify and delete rules for a scheduled event, which depend on its entity type. */
const eventChange = (anchor: string) =>
  requires([inGuild()], [docs(anchor), EVENTS], {
    conditional: [
      when(
        'the event is EXTERNAL',
        inGuild('ManageEvents'),
        holding('The caller created the event.', inGuild('CreateEvents')),
      ),
      when(
        'the event is a STAGE_INSTANCE event',
        inChannelAt(EVENT_CHANNEL, 'ManageEvents', 'ManageChannels', 'MuteMembers', 'MoveMembers'),
        holding(
          'The caller created the event.',
          inChannelAt(
            EVENT_CHANNEL,
            'CreateEvents',
            'ManageChannels',
            'MuteMembers',
            'MoveMembers',
          ),
        ),
      ),
      when(
        'the event is a VOICE event',
        inChannelAt(EVENT_CHANNEL, 'ManageEvents', 'Connect'),
        holding(
          'The caller created the event.',
          inChannelAt(EVENT_CHANNEL, 'CreateEvents', 'Connect'),
        ),
      ),
    ],
  })
const eventRead = (anchor: string) =>
  requires([inGuild()], [docs(anchor), EVENTS], {
    conditional: [when('the event has a channel_id', inChannelAt(EVENT_CHANNEL))],
  })

const ownApplication = (anchor?: string, note?: string) =>
  requires([OWN_APPLICATION], anchor === undefined ? [SPEC] : [docs(anchor)], {
    ...(note === undefined ? {} : { note }),
  })
const webhookToken = (anchor: string) => requires([WEBHOOK_TOKEN], [docs(anchor)])
const ownLobby = (anchor: string) => requires([OWN_LOBBY], [docs(anchor)])

/** Keyed by operation ID. `spec:check` fails when an operation is missing or an entry is stale. */
export const operationPermissions: Readonly<Record<string, OperationPermissions>> = {
  // ------------------------------------------------------------------ application & commands
  get_my_application: none(
    "Returns the caller's own application.",
    docs('resources/application#get-current-application'),
  ),
  update_my_application: none(
    "Edits the caller's own application.",
    docs('resources/application#edit-current-application'),
  ),
  get_application: ownApplication(
    undefined,
    'Undocumented route; the by-ID form of GET /applications/@me.',
  ),
  update_application: ownApplication(
    undefined,
    'Undocumented route; the by-ID form of PATCH /applications/@me.',
  ),
  upload_application_attachment: ownApplication(undefined, 'Undocumented route.'),
  applications_get_activity_instance: ownApplication(
    'resources/application#get-application-activity-instance',
  ),
  get_application_role_connections_metadata: ownApplication(
    'resources/application-role-connection-metadata#get-application-role-connection-metadata-records',
  ),
  update_application_role_connections_metadata: ownApplication(
    'resources/application-role-connection-metadata#update-application-role-connection-metadata-records',
  ),
  list_application_emojis: ownApplication('resources/emoji#list-application-emojis'),
  get_application_emoji: ownApplication('resources/emoji#get-application-emoji'),
  create_application_emoji: ownApplication('resources/emoji#create-application-emoji'),
  update_application_emoji: ownApplication('resources/emoji#modify-application-emoji'),
  delete_application_emoji: ownApplication('resources/emoji#delete-application-emoji'),
  list_application_commands: ownApplication(
    'interactions/application-commands#get-global-application-commands',
  ),
  get_application_command: ownApplication(
    'interactions/application-commands#get-global-application-command',
  ),
  create_application_command: ownApplication(
    'interactions/application-commands#create-global-application-command',
  ),
  update_application_command: ownApplication(
    'interactions/application-commands#edit-global-application-command',
  ),
  delete_application_command: ownApplication(
    'interactions/application-commands#delete-global-application-command',
  ),
  bulk_set_application_commands: ownApplication(
    'interactions/application-commands#bulk-overwrite-global-application-commands',
  ),
  list_guild_application_commands: ownApplication(
    'interactions/application-commands#get-guild-application-commands',
  ),
  get_guild_application_command: ownApplication(
    'interactions/application-commands#get-guild-application-command',
  ),
  create_guild_application_command: ownApplication(
    'interactions/application-commands#create-guild-application-command',
  ),
  update_guild_application_command: ownApplication(
    'interactions/application-commands#edit-guild-application-command',
  ),
  delete_guild_application_command: ownApplication(
    'interactions/application-commands#delete-guild-application-command',
  ),
  bulk_set_guild_application_commands: ownApplication(
    'interactions/application-commands#bulk-overwrite-guild-application-commands',
  ),
  list_guild_application_command_permissions: ownApplication(
    'interactions/application-commands#get-guild-application-command-permissions',
  ),
  get_guild_application_command_permissions: ownApplication(
    'interactions/application-commands#get-application-command-permissions',
  ),
  set_guild_application_command_permissions: requires(
    [
      holding(
        'A Bearer token with applications.commands.permissions.update for application_id, from a user who can run the command and manage every affected role, user, and channel. Bot tokens are rejected.',
        inGuild('ManageGuild', 'ManageRoles'),
      ),
    ],
    [
      docs('interactions/application-commands#edit-application-command-permissions'),
      docs('interactions/application-commands#permissions'),
    ],
  ),

  // ------------------------------------------------------------------ monetization
  get_entitlements: ownApplication('resources/entitlement#list-entitlements'),
  get_entitlement: ownApplication('resources/entitlement#get-entitlement'),
  consume_entitlement: ownApplication('resources/entitlement#consume-an-entitlement'),
  create_entitlement: ownApplication('resources/entitlement#create-test-entitlement'),
  delete_entitlement: ownApplication('resources/entitlement#delete-test-entitlement'),
  get_current_user_application_entitlements: requires(
    [holding('A Bearer token for the user, issued to application_id.')],
    [SPEC],
    { note: 'Undocumented route.' },
  ),
  get_sku_subscriptions: requires(
    [holding("sku_id belongs to the caller's application.")],
    [docs('resources/subscription#list-sku-subscriptions')],
  ),
  get_sku_subscription: requires(
    [holding("sku_id belongs to the caller's application.")],
    [docs('resources/subscription#get-sku-subscription')],
  ),

  // ------------------------------------------------------------------ audit log & automod
  list_guild_audit_log_entries: requires(
    [inGuild('ViewAuditLog')],
    [docs('resources/audit-log#get-guild-audit-log')],
  ),
  list_auto_moderation_rules: requires(
    [inGuild('ManageGuild')],
    [docs('resources/auto-moderation#list-auto-moderation-rules-for-guild')],
  ),
  get_auto_moderation_rule: requires(
    [inGuild('ManageGuild')],
    [docs('resources/auto-moderation#get-auto-moderation-rule')],
  ),
  create_auto_moderation_rule: requires(
    [inGuild('ManageGuild')],
    [docs('resources/auto-moderation#create-auto-moderation-rule')],
  ),
  update_auto_moderation_rule: requires(
    [inGuild('ManageGuild')],
    [docs('resources/auto-moderation#modify-auto-moderation-rule')],
  ),
  delete_auto_moderation_rule: requires(
    [inGuild('ManageGuild')],
    [docs('resources/auto-moderation#delete-auto-moderation-rule')],
  ),

  // ------------------------------------------------------------------ channels
  get_channel: requires([inChannel()], [docs('resources/channel#get-channel'), IMPLICIT]),
  update_channel: requires([inChannel()], [docs('resources/channel#modify-channel'), THREADS], {
    conditional: [
      when('channel_id is not a thread', inChannel('ManageChannels')),
      when(
        'channel_id is a thread',
        inChannel('ManageThreads'),
        holding(
          'The caller created the thread and the request changes only name, archived, or auto_archive_duration.',
          inChannel(),
        ),
        holding(
          'The thread is unlocked and the request only sets archived to false.',
          inChannel('SendMessages'),
        ),
      ),
      when('the body sets permission_overwrites', inChannel('ManageRoles')),
    ],
    hierarchy: [{ rule: 'held-permissions-only', target: 'body permission_overwrites' }],
    note: 'Overwrites may also grant permissions the caller holds only through a ManageRoles overwrite in this channel.',
  }),
  update_voice_channel_status: requires(
    [inChannel('SetVoiceChannelStatus')],
    [docs('resources/channel#set-voice-channel-status')],
    {
      conditional: [
        when('the caller is not connected to the voice channel', inChannel('ManageChannels')),
      ],
    },
  ),
  delete_channel: requires([inChannel()], [docs('resources/channel#delete/close-channel')], {
    conditional: [
      when('channel_id is not a thread', inChannel('ManageChannels')),
      when('channel_id is a thread', inChannel('ManageThreads')),
    ],
  }),
  set_channel_permission_overwrite: requires(
    [inChannel('ManageRoles')],
    [docs('resources/channel#edit-channel-permissions')],
    {
      hierarchy: [{ rule: 'held-permissions-only', target: 'body allow and deny' }],
      note: 'A ManageRoles overwrite in this channel lets the caller set permissions it does not otherwise hold.',
    },
  ),
  delete_channel_permission_overwrite: requires(
    [inChannel('ManageRoles')],
    [docs('resources/channel#delete-channel-permission')],
  ),
  list_channel_invites: requires(
    [inChannel('ManageChannels')],
    [docs('resources/channel#get-channel-invites')],
  ),
  create_channel_invite: requires(
    [inChannel('CreateInstantInvite')],
    [docs('resources/channel#create-channel-invite')],
    {
      conditional: [
        when('the body sets role_ids', inGuildAt("the channel's guild", 'ManageRoles')),
      ],
      note: 'role_ids cannot include roles with more permissions than the caller.',
    },
  ),
  follow_channel: requires(
    [inChannelAt('body webhook_channel_id (the target channel)', 'ManageWebhooks')],
    [docs('resources/channel#follow-announcement-channel')],
  ),
  trigger_typing_indicator: requires(
    [inChannel()],
    [docs('resources/channel#trigger-typing-indicator')],
    {
      conditional: [NOT_THREAD_SEND, THREAD_SEND],
      note: 'The docs name no permission; Discord rejects typing where the caller cannot send messages.',
    },
  ),
  add_group_dm_user: requires(
    [holding('The body access_token is an OAuth2 token for user_id with the gdm.join scope.')],
    [docs('resources/channel#group-dm-add-recipient')],
  ),
  delete_group_dm_user: unknown(
    'Discord documents no requirement for removing a group DM recipient.',
  ),

  // ------------------------------------------------------------------ threads
  create_thread_from_message: requires(
    [inChannel('CreatePublicThreads')],
    [docs('resources/channel#start-thread-from-message'), FLAGS],
  ),
  create_thread: requires(
    [inChannel()],
    [
      docs('resources/channel#start-thread-without-message'),
      docs('resources/channel#start-thread-in-forum-or-media-channel'),
      ALLOWED_MENTIONS,
      FLAGS,
      SPEC,
    ],
    {
      conditional: [
        when('channel_id is a forum or media channel', inChannel('SendMessages')),
        when('the body attaches files', inChannel('AttachFiles')),
        when('body message includes a poll', inChannel('SendPolls')),
        when(
          'body message mentions @everyone, @here, or a role that is not mentionable, and allowed_mentions permits it',
          inChannel('MentionEveryone'),
        ),
        when(
          'channel_id is a text or announcement channel and body type is PRIVATE_THREAD or omitted',
          inChannel('CreatePrivateThreads'),
        ),
        when(
          'channel_id is a text or announcement channel and body type is PUBLIC_THREAD or ANNOUNCEMENT_THREAD',
          inChannel('CreatePublicThreads'),
        ),
      ],
      note: 'The docs omit poll from the first message, but the spec accepts it.',
    },
  ),
  join_thread: requires([inChannel()], [docs('resources/channel#join-thread')], {
    note: 'The thread must not be archived.',
  }),
  leave_thread: requires([inChannel()], [docs('resources/channel#leave-thread')], {
    note: 'The thread must not be archived.',
  }),
  add_thread_member: requires(
    [inChannel('SendMessagesInThreads')],
    [docs('resources/channel#add-thread-member')],
    { note: 'The thread must not be archived.' },
  ),
  delete_thread_member: requires(
    [
      inChannel('ManageThreads'),
      holding('channel_id is a private thread the caller created.', inChannel()),
    ],
    [docs('resources/channel#remove-thread-member')],
    { note: 'The thread must not be archived.' },
  ),
  get_thread_member: requires([inChannel()], [docs('resources/channel#get-thread-member')]),
  list_thread_members: requires([inChannel()], [docs('resources/channel#list-thread-members')], {
    note: 'Requires the GUILD_MEMBERS privileged intent.',
  }),
  list_public_archived_threads: requires(
    [inChannel('ReadMessageHistory')],
    [docs('resources/channel#list-public-archived-threads')],
  ),
  list_private_archived_threads: requires(
    [inChannel('ReadMessageHistory', 'ManageThreads')],
    [docs('resources/channel#list-private-archived-threads')],
  ),
  list_my_private_archived_threads: requires(
    [inChannel('ReadMessageHistory')],
    [docs('resources/channel#list-joined-private-archived-threads')],
  ),
  thread_search: unknown('Discord documents no requirement for searching threads.'),
  get_active_guild_threads: requires(
    [inGuild()],
    [docs('resources/guild#list-active-guild-threads')],
    { note: 'Spans channels: results reflect what the caller can see in each.' },
  ),

  // ------------------------------------------------------------------ messages
  list_messages: requires(
    [inChannel('ReadMessageHistory')],
    [docs('resources/message#get-channel-messages')],
    {
      conditional: [VOICE_CHANNEL],
      note: 'Without ReadMessageHistory Discord returns an empty list instead of rejecting.',
    },
  ),
  get_message: requires(
    [inChannel('ReadMessageHistory')],
    [docs('resources/message#get-channel-message')],
    { conditional: [VOICE_CHANNEL] },
  ),
  guild_search: requires(
    [inGuild('ReadMessageHistory')],
    [docs('resources/message#search-guild-messages')],
    {
      note: 'Requires the MESSAGE_CONTENT privileged intent. Spans channels: results reflect what the caller can see in each.',
    },
  ),
  create_message: requires([inChannel()], [docs('resources/message#create-message'), FLAGS], {
    conditional: [
      NOT_THREAD_SEND,
      THREAD_SEND,
      when('the body sets tts to true', inChannel('SendTTSMessages')),
      when('the body replies to a message (message_reference)', inChannel('ReadMessageHistory')),
      when('the body attaches files', inChannel('AttachFiles')),
      when('the body includes a poll', inChannel('SendPolls')),
      when('sticker_ids include stickers from another guild', inChannel('UseExternalStickers')),
      when(
        'the content mentions @everyone, @here, or a role that is not mentionable, and allowed_mentions permits it',
        inChannel('MentionEveryone'),
      ),
    ],
  }),
  crosspost_message: requires(
    [
      holding(MESSAGE_AUTHOR, inChannel('SendMessages')),
      inChannel('SendMessages', 'ManageMessages'),
    ],
    [docs('resources/message#crosspost-message')],
  ),
  update_message: requires(
    [
      holding(MESSAGE_AUTHOR, inChannel()),
      holding('The request changes only flags.', inChannel('ManageMessages')),
    ],
    [docs('resources/message#edit-message'), ALLOWED_MENTIONS, FLAGS],
    {
      conditional: [
        when('the body attaches files', inChannel('AttachFiles')),
        when(
          'the new content or components mention @everyone, @here, or a role that is not mentionable, and allowed_mentions permits it',
          inChannel('MentionEveryone'),
        ),
      ],
      note: 'Without allowed_mentions, Discord parses the edited content with default allowances.',
    },
  ),
  delete_message: requires(
    [holding(MESSAGE_AUTHOR, inChannel()), inChannel('ManageMessages')],
    [docs('resources/message#delete-message')],
  ),
  bulk_delete_messages: requires(
    [inChannel('ManageMessages')],
    [docs('resources/message#bulk-delete-messages')],
  ),
  add_my_message_reaction: requires(
    [inChannel('ReadMessageHistory')],
    [docs('resources/message#create-reaction'), FLAGS],
    {
      conditional: [
        when('nobody has reacted with this emoji yet', inChannel('AddReactions')),
        when('emoji_name is a custom emoji from another guild', inChannel('UseExternalEmojis')),
      ],
    },
  ),
  delete_my_message_reaction: requires(
    [inChannel()],
    [docs('resources/message#delete-own-reaction')],
  ),
  delete_user_message_reaction: requires(
    [inChannel('ManageMessages')],
    [docs('resources/message#delete-user-reaction')],
  ),
  list_message_reactions_by_emoji: requires(
    [inChannel()],
    [docs('resources/message#get-reactions')],
  ),
  delete_all_message_reactions: requires(
    [inChannel('ManageMessages')],
    [docs('resources/message#delete-all-reactions')],
  ),
  delete_all_message_reactions_by_emoji: requires(
    [inChannel('ManageMessages')],
    [docs('resources/message#delete-all-reactions-for-emoji')],
  ),
  list_pins: requires(
    [inChannel('ReadMessageHistory')],
    [docs('resources/message#get-channel-pins')],
    { note: 'Without ReadMessageHistory Discord returns no pins instead of rejecting.' },
  ),
  create_pin: requires([inChannel('PinMessages')], [docs('resources/message#pin-message')]),
  delete_pin: requires([inChannel('PinMessages')], [docs('resources/message#unpin-message')]),
  deprecated_list_pins: requires(
    [inChannel('ReadMessageHistory')],
    [
      docs('resources/message#get-pinned-messages-deprecated'),
      docs('resources/message#get-channel-pins'),
    ],
  ),
  deprecated_create_pin: requires(
    [inChannel('PinMessages')],
    [docs('resources/message#pin-message-deprecated'), docs('resources/message#pin-message')],
  ),
  deprecated_delete_pin: requires(
    [inChannel('PinMessages')],
    [docs('resources/message#unpin-message-deprecated'), docs('resources/message#unpin-message')],
  ),
  get_answer_voters: requires([inChannel()], [docs('resources/poll#get-answer-voters')]),
  poll_expire: requires(
    [holding('The caller authored the poll.', inChannel())],
    [docs('resources/poll#end-poll')],
  ),

  // ------------------------------------------------------------------ guild
  get_guild: requires([inGuild()], [docs('resources/guild#get-guild')]),
  get_guild_preview: requires(
    [inGuild(), holding('The guild is discoverable.')],
    [docs('resources/guild#get-guild-preview')],
  ),
  update_guild: requires([inGuild('ManageGuild')], [docs('resources/guild#modify-guild')], {
    conditional: [when('the body adds or removes the COMMUNITY feature', inGuild('Administrator'))],
  }),
  list_guild_channels: requires([inGuild()], [docs('resources/guild#get-guild-channels')], {
    note: 'Until 2026-11-16 Discord also returns channels the caller cannot view.',
  }),
  create_guild_channel: requires(
    [inGuild('ManageChannels')],
    [docs('resources/guild#create-guild-channel')],
    {
      conditional: [
        when('body permission_overwrites allow or deny ManageRoles', inGuild('Administrator')),
      ],
      hierarchy: [{ rule: 'held-permissions-only', target: 'body permission_overwrites' }],
    },
  ),
  bulk_update_guild_channels: requires(
    [inGuild('ManageChannels')],
    [docs('resources/guild#modify-guild-channel-positions')],
    {
      conditional: [
        when(
          'an entry changes parent_id',
          inChannelAt('each moved channel and its destination category', 'ManageChannels'),
        ),
        when('an entry sets lock_permissions', inGuild('ManageRoles')),
      ],
      note: "Position-only entries also accept ManageChannels on the channel's current parent category.",
    },
  ),
  list_guild_voice_regions: requires(
    [inGuild()],
    [docs('resources/guild#get-guild-voice-regions')],
  ),
  list_guild_invites: requires(
    [inGuild('ManageGuild'), inGuild('ViewAuditLog')],
    [docs('resources/guild#get-guild-invites')],
    { note: 'Invite metadata is included only with ManageGuild.' },
  ),
  list_guild_integrations: requires(
    [inGuild('ManageGuild')],
    [docs('resources/guild#get-guild-integrations')],
  ),
  delete_guild_integration: requires(
    [inGuild('ManageGuild')],
    [docs('resources/guild#delete-guild-integration')],
  ),
  get_guild_widget_settings: requires(
    [inGuild('ManageGuild')],
    [docs('resources/guild#get-guild-widget-settings')],
  ),
  update_guild_widget_settings: requires(
    [inGuild('ManageGuild')],
    [docs('resources/guild#modify-guild-widget')],
  ),
  get_guild_widget: none(
    'Public when the guild has its widget enabled.',
    docs('resources/guild#get-guild-widget'),
  ),
  get_guild_widget_png: none(
    'Requires no permissions or authentication.',
    docs('resources/guild#get-guild-widget-image'),
  ),
  get_guild_vanity_url: requires(
    [inGuild('ManageGuild')],
    [docs('resources/guild#get-guild-vanity-url')],
  ),
  get_guild_welcome_screen: requires(
    [inGuild('ManageGuild'), holding('The welcome screen is enabled.', inGuild())],
    [docs('resources/guild#get-guild-welcome-screen')],
  ),
  update_guild_welcome_screen: requires(
    [inGuild('ManageGuild')],
    [docs('resources/guild#modify-guild-welcome-screen')],
  ),
  get_guilds_onboarding: requires([inGuild()], [docs('resources/guild#get-guild-onboarding')]),
  put_guilds_onboarding: requires(
    [inGuild('ManageGuild', 'ManageRoles')],
    [docs('resources/guild#modify-guild-onboarding')],
  ),
  update_guild_incident_actions: requires(
    [inGuild('ManageGuild')],
    [docs('resources/guild#modify-guild-incident-actions')],
  ),
  get_guild_new_member_welcome: unknown('Discord documents no requirement for this route.'),
  get_guild_join_requests: unknown('Discord documents no requirement for listing join requests.'),
  action_guild_join_request: unknown(
    'Discord documents no requirement for approving or rejecting join requests.',
  ),
  preview_prune_guild: requires(
    [inGuild('ManageGuild', 'KickMembers')],
    [docs('resources/guild#get-guild-prune-count')],
    {
      conditional: [
        when('the guild has the PRUNE_REQUIRES_ADMIN feature', inGuild('Administrator')),
      ],
    },
  ),
  prune_guild: requires(
    [inGuild('ManageGuild', 'KickMembers')],
    [docs('resources/guild#begin-guild-prune')],
    {
      conditional: [
        when('the guild has the PRUNE_REQUIRES_ADMIN feature', inGuild('Administrator')),
      ],
    },
  ),

  // ------------------------------------------------------------------ members & bans
  get_guild_member: requires([inGuild()], [docs('resources/guild#get-guild-member')]),
  list_guild_members: requires([inGuild()], [docs('resources/guild#list-guild-members')], {
    note: 'Requires the GUILD_MEMBERS privileged intent.',
  }),
  search_guild_members: requires([inGuild()], [docs('resources/guild#search-guild-members')]),
  add_guild_member: requires(
    [
      holding(
        "The body access_token is the user's OAuth2 token with guilds.join, issued to the caller's application.",
        inGuild('CreateInstantInvite'),
      ),
    ],
    [docs('resources/guild#add-guild-member')],
    {
      conditional: [
        when('the body sets nick', inGuild('ManageNicknames')),
        when('the body sets roles', inGuild('ManageRoles')),
        when('the body sets mute', inGuild('MuteMembers')),
        when('the body sets deaf', inGuild('DeafenMembers')),
      ],
      hierarchy: [{ rule: 'role-below', target: 'body roles' }],
    },
  ),
  update_guild_member: requires(
    [inGuild()],
    [docs('resources/guild#modify-guild-member'), HIERARCHY],
    {
      conditional: [
        when('the body sets nick', inGuild('ManageNicknames')),
        when('the body sets roles', inGuild('ManageRoles')),
        when('the body sets mute', inGuild('MuteMembers')),
        when('the body sets deaf', inGuild('DeafenMembers')),
        when(
          'the body sets channel_id to a channel',
          inChannelAt('body channel_id', 'Connect', 'MoveMembers'),
        ),
        when(
          'the body sets channel_id to null',
          inChannelAt("the target member's current voice channel", 'MoveMembers'),
        ),
        when('the body sets communication_disabled_until', inGuild('ModerateMembers')),
        when(
          'the body sets flags',
          inGuild('ManageGuild'),
          inGuild('ManageRoles'),
          inGuild('ModerateMembers', 'KickMembers', 'BanMembers'),
        ),
      ],
      hierarchy: [
        {
          rule: 'member-below',
          target: 'user_id, when setting nick or communication_disabled_until',
        },
        { rule: 'role-below', target: 'each role added to or removed from body roles' },
      ],
      note: 'A timeout is rejected for targets with Administrator.',
    },
  ),
  update_my_guild_member: requires([inGuild()], [docs('resources/guild#modify-current-member')], {
    conditional: [when('the body sets nick', inGuild('ChangeNickname'))],
  }),
  get_my_guild_member: none(
    "Returns the caller's own membership. Needs a Bearer token with guilds.members.read.",
    docs('resources/user#get-current-user-guild-member'),
  ),
  add_guild_member_role: requires(
    [inGuild('ManageRoles')],
    [docs('resources/guild#add-guild-member-role'), HIERARCHY],
    { hierarchy: [{ rule: 'role-below', target: 'role_id' }] },
  ),
  delete_guild_member_role: requires(
    [inGuild('ManageRoles')],
    [docs('resources/guild#remove-guild-member-role'), HIERARCHY],
    { hierarchy: [{ rule: 'role-below', target: 'role_id' }] },
  ),
  delete_guild_member: requires(
    [inGuild('KickMembers')],
    [docs('resources/guild#remove-guild-member'), HIERARCHY],
    { hierarchy: [TARGET_MEMBER] },
  ),
  list_guild_bans: requires(
    [inGuild('BanMembers'), inGuild('ViewAuditLog')],
    [docs('resources/guild#get-guild-bans')],
  ),
  get_guild_ban: requires(
    [inGuild('BanMembers'), inGuild('ViewAuditLog')],
    [docs('resources/guild#get-guild-ban')],
  ),
  ban_user_from_guild: requires(
    [inGuild('BanMembers')],
    [docs('resources/guild#create-guild-ban'), HIERARCHY],
    { hierarchy: [{ rule: 'member-below', target: 'user_id, when the user is a member' }] },
  ),
  unban_user_from_guild: requires(
    [inGuild('BanMembers')],
    [docs('resources/guild#remove-guild-ban')],
  ),
  bulk_ban_users_from_guild: requires(
    [inGuild('BanMembers', 'ManageGuild')],
    [docs('resources/guild#bulk-guild-ban'), HIERARCHY],
    {
      hierarchy: [{ rule: 'member-below', target: 'each body user_ids entry that is a member' }],
      note: 'Users Discord refuses to ban are reported in failed_users.',
    },
  ),

  // ------------------------------------------------------------------ roles
  list_guild_roles: requires([inGuild()], [docs('resources/guild#get-guild-roles')]),
  get_guild_role: requires([inGuild()], [docs('resources/guild#get-guild-role')]),
  guild_role_member_counts: requires(
    [inGuild()],
    [docs('resources/guild#get-guild-role-member-counts')],
  ),
  create_guild_role: requires(
    [inGuild('ManageRoles')],
    [docs('resources/guild#create-guild-role'), HIERARCHY],
    { hierarchy: [{ rule: 'held-permissions-only', target: 'body permissions' }] },
  ),
  bulk_update_guild_roles: requires(
    [inGuild('ManageRoles')],
    [docs('resources/guild#modify-guild-role-positions'), HIERARCHY],
    {
      hierarchy: [
        { rule: 'role-below', target: 'each role in the body, at its old and new position' },
      ],
    },
  ),
  update_guild_role: requires(
    [inGuild('ManageRoles')],
    [docs('resources/guild#modify-guild-role'), HIERARCHY],
    {
      hierarchy: [
        { rule: 'role-below', target: 'role_id' },
        { rule: 'held-permissions-only', target: 'body permissions' },
      ],
    },
  ),
  delete_guild_role: requires(
    [inGuild('ManageRoles')],
    [docs('resources/guild#delete-guild-role'), HIERARCHY],
    { hierarchy: [{ rule: 'role-below', target: 'role_id' }] },
  ),

  // ------------------------------------------------------------------ expressions
  list_guild_emojis: expressionRead('resources/emoji#list-guild-emojis', 'user fields are'),
  get_guild_emoji: expressionRead('resources/emoji#get-guild-emoji', 'The user field is'),
  create_guild_emoji: requires(
    [inGuild('CreateGuildExpressions')],
    [docs('resources/emoji#create-guild-emoji')],
  ),
  update_guild_emoji: expression('resources/emoji#modify-guild-emoji', 'emoji'),
  delete_guild_emoji: expression('resources/emoji#delete-guild-emoji', 'emoji'),
  list_guild_stickers: expressionRead('resources/sticker#list-guild-stickers', 'user fields are'),
  get_guild_sticker: expressionRead('resources/sticker#get-guild-sticker', 'The user field is'),
  create_guild_sticker: requires(
    [inGuild('CreateGuildExpressions')],
    [docs('resources/sticker#create-guild-sticker')],
  ),
  update_guild_sticker: expression('resources/sticker#modify-guild-sticker', 'sticker'),
  delete_guild_sticker: expression('resources/sticker#delete-guild-sticker', 'sticker'),
  get_sticker: none('Any sticker by ID.', docs('resources/sticker#get-sticker')),
  list_sticker_packs: none(
    'Discord-provided sticker packs.',
    docs('resources/sticker#list-sticker-packs'),
  ),
  get_sticker_pack: none(
    'A Discord-provided sticker pack.',
    docs('resources/sticker#get-sticker-pack'),
  ),
  list_guild_soundboard_sounds: expressionRead(
    'resources/soundboard#list-guild-soundboard-sounds',
    'user fields are',
  ),
  get_guild_soundboard_sound: expressionRead(
    'resources/soundboard#get-guild-soundboard-sound',
    'The user field is',
  ),
  create_guild_soundboard_sound: requires(
    [inGuild('CreateGuildExpressions')],
    [docs('resources/soundboard#create-guild-soundboard-sound')],
  ),
  update_guild_soundboard_sound: expression(
    'resources/soundboard#modify-guild-soundboard-sound',
    'sound',
  ),
  delete_guild_soundboard_sound: expression(
    'resources/soundboard#delete-guild-soundboard-sound',
    'sound',
  ),
  get_soundboard_default_sounds: none(
    'Discord-provided sounds.',
    docs('resources/soundboard#list-default-soundboard-sounds'),
  ),
  send_soundboard_sound: requires(
    [inChannel('Speak', 'UseSoundboard')],
    [docs('resources/soundboard#send-soundboard-sound')],
    {
      conditional: [when('the sound belongs to another guild', inChannel('UseExternalSounds'))],
      note: 'The caller must be connected to the voice channel without being deafened, muted, or suppressed.',
    },
  ),

  // ------------------------------------------------------------------ scheduled events
  list_guild_scheduled_events: requires(
    [inGuild()],
    [docs('resources/guild-scheduled-event#list-scheduled-events-for-guild'), EVENTS],
  ),
  get_guild_scheduled_event: eventRead('resources/guild-scheduled-event#get-guild-scheduled-event'),
  list_guild_scheduled_event_users: eventRead(
    'resources/guild-scheduled-event#get-guild-scheduled-event-users',
  ),
  create_guild_scheduled_event: requires(
    [inGuild()],
    [docs('resources/guild-scheduled-event#create-guild-scheduled-event'), EVENTS],
    {
      conditional: [
        when('body entity_type is EXTERNAL', inGuild('CreateEvents')),
        when(
          'body entity_type is STAGE_INSTANCE',
          inChannelAt(
            'body channel_id',
            'CreateEvents',
            'ManageChannels',
            'MuteMembers',
            'MoveMembers',
          ),
        ),
        when(
          'body entity_type is VOICE',
          inChannelAt('body channel_id', 'CreateEvents', 'Connect'),
        ),
      ],
    },
  ),
  update_guild_scheduled_event: eventChange(
    'resources/guild-scheduled-event#modify-guild-scheduled-event',
  ),
  delete_guild_scheduled_event: eventChange(
    'resources/guild-scheduled-event#delete-guild-scheduled-event',
  ),
  count_guild_scheduled_event_users: unknown('Discord documents no requirement for this route.'),
  list_guild_scheduled_event_exception_users: unknown(
    'Discord documents no requirement for this route.',
  ),
  create_guild_scheduled_event_exception: unknown(
    'Discord documents no requirement for recurring-event exceptions.',
  ),
  update_guild_scheduled_event_exception: unknown(
    'Discord documents no requirement for recurring-event exceptions.',
  ),
  delete_guild_scheduled_event_exception: unknown(
    'Discord documents no requirement for recurring-event exceptions.',
  ),

  // ------------------------------------------------------------------ stage & voice
  create_stage_instance: requires(
    [inChannelAt('body channel_id', 'ManageChannels', 'MuteMembers', 'MoveMembers')],
    [docs('resources/stage-instance#create-stage-instance'), STAGE_MODERATOR],
    {
      conditional: [
        when(
          'body send_start_notification is true',
          inChannelAt('body channel_id', 'MentionEveryone'),
        ),
      ],
    },
  ),
  get_stage_instance: requires(
    [inChannel()],
    [docs('resources/stage-instance#get-stage-instance')],
  ),
  update_stage_instance: requires(
    [inChannel('ManageChannels', 'MuteMembers', 'MoveMembers')],
    [docs('resources/stage-instance#modify-stage-instance'), STAGE_MODERATOR],
  ),
  delete_stage_instance: requires(
    [inChannel('ManageChannels', 'MuteMembers', 'MoveMembers')],
    [docs('resources/stage-instance#delete-stage-instance'), STAGE_MODERATOR],
  ),
  list_voice_regions: none(
    'Discord-wide voice regions.',
    docs('resources/voice#list-voice-regions'),
  ),
  get_self_voice_state: requires(
    [inGuild()],
    [docs('resources/voice#get-current-user-voice-state')],
  ),
  get_voice_state: requires([inGuild()], [docs('resources/voice#get-user-voice-state')], {
    conditional: [
      when(
        'the target user is connected to a voice channel',
        inChannelAt('the voice channel the target user is connected to', 'Connect'),
      ),
    ],
  }),
  update_self_voice_state: requires(
    [inGuild()],
    [docs('resources/voice#modify-current-user-voice-state')],
    {
      conditional: [
        when('the body sets suppress to false', inChannelAt('body channel_id', 'MuteMembers')),
        when(
          'the body sets request_to_speak_timestamp',
          inChannelAt('body channel_id', 'RequestToSpeak'),
        ),
      ],
      note: 'channel_id must be a stage channel the caller has already joined.',
    },
  ),
  update_voice_state: requires(
    [inChannelAt('body channel_id (a stage channel)', 'MuteMembers')],
    [docs('resources/voice#modify-user-voice-state')],
    { note: 'The target user must already have joined the stage channel.' },
  ),

  // ------------------------------------------------------------------ invites & templates
  invite_resolve: none('Any invite by code.', docs('resources/invite#get-invite')),
  invite_revoke: requires(
    [inChannelAt(INVITE_CHANNEL, 'ManageChannels'), inGuildAt(INVITE_GUILD, 'ManageGuild')],
    [docs('resources/invite#delete-invite')],
  ),
  get_invite_target_users: requires(
    [
      holding('The caller created the invite.'),
      inGuildAt(INVITE_GUILD, 'ManageGuild'),
      inGuildAt(INVITE_GUILD, 'ViewAuditLog'),
    ],
    [docs('resources/invite#get-target-users')],
  ),
  get_invite_target_users_job_status: requires(
    [
      holding('The caller created the invite.'),
      inGuildAt(INVITE_GUILD, 'ManageGuild'),
      inGuildAt(INVITE_GUILD, 'ViewAuditLog'),
    ],
    [docs('resources/invite#get-target-users-job-status')],
  ),
  update_invite_target_users: requires(
    [holding('The caller created the invite.'), inGuildAt(INVITE_GUILD, 'ManageGuild')],
    [docs('resources/invite#update-target-users')],
  ),
  get_guild_template: none(
    'Any template by code.',
    docs('resources/guild-template#get-guild-template'),
  ),
  list_guild_templates: requires(
    [inGuild('ManageGuild')],
    [docs('resources/guild-template#get-guild-templates')],
  ),
  create_guild_template: requires(
    [inGuild('ManageGuild')],
    [docs('resources/guild-template#create-guild-template')],
  ),
  sync_guild_template: requires(
    [inGuild('ManageGuild')],
    [docs('resources/guild-template#sync-guild-template')],
  ),
  update_guild_template: requires(
    [inGuild('ManageGuild')],
    [docs('resources/guild-template#modify-guild-template')],
  ),
  delete_guild_template: requires(
    [inGuild('ManageGuild')],
    [docs('resources/guild-template#delete-guild-template')],
  ),

  // ------------------------------------------------------------------ webhooks & interactions
  create_webhook: requires(
    [inChannel('ManageWebhooks')],
    [docs('resources/webhook#create-webhook')],
  ),
  list_channel_webhooks: requires(
    [inChannel('ManageWebhooks')],
    [docs('resources/webhook#get-channel-webhooks')],
  ),
  get_guild_webhooks: requires(
    [inGuild('ManageWebhooks')],
    [docs('resources/webhook#get-guild-webhooks')],
  ),
  get_webhook: requires(
    [
      inChannelAt(WEBHOOK_CHANNEL, 'ManageWebhooks'),
      holding("The webhook belongs to the caller's application (webhook.application_id)."),
    ],
    [docs('resources/webhook#get-webhook')],
  ),
  update_webhook: requires(
    [inChannelAt(WEBHOOK_CHANNEL, 'ManageWebhooks')],
    [docs('resources/webhook#modify-webhook')],
    {
      conditional: [
        when('the body sets channel_id', inChannelAt('body channel_id', 'ManageWebhooks')),
      ],
    },
  ),
  delete_webhook: requires(
    [inChannelAt(WEBHOOK_CHANNEL, 'ManageWebhooks')],
    [docs('resources/webhook#delete-webhook')],
  ),
  get_webhook_by_token: webhookToken('resources/webhook#get-webhook-with-token'),
  update_webhook_by_token: webhookToken('resources/webhook#modify-webhook-with-token'),
  delete_webhook_by_token: webhookToken('resources/webhook#delete-webhook-with-token'),
  execute_webhook: webhookToken('resources/webhook#execute-webhook'),
  execute_slack_compatible_webhook: webhookToken(
    'resources/webhook#execute-slack-compatible-webhook',
  ),
  execute_github_compatible_webhook: webhookToken(
    'resources/webhook#execute-github-compatible-webhook',
  ),
  get_webhook_message: webhookToken('resources/webhook#get-webhook-message'),
  update_webhook_message: webhookToken('resources/webhook#edit-webhook-message'),
  delete_webhook_message: webhookToken('resources/webhook#delete-webhook-message'),
  get_original_webhook_message: webhookToken(
    'interactions/receiving-and-responding#get-original-interaction-response',
  ),
  update_original_webhook_message: webhookToken(
    'interactions/receiving-and-responding#edit-original-interaction-response',
  ),
  delete_original_webhook_message: webhookToken(
    'interactions/receiving-and-responding#delete-original-interaction-response',
  ),
  create_interaction_response: requires(
    [holding("The path's interaction_token is the interaction's token.")],
    [docs('interactions/receiving-and-responding#create-interaction-response')],
  ),

  // ------------------------------------------------------------------ users & OAuth
  get_my_user: none("Returns the caller's own user.", docs('resources/user#get-current-user')),
  update_my_user: none("Edits the caller's own user.", docs('resources/user#modify-current-user')),
  get_user: none('Any user by ID.', docs('resources/user#get-user')),
  list_my_guilds: none(
    'Lists guilds the caller belongs to.',
    docs('resources/user#get-current-user-guilds'),
  ),
  leave_guild: none('Removes the caller from a guild.', docs('resources/user#leave-guild')),
  create_dm: none('Opens a DM with the body recipient_id.', docs('resources/user#create-dm')),
  list_my_connections: none(
    "Lists the caller's own connections. Needs a Bearer token with connections.",
    docs('resources/user#get-current-user-connections'),
  ),
  get_application_user_role_connection: requires(
    [holding('A Bearer token with role_connections.write, issued to application_id.')],
    [docs('resources/user#get-current-user-application-role-connection')],
  ),
  update_application_user_role_connection: requires(
    [holding('A Bearer token with role_connections.write, issued to application_id.')],
    [docs('resources/user#update-current-user-application-role-connection')],
  ),
  delete_application_user_role_connection: requires(
    [holding('A Bearer token with role_connections.write, issued to application_id.')],
    [docs('resources/user#delete-current-user-application-role-connection')],
  ),
  get_my_oauth2_authorization: none(
    'Describes the caller’s own authorization.',
    docs('topics/oauth2#get-current-authorization-information'),
  ),
  get_my_oauth2_application: none(
    "Returns the caller's own application.",
    docs('topics/oauth2#get-current-bot-application-information'),
  ),
  get_openid_connect_userinfo: none(
    "Returns the caller's own OpenID Connect claims. Undocumented route.",
    SPEC,
  ),
  get_public_keys: none('Publishes Discord’s OAuth2 signing keys. Undocumented route.', SPEC),
  get_gateway: none('Requires no authentication.', docs('events/gateway#get-gateway')),
  get_bot_gateway: none('Any valid bot token.', docs('events/gateway#get-gateway-bot')),

  // ------------------------------------------------------------------ lobbies & Social SDK
  create_lobby: none(
    "Creates a lobby owned by the caller's application.",
    docs('resources/lobby#create-lobby'),
  ),
  create_or_join_lobby: requires(
    [holding('A Bearer token with sdk.social_layer.')],
    [docs('resources/lobby#create-or-join-lobby')],
  ),
  get_lobby: ownLobby('resources/lobby#get-lobby'),
  edit_lobby: ownLobby('resources/lobby#modify-lobby'),
  delete_lobby: ownLobby('resources/lobby#delete-lobby'),
  add_lobby_member: ownLobby('resources/lobby#add-a-member-to-a-lobby'),
  bulk_update_lobby_members: ownLobby('resources/lobby#bulk-update-lobby-members'),
  delete_lobby_member: ownLobby('resources/lobby#remove-a-member-from-a-lobby'),
  leave_lobby: ownLobby('resources/lobby#leave-lobby'),
  create_lobby_message: ownLobby('resources/lobby#send-lobby-message'),
  get_lobby_messages: ownLobby('resources/lobby#get-lobby-messages'),
  update_lobby_message_external_moderation_metadata: ownLobby(
    'resources/lobby#update-lobby-message-moderation-metadata',
  ),
  create_linked_lobby_guild_invite_for_self: ownLobby(
    'resources/lobby#create-lobby-channel-invite-for-self',
  ),
  create_linked_lobby_guild_invite_for_user: ownLobby(
    'resources/lobby#create-lobby-channel-invite-for-user',
  ),
  edit_lobby_channel_link: requires(
    [holding('The caller is a lobby member with the CanLinkLobby flag (Bearer token).')],
    [
      docs('resources/lobby#link-channel-to-lobby'),
      docs('discord-social-sdk/development-guides/linked-channels#required-permissions'),
    ],
    {
      conditional: [
        when(
          'the body links a channel',
          inChannelAt('body channel_id', 'ManageChannels', 'SendMessages'),
        ),
      ],
    },
  ),
  partner_sdk_token: ownApplication(undefined, 'Undocumented credential route.'),
  bot_partner_sdk_token: ownApplication(undefined, 'Undocumented credential route.'),
  partner_sdk_unmerge_provisional_account: ownApplication(
    undefined,
    'Undocumented credential route.',
  ),
  bot_partner_sdk_unmerge_provisional_account: ownApplication(
    undefined,
    'Undocumented credential route.',
  ),
  update_user_message_external_moderation_metadata: ownApplication(
    'discord-social-sdk/how-to/integrate-moderation',
    'Sets app-scoped moderation metadata on a DM message.',
  ),
}

/**
 * The permission requirements for one cataloged operation.
 *
 * `spec:check` guarantees an entry for every operation, so a missing one is a build that skipped
 * the check, not a state to recover from.
 */
export const requiredPermissions = (operationId: string): OperationPermissions => {
  const entry = operationPermissions[operationId]
  if (!Object.hasOwn(operationPermissions, operationId) || entry === undefined) {
    throw new Error(`${operationId} has no permission entry. Run pnpm spec:check.`)
  }
  return entry
}

const grantProblems = (op: OperationEntry, grant: PermissionGrant): ReadonlyArray<string> => {
  const where = op.operationId
  if (grant.scope === undefined) {
    return [
      ...(grant.permissions.length > 0 ? [`${where} has permissions without a scope`] : []),
      ...(grant.only === undefined ? [`${where} has a grant that requires nothing`] : []),
    ]
  }
  const { level, pathParam } = grant.scope
  return [
    ...(pathParam !== undefined && !op.pathParams.includes(pathParam)
      ? [`${where} scope names path parameter ${pathParam}, which ${op.path} lacks`]
      : []),
    ...(level === 'channel' && !grant.permissions.includes('ViewChannel')
      ? [`${where} has a channel grant without ViewChannel`]
      : []),
  ]
}

/**
 * Problems that make the table unfit to authorize anything: missing or stale entries, scopes that
 * name a path parameter the operation lacks, and grants that would hold for free.
 */
export const permissionTableProblems = (
  operations: ReadonlyArray<OperationEntry>,
  table: Readonly<Record<string, OperationPermissions>> = operationPermissions,
): ReadonlyArray<string> => {
  const ids = new Set(operations.map((op) => op.operationId))
  const stale = Object.keys(table)
    .filter((id) => !ids.has(id))
    .map((id) => `${id} has a permission entry but is not in the catalog`)

  return [
    ...stale,
    ...operations.flatMap((op) => {
      const entry = table[op.operationId]
      if (entry === undefined) return [`${op.operationId} has no permission entry`]
      const unsourced = entry.sources.length === 0 ? [`${op.operationId} cites no source`] : []
      if (entry.requires !== 'any-of') return unsourced

      const grants = [...entry.anyOf, ...(entry.conditional ?? []).flatMap((c) => c.anyOf)]
      return [...unsourced, ...grants.flatMap((grant) => grantProblems(op, grant))]
    }),
  ]
}
