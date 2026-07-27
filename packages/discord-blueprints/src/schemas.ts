import { Schema } from 'effect'

const JsonValueSchema: Schema.Codec<unknown, unknown> = Schema.suspend(() =>
  Schema.Union([
    Schema.Null,
    Schema.Boolean,
    Schema.Finite,
    Schema.String,
    Schema.Array(JsonValueSchema),
    Schema.Record(Schema.String, JsonValueSchema),
  ]),
).annotate({ identifier: 'DiscordBlueprintJsonValue' })

const Snowflake = Schema.String.pipe(Schema.check(Schema.isPattern(/^\d{17,21}$/)))
const LogicalKey = Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-z][a-z0-9_-]{0,63}$/)))
const PermissionNames = Schema.Array(Schema.String)

export const RoleBlueprintSchema = Schema.Struct({
  key: LogicalKey,
  name: Schema.String,
  permissions: Schema.optionalKey(PermissionNames),
  color: Schema.optionalKey(Schema.Int),
  hoist: Schema.optionalKey(Schema.Boolean),
  mentionable: Schema.optionalKey(Schema.Boolean),
  order: Schema.optionalKey(Schema.Int),
})
const OverwriteTarget = Schema.Union([
  Schema.Struct({ type: Schema.Literal('everyone') }),
  Schema.Struct({ type: Schema.Literal('role'), roleKey: LogicalKey }),
  Schema.Struct({ type: Schema.Literal('roleId'), roleId: Snowflake }),
  Schema.Struct({ type: Schema.Literal('member'), memberId: Snowflake }),
])
const PermissionOverwrite = Schema.Struct({
  target: OverwriteTarget,
  allow: Schema.optionalKey(PermissionNames),
  deny: Schema.optionalKey(PermissionNames),
})
const ForumTag = Schema.Struct({
  key: LogicalKey,
  name: Schema.String,
  moderated: Schema.optionalKey(Schema.Boolean),
  emojiId: Schema.optionalKey(Snowflake),
  emojiName: Schema.optionalKey(Schema.String),
})
export const ChannelBlueprintSchema = Schema.Struct({
  key: LogicalKey,
  kind: Schema.Literals(['category', 'text', 'voice', 'stage', 'announcement', 'forum', 'media']),
  name: Schema.String,
  parentKey: Schema.optionalKey(LogicalKey),
  topic: Schema.optionalKey(Schema.NullOr(Schema.String)),
  nsfw: Schema.optionalKey(Schema.Boolean),
  bitrate: Schema.optionalKey(Schema.Int),
  userLimit: Schema.optionalKey(Schema.Int),
  rateLimitPerUser: Schema.optionalKey(Schema.Int),
  defaultThreadRateLimitPerUser: Schema.optionalKey(Schema.Int),
  defaultAutoArchiveDuration: Schema.optionalKey(Schema.Literals([60, 1_440, 4_320, 10_080])),
  defaultForumLayout: Schema.optionalKey(Schema.Literals(['notSet', 'list', 'gallery'])),
  defaultSortOrder: Schema.optionalKey(Schema.Literals(['latestActivity', 'creationDate'])),
  defaultReactionEmoji: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        emojiId: Schema.optionalKey(Snowflake),
        emojiName: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
  forumTags: Schema.optionalKey(Schema.Array(ForumTag)),
  order: Schema.optionalKey(Schema.Int),
  overwrites: Schema.optionalKey(Schema.Array(PermissionOverwrite)),
})
const GuildSettings = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  verificationLevel: Schema.optionalKey(
    Schema.Literals(['none', 'low', 'medium', 'high', 'veryHigh']),
  ),
  defaultMessageNotifications: Schema.optionalKey(Schema.Literals(['allMessages', 'onlyMentions'])),
  explicitContentFilter: Schema.optionalKey(
    Schema.Literals(['disabled', 'membersWithoutRoles', 'allMembers']),
  ),
  afkChannelKey: Schema.optionalKey(Schema.NullOr(LogicalKey)),
  afkTimeout: Schema.optionalKey(Schema.Literals([60, 300, 900, 1_800, 3_600])),
  systemChannelKey: Schema.optionalKey(Schema.NullOr(LogicalKey)),
  rulesChannelKey: Schema.optionalKey(Schema.NullOr(LogicalKey)),
  publicUpdatesChannelKey: Schema.optionalKey(Schema.NullOr(LogicalKey)),
  safetyAlertsChannelKey: Schema.optionalKey(Schema.NullOr(LogicalKey)),
  preferredLocale: Schema.optionalKey(Schema.String),
  premiumProgressBarEnabled: Schema.optionalKey(Schema.Boolean),
})
const WelcomeScreen = Schema.Struct({
  enabled: Schema.Boolean,
  description: Schema.optionalKey(Schema.NullOr(Schema.String)),
  channels: Schema.Array(
    Schema.Struct({
      channelKey: LogicalKey,
      description: Schema.String,
      emojiId: Schema.optionalKey(Snowflake),
      emojiName: Schema.optionalKey(Schema.String),
    }),
  ),
})
const Onboarding = Schema.Struct({
  enabled: Schema.Boolean,
  mode: Schema.optionalKey(Schema.Literals(['default', 'advanced'])),
  defaultChannelKeys: Schema.Array(LogicalKey),
  prompts: Schema.Array(
    Schema.Struct({
      key: LogicalKey,
      title: Schema.String,
      type: Schema.Literals(['multipleChoice', 'dropdown']),
      singleSelect: Schema.optionalKey(Schema.Boolean),
      required: Schema.optionalKey(Schema.Boolean),
      inOnboarding: Schema.optionalKey(Schema.Boolean),
      options: Schema.Array(
        Schema.Struct({
          key: LogicalKey,
          title: Schema.String,
          description: Schema.optionalKey(Schema.NullOr(Schema.String)),
          channelKeys: Schema.optionalKey(Schema.Array(LogicalKey)),
          roleKeys: Schema.optionalKey(Schema.Array(LogicalKey)),
          roleIds: Schema.optionalKey(Schema.Array(Snowflake)),
          emojiId: Schema.optionalKey(Snowflake),
          emojiName: Schema.optionalKey(Schema.String),
        }),
      ),
    }),
  ),
})
const AutoModerationTrigger = Schema.Union([
  Schema.Struct({
    type: Schema.Literal('keyword'),
    keywords: Schema.optionalKey(Schema.Array(Schema.String)),
    regexPatterns: Schema.optionalKey(Schema.Array(Schema.String)),
    allowList: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
  Schema.Struct({ type: Schema.Literal('spam') }),
  Schema.Struct({
    type: Schema.Literal('keywordPreset'),
    presets: Schema.Array(Schema.Literals(['profanity', 'sexualContent', 'slurs'])),
    allowList: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
  Schema.Struct({
    type: Schema.Literal('mentionSpam'),
    mentionTotalLimit: Schema.Int,
    mentionRaidProtectionEnabled: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({
    type: Schema.Literal('memberProfile'),
    keywords: Schema.optionalKey(Schema.Array(Schema.String)),
    regexPatterns: Schema.optionalKey(Schema.Array(Schema.String)),
    allowList: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
])
const AutoModerationAction = Schema.Union([
  Schema.Struct({
    type: Schema.Literal('blockMessage'),
    customMessage: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({ type: Schema.Literal('sendAlert'), channelKey: LogicalKey }),
  Schema.Struct({ type: Schema.Literal('timeout'), durationSeconds: Schema.Int }),
])
const AutoModerationRule = Schema.Struct({
  key: LogicalKey,
  name: Schema.String,
  enabled: Schema.optionalKey(Schema.Boolean),
  trigger: AutoModerationTrigger,
  actions: Schema.Array(AutoModerationAction),
  exemptRoleKeys: Schema.optionalKey(Schema.Array(LogicalKey)),
  exemptRoleIds: Schema.optionalKey(Schema.Array(Snowflake)),
  exemptChannelKeys: Schema.optionalKey(Schema.Array(LogicalKey)),
  exemptChannelIds: Schema.optionalKey(Schema.Array(Snowflake)),
})

export const ServerBlueprintDraftSchema = Schema.Struct({
  settings: Schema.optionalKey(GuildSettings),
  roles: Schema.Array(RoleBlueprintSchema),
  channels: Schema.Array(ChannelBlueprintSchema),
  welcomeScreen: Schema.optionalKey(WelcomeScreen),
  onboarding: Schema.optionalKey(Onboarding),
  autoModerationRules: Schema.optionalKey(Schema.Array(AutoModerationRule)),
})
export const ServerBlueprintSchema = Schema.Struct({
  id: Schema.String,
  revision: Schema.Int,
  guildId: Snowflake,
  ...ServerBlueprintDraftSchema.fields,
})

const SnapshotRole = Schema.Struct({
  id: Snowflake,
  name: Schema.String,
  permissions: Schema.String,
  color: Schema.Int,
  hoist: Schema.Boolean,
  mentionable: Schema.Boolean,
  position: Schema.Int,
  managed: Schema.Boolean,
})
const SnapshotOverwrite = Schema.Struct({
  id: Snowflake,
  type: Schema.Literals(['role', 'member']),
  allow: Schema.String,
  deny: Schema.String,
})
const SnapshotChannel = Schema.Struct({
  id: Snowflake,
  kind: ChannelBlueprintSchema.fields.kind,
  name: Schema.String,
  parentId: Schema.optionalKey(Snowflake),
  topic: Schema.optionalKey(Schema.NullOr(Schema.String)),
  nsfw: Schema.optionalKey(Schema.Boolean),
  bitrate: Schema.optionalKey(Schema.Int),
  userLimit: Schema.optionalKey(Schema.Int),
  rateLimitPerUser: Schema.optionalKey(Schema.Int),
  defaultThreadRateLimitPerUser: Schema.optionalKey(Schema.Int),
  defaultAutoArchiveDuration: Schema.optionalKey(Schema.Int),
  defaultForumLayout: Schema.optionalKey(Schema.Int),
  defaultSortOrder: Schema.optionalKey(Schema.NullOr(Schema.Int)),
  defaultReactionEmoji: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        emojiId: Schema.optionalKey(Snowflake),
        emojiName: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
  forumTags: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        id: Schema.optionalKey(Snowflake),
        name: Schema.String,
        moderated: Schema.Boolean,
        emojiId: Schema.optionalKey(Snowflake),
        emojiName: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
  position: Schema.Int,
  overwrites: Schema.Array(SnapshotOverwrite),
})
export const GuildSnapshotSchema = Schema.Struct({
  guildId: Snowflake,
  ownerId: Snowflake,
  botMemberId: Snowflake,
  botRoleIds: Schema.Array(Snowflake),
  settings: Schema.optionalKey(Schema.Record(Schema.String, JsonValueSchema)),
  roles: Schema.Array(SnapshotRole),
  channels: Schema.Array(SnapshotChannel),
  welcomeScreen: Schema.optionalKey(JsonValueSchema),
  onboarding: Schema.optionalKey(JsonValueSchema),
  autoModerationRules: Schema.optionalKey(
    Schema.Array(Schema.Record(Schema.String, JsonValueSchema)),
  ),
})
export const BlueprintBindingsSchema = Schema.Struct({
  roles: Schema.Record(Schema.String, Snowflake),
  channels: Schema.Record(Schema.String, Snowflake),
  autoModerationRules: Schema.optionalKey(Schema.Record(Schema.String, Snowflake)),
})
