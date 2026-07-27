export type PermissionName = string

export interface RoleBlueprint {
  readonly key: string
  readonly name: string
  readonly permissions?: ReadonlyArray<PermissionName>
  readonly color?: number
  readonly hoist?: boolean
  readonly mentionable?: boolean
  readonly order?: number
}

export type OverwriteTarget =
  | { readonly type: 'everyone' }
  | { readonly type: 'role'; readonly roleKey: string }
  | { readonly type: 'roleId'; readonly roleId: string }
  | { readonly type: 'member'; readonly memberId: string }

export interface PermissionOverwriteBlueprint {
  readonly target: OverwriteTarget
  readonly allow?: ReadonlyArray<PermissionName>
  readonly deny?: ReadonlyArray<PermissionName>
}

export interface ForumTagBlueprint {
  readonly key: string
  readonly name: string
  readonly moderated?: boolean
  readonly emojiId?: string
  readonly emojiName?: string
}

export interface ChannelBlueprint {
  readonly key: string
  readonly kind: 'category' | 'text' | 'voice' | 'stage' | 'announcement' | 'forum' | 'media'
  readonly name: string
  readonly parentKey?: string
  readonly topic?: string | null
  readonly nsfw?: boolean
  readonly bitrate?: number
  readonly userLimit?: number
  readonly rateLimitPerUser?: number
  readonly defaultThreadRateLimitPerUser?: number
  readonly defaultAutoArchiveDuration?: 60 | 1440 | 4320 | 10080
  readonly defaultForumLayout?: 'notSet' | 'list' | 'gallery'
  readonly defaultSortOrder?: 'latestActivity' | 'creationDate'
  readonly defaultReactionEmoji?: { readonly emojiId?: string; readonly emojiName?: string } | null
  readonly forumTags?: ReadonlyArray<ForumTagBlueprint>
  readonly order?: number
  readonly overwrites?: ReadonlyArray<PermissionOverwriteBlueprint>
}

export interface GuildSettingsBlueprint {
  readonly name?: string
  readonly verificationLevel?: 'none' | 'low' | 'medium' | 'high' | 'veryHigh'
  readonly defaultMessageNotifications?: 'allMessages' | 'onlyMentions'
  readonly explicitContentFilter?: 'disabled' | 'membersWithoutRoles' | 'allMembers'
  readonly afkChannelKey?: string | null
  readonly afkTimeout?: 60 | 300 | 900 | 1800 | 3600
  readonly systemChannelKey?: string | null
  readonly rulesChannelKey?: string | null
  readonly publicUpdatesChannelKey?: string | null
  readonly safetyAlertsChannelKey?: string | null
  readonly preferredLocale?: string
  readonly premiumProgressBarEnabled?: boolean
}

export interface WelcomeScreenBlueprint {
  readonly enabled: boolean
  readonly description?: string | null
  readonly channels: ReadonlyArray<{
    readonly channelKey: string
    readonly description: string
    readonly emojiId?: string
    readonly emojiName?: string
  }>
}

export interface OnboardingBlueprint {
  readonly enabled: boolean
  readonly mode?: 'default' | 'advanced'
  readonly defaultChannelKeys: ReadonlyArray<string>
  readonly prompts: ReadonlyArray<{
    readonly key: string
    readonly title: string
    readonly type: 'multipleChoice' | 'dropdown'
    readonly singleSelect?: boolean
    readonly required?: boolean
    readonly inOnboarding?: boolean
    readonly options: ReadonlyArray<{
      readonly key: string
      readonly title: string
      readonly description?: string | null
      readonly channelKeys?: ReadonlyArray<string>
      readonly roleKeys?: ReadonlyArray<string>
      readonly roleIds?: ReadonlyArray<string>
      readonly emojiId?: string
      readonly emojiName?: string
    }>
  }>
}

export type AutoModerationTrigger =
  | {
      readonly type: 'keyword'
      readonly keywords?: ReadonlyArray<string>
      readonly regexPatterns?: ReadonlyArray<string>
      readonly allowList?: ReadonlyArray<string>
    }
  | { readonly type: 'spam' }
  | {
      readonly type: 'keywordPreset'
      readonly presets: ReadonlyArray<'profanity' | 'sexualContent' | 'slurs'>
      readonly allowList?: ReadonlyArray<string>
    }
  | {
      readonly type: 'mentionSpam'
      readonly mentionTotalLimit: number
      readonly mentionRaidProtectionEnabled?: boolean
    }
  | {
      readonly type: 'memberProfile'
      readonly keywords?: ReadonlyArray<string>
      readonly regexPatterns?: ReadonlyArray<string>
      readonly allowList?: ReadonlyArray<string>
    }

export type AutoModerationAction =
  | { readonly type: 'blockMessage'; readonly customMessage?: string }
  | { readonly type: 'sendAlert'; readonly channelKey: string }
  | { readonly type: 'timeout'; readonly durationSeconds: number }

export interface AutoModerationRuleBlueprint {
  readonly key: string
  readonly name: string
  readonly enabled?: boolean
  readonly trigger: AutoModerationTrigger
  readonly actions: ReadonlyArray<AutoModerationAction>
  readonly exemptRoleKeys?: ReadonlyArray<string>
  readonly exemptRoleIds?: ReadonlyArray<string>
  readonly exemptChannelKeys?: ReadonlyArray<string>
  readonly exemptChannelIds?: ReadonlyArray<string>
}

export interface ServerBlueprint {
  readonly id: string
  readonly revision: number
  readonly guildId: string
  readonly settings?: GuildSettingsBlueprint
  readonly roles: ReadonlyArray<RoleBlueprint>
  readonly channels: ReadonlyArray<ChannelBlueprint>
  readonly welcomeScreen?: WelcomeScreenBlueprint
  readonly onboarding?: OnboardingBlueprint
  readonly autoModerationRules?: ReadonlyArray<AutoModerationRuleBlueprint>
}

export interface GuildRoleSnapshot {
  readonly id: string
  readonly name: string
  readonly permissions: string
  readonly color: number
  readonly hoist: boolean
  readonly mentionable: boolean
  readonly position: number
  readonly managed: boolean
}

export interface GuildChannelSnapshot {
  readonly id: string
  readonly kind: ChannelBlueprint['kind']
  readonly name: string
  readonly parentId?: string
  readonly topic?: string | null
  readonly nsfw?: boolean
  readonly bitrate?: number
  readonly userLimit?: number
  readonly rateLimitPerUser?: number
  readonly defaultThreadRateLimitPerUser?: number
  readonly defaultAutoArchiveDuration?: number
  readonly defaultForumLayout?: number
  readonly defaultSortOrder?: number | null
  readonly defaultReactionEmoji?: { readonly emojiId?: string; readonly emojiName?: string } | null
  readonly forumTags?: ReadonlyArray<{
    readonly id?: string
    readonly name: string
    readonly moderated: boolean
    readonly emojiId?: string
    readonly emojiName?: string
  }>
  readonly position: number
  readonly overwrites: ReadonlyArray<{
    readonly id: string
    readonly type: 'role' | 'member'
    readonly allow: string
    readonly deny: string
  }>
}

export interface GuildSnapshot {
  readonly guildId: string
  readonly ownerId: string
  readonly botMemberId: string
  readonly botRoleIds: ReadonlyArray<string>
  readonly settings?: Readonly<Record<string, unknown>>
  readonly roles: ReadonlyArray<GuildRoleSnapshot>
  readonly channels: ReadonlyArray<GuildChannelSnapshot>
  readonly welcomeScreen?: unknown
  readonly onboarding?: unknown
  readonly autoModerationRules?: ReadonlyArray<Readonly<Record<string, unknown>>>
}

export interface BlueprintBindings {
  readonly roles: Readonly<Record<string, string>>
  readonly channels: Readonly<Record<string, string>>
  readonly autoModerationRules?: Readonly<Record<string, string>>
}

export type BlueprintAction =
  | { readonly type: 'guild.update'; readonly desired: GuildSettingsBlueprint }
  | { readonly type: 'role.create'; readonly key: string; readonly desired: RoleBlueprint }
  | {
      readonly type: 'role.update'
      readonly key: string
      readonly roleId: string
      readonly desired: RoleBlueprint
    }
  | {
      readonly type: 'role.reorder'
      readonly orderedKeys: ReadonlyArray<string>
    }
  | { readonly type: 'role.delete'; readonly key: string; readonly roleId: string }
  | { readonly type: 'channel.create'; readonly key: string; readonly desired: ChannelBlueprint }
  | {
      readonly type: 'channel.update'
      readonly key: string
      readonly channelId: string
      readonly desired: ChannelBlueprint
    }
  | {
      readonly type: 'channel.overwrites'
      readonly key: string
      readonly channelId?: string
      readonly overwrites: ReadonlyArray<PermissionOverwriteBlueprint>
      readonly deleteOverwriteIds: ReadonlyArray<string>
    }
  | {
      readonly type: 'channel.reorder'
      readonly orderedKeys: ReadonlyArray<string>
    }
  | { readonly type: 'channel.delete'; readonly key: string; readonly channelId: string }
  | { readonly type: 'welcome.update'; readonly desired: WelcomeScreenBlueprint }
  | { readonly type: 'onboarding.update'; readonly desired: OnboardingBlueprint }
  | {
      readonly type: 'automod.create'
      readonly key: string
      readonly desired: AutoModerationRuleBlueprint
    }
  | {
      readonly type: 'automod.update'
      readonly key: string
      readonly ruleId: string
      readonly desired: AutoModerationRuleBlueprint
    }
  | { readonly type: 'automod.delete'; readonly key: string; readonly ruleId: string }

export interface BlueprintPlan {
  readonly blueprintDigest: string
  readonly snapshotDigest: string
  readonly actions: ReadonlyArray<BlueprintAction>
  readonly destructive: boolean
  readonly warnings: ReadonlyArray<string>
}
