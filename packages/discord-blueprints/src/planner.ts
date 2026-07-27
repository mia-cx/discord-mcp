import { createHash } from 'node:crypto'
import { PermissionFlagsBits } from 'discord-api-types/v10'
import { BlueprintError } from './errors.js'
import { permissionBits } from './permissions.js'
import type {
  AutoModerationRuleBlueprint,
  BlueprintAction,
  BlueprintBindings,
  BlueprintPlan,
  ChannelBlueprint,
  GuildChannelSnapshot,
  GuildRoleSnapshot,
  GuildSettingsBlueprint,
  GuildSnapshot,
  OnboardingBlueprint,
  RoleBlueprint,
  ServerBlueprint,
  WelcomeScreenBlueprint,
} from './types.js'

const snowflake = /^\d{17,21}$/
const logicalKey = /^[a-z][a-z0-9_-]{0,63}$/

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

export const digest = (value: unknown): string =>
  createHash('sha256').update(canonical(value)).digest('hex')

const verificationLevels = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  veryHigh: 4,
} as const
const defaultMessageNotifications = { allMessages: 0, onlyMentions: 1 } as const
const explicitContentFilters = { disabled: 0, membersWithoutRoles: 1, allMembers: 2 } as const
const forumLayouts = { notSet: 0, list: 1, gallery: 2 } as const
const forumSortOrders = { latestActivity: 0, creationDate: 1 } as const
const automodPresets = { profanity: 1, sexualContent: 2, slurs: 3 } as const

const bound = (values: Readonly<Record<string, string>>, key: string, type: string): string => {
  const id = values[key]
  if (!id) throw new BlueprintError(`${type} ${key} is not bound to a Discord object yet`)
  return id
}

export const guildSettingsBody = (
  settings: GuildSettingsBlueprint,
  channelBindings: Readonly<Record<string, string>>,
): Readonly<Record<string, unknown>> => ({
  ...(settings.name === undefined ? {} : { name: settings.name }),
  ...(settings.verificationLevel === undefined
    ? {}
    : { verification_level: verificationLevels[settings.verificationLevel] }),
  ...(settings.defaultMessageNotifications === undefined
    ? {}
    : {
        default_message_notifications:
          defaultMessageNotifications[settings.defaultMessageNotifications],
      }),
  ...(settings.explicitContentFilter === undefined
    ? {}
    : { explicit_content_filter: explicitContentFilters[settings.explicitContentFilter] }),
  ...(settings.afkChannelKey === undefined
    ? {}
    : {
        afk_channel_id:
          settings.afkChannelKey === null
            ? null
            : bound(channelBindings, settings.afkChannelKey, 'channel'),
      }),
  ...(settings.afkTimeout === undefined ? {} : { afk_timeout: settings.afkTimeout }),
  ...(settings.systemChannelKey === undefined
    ? {}
    : {
        system_channel_id:
          settings.systemChannelKey === null
            ? null
            : bound(channelBindings, settings.systemChannelKey, 'channel'),
      }),
  ...(settings.rulesChannelKey === undefined
    ? {}
    : {
        rules_channel_id:
          settings.rulesChannelKey === null
            ? null
            : bound(channelBindings, settings.rulesChannelKey, 'channel'),
      }),
  ...(settings.publicUpdatesChannelKey === undefined
    ? {}
    : {
        public_updates_channel_id:
          settings.publicUpdatesChannelKey === null
            ? null
            : bound(channelBindings, settings.publicUpdatesChannelKey, 'channel'),
      }),
  ...(settings.safetyAlertsChannelKey === undefined
    ? {}
    : {
        safety_alerts_channel_id:
          settings.safetyAlertsChannelKey === null
            ? null
            : bound(channelBindings, settings.safetyAlertsChannelKey, 'channel'),
      }),
  ...(settings.preferredLocale === undefined ? {} : { preferred_locale: settings.preferredLocale }),
  ...(settings.premiumProgressBarEnabled === undefined
    ? {}
    : { premium_progress_bar_enabled: settings.premiumProgressBarEnabled }),
})

export const welcomeScreenBody = (
  welcome: WelcomeScreenBlueprint,
  channelBindings: Readonly<Record<string, string>>,
): Readonly<Record<string, unknown>> => ({
  enabled: welcome.enabled,
  ...(welcome.description === undefined ? {} : { description: welcome.description }),
  welcome_channels: welcome.channels.map((channel) => ({
    channel_id: bound(channelBindings, channel.channelKey, 'channel'),
    description: channel.description,
    ...(channel.emojiId === undefined ? {} : { emoji_id: channel.emojiId }),
    ...(channel.emojiName === undefined ? {} : { emoji_name: channel.emojiName }),
  })),
})

export const onboardingBody = (
  onboarding: OnboardingBlueprint,
  bindings: BlueprintBindings,
): Readonly<Record<string, unknown>> => ({
  enabled: onboarding.enabled,
  mode: onboarding.mode === 'advanced' ? 1 : 0,
  default_channel_ids: onboarding.defaultChannelKeys.map((key) =>
    bound(bindings.channels, key, 'channel'),
  ),
  prompts: onboarding.prompts.map((prompt) => ({
    type: prompt.type === 'dropdown' ? 1 : 0,
    title: prompt.title,
    single_select: prompt.singleSelect ?? false,
    required: prompt.required ?? false,
    in_onboarding: prompt.inOnboarding ?? true,
    options: prompt.options.map((option) => ({
      title: option.title,
      ...(option.description === undefined ? {} : { description: option.description }),
      channel_ids: (option.channelKeys ?? []).map((key) =>
        bound(bindings.channels, key, 'channel'),
      ),
      role_ids: [
        ...(option.roleKeys ?? []).map((key) => bound(bindings.roles, key, 'role')),
        ...(option.roleIds ?? []),
      ],
      ...(option.emojiId === undefined ? {} : { emoji_id: option.emojiId }),
      ...(option.emojiName === undefined ? {} : { emoji_name: option.emojiName }),
    })),
  })),
})

export const autoModerationBody = (
  rule: AutoModerationRuleBlueprint,
  bindings: BlueprintBindings,
): Readonly<Record<string, unknown>> => {
  const triggerType = {
    keyword: 1,
    spam: 3,
    keywordPreset: 4,
    mentionSpam: 5,
    memberProfile: 6,
  }[rule.trigger.type]
  const triggerMetadata =
    rule.trigger.type === 'keyword' || rule.trigger.type === 'memberProfile'
      ? {
          keyword_filter: rule.trigger.keywords ?? [],
          regex_patterns: rule.trigger.regexPatterns ?? [],
          allow_list: rule.trigger.allowList ?? [],
        }
      : rule.trigger.type === 'keywordPreset'
        ? {
            presets: rule.trigger.presets.map((preset) => automodPresets[preset]),
            allow_list: rule.trigger.allowList ?? [],
          }
        : rule.trigger.type === 'mentionSpam'
          ? {
              mention_total_limit: rule.trigger.mentionTotalLimit,
              mention_raid_protection_enabled: rule.trigger.mentionRaidProtectionEnabled ?? false,
            }
          : {}
  return {
    name: rule.name,
    event_type: 1,
    trigger_type: triggerType,
    trigger_metadata: triggerMetadata,
    actions: rule.actions.map((action) =>
      action.type === 'blockMessage'
        ? {
            type: 1,
            ...(action.customMessage === undefined
              ? {}
              : { metadata: { custom_message: action.customMessage } }),
          }
        : action.type === 'sendAlert'
          ? {
              type: 2,
              metadata: { channel_id: bound(bindings.channels, action.channelKey, 'channel') },
            }
          : { type: 3, metadata: { duration_seconds: action.durationSeconds } },
    ),
    enabled: rule.enabled ?? true,
    exempt_roles: [
      ...(rule.exemptRoleKeys ?? []).map((key) => bound(bindings.roles, key, 'role')),
      ...(rule.exemptRoleIds ?? []),
    ],
    exempt_channels: [
      ...(rule.exemptChannelKeys ?? []).map((key) => bound(bindings.channels, key, 'channel')),
      ...(rule.exemptChannelIds ?? []),
    ],
  }
}

export const validateBlueprint = (blueprint: ServerBlueprint): void => {
  if (!snowflake.test(blueprint.guildId))
    throw new BlueprintError('guildId must be a Discord snowflake')
  if (!Number.isInteger(blueprint.revision) || blueprint.revision < 1) {
    throw new BlueprintError('blueprint revision must be a positive integer')
  }
  const roleKeys = new Set<string>()
  for (const role of blueprint.roles) {
    if (!logicalKey.test(role.key)) throw new BlueprintError(`Invalid role key: ${role.key}`)
    if (roleKeys.has(role.key)) throw new BlueprintError(`Duplicate role key: ${role.key}`)
    roleKeys.add(role.key)
    permissionBits(role.permissions ?? [])
  }
  const channelKeys = new Set<string>()
  for (const channel of blueprint.channels) {
    if (!logicalKey.test(channel.key))
      throw new BlueprintError(`Invalid channel key: ${channel.key}`)
    if (channelKeys.has(channel.key))
      throw new BlueprintError(`Duplicate channel key: ${channel.key}`)
    channelKeys.add(channel.key)
  }
  for (const channel of blueprint.channels) {
    if (channel.parentKey !== undefined && !channelKeys.has(channel.parentKey)) {
      throw new BlueprintError(
        `Channel ${channel.key} refers to missing parent ${channel.parentKey}`,
      )
    }
    if (
      channel.parentKey !== undefined &&
      blueprint.channels.find(({ key }) => key === channel.parentKey)?.kind !== 'category'
    ) {
      throw new BlueprintError(
        `Channel ${channel.key} parent ${channel.parentKey} is not a category`,
      )
    }
    for (const overwrite of channel.overwrites ?? []) {
      const allow = new Set(overwrite.allow ?? [])
      for (const denied of overwrite.deny ?? []) {
        if (allow.has(denied)) {
          throw new BlueprintError(
            `Channel ${channel.key} overwrite contains ${denied} in both allow and deny`,
          )
        }
      }
      permissionBits(overwrite.allow ?? [])
      permissionBits(overwrite.deny ?? [])
      if (overwrite.target.type === 'role' && !roleKeys.has(overwrite.target.roleKey)) {
        throw new BlueprintError(
          `Channel ${channel.key} overwrite refers to missing role ${overwrite.target.roleKey}`,
        )
      }
    }
    const tagKeys = new Set<string>()
    for (const tag of channel.forumTags ?? []) {
      if (channel.kind !== 'forum' && channel.kind !== 'media') {
        throw new BlueprintError(
          `Channel ${channel.key} can declare forum tags only for forum or media`,
        )
      }
      if (!logicalKey.test(tag.key)) throw new BlueprintError(`Invalid forum tag key: ${tag.key}`)
      if (tagKeys.has(tag.key)) throw new BlueprintError(`Duplicate forum tag key: ${tag.key}`)
      if (tag.emojiId !== undefined && tag.emojiName !== undefined) {
        throw new BlueprintError(`Forum tag ${tag.key} cannot set both emojiId and emojiName`)
      }
      tagKeys.add(tag.key)
    }
  }
  const checkChannelKey = (key: string | null | undefined, field: string): void => {
    if (key !== undefined && key !== null && !channelKeys.has(key)) {
      throw new BlueprintError(`${field} refers to missing channel ${key}`)
    }
  }
  checkChannelKey(blueprint.settings?.afkChannelKey, 'settings.afkChannelKey')
  checkChannelKey(blueprint.settings?.systemChannelKey, 'settings.systemChannelKey')
  checkChannelKey(blueprint.settings?.rulesChannelKey, 'settings.rulesChannelKey')
  checkChannelKey(blueprint.settings?.publicUpdatesChannelKey, 'settings.publicUpdatesChannelKey')
  checkChannelKey(blueprint.settings?.safetyAlertsChannelKey, 'settings.safetyAlertsChannelKey')
  for (const welcomeChannel of blueprint.welcomeScreen?.channels ?? []) {
    checkChannelKey(welcomeChannel.channelKey, 'welcomeScreen.channels')
  }
  const promptKeys = new Set<string>()
  for (const key of blueprint.onboarding?.defaultChannelKeys ?? []) {
    checkChannelKey(key, 'onboarding.defaultChannelKeys')
  }
  for (const prompt of blueprint.onboarding?.prompts ?? []) {
    if (!logicalKey.test(prompt.key))
      throw new BlueprintError(`Invalid onboarding prompt key: ${prompt.key}`)
    if (promptKeys.has(prompt.key))
      throw new BlueprintError(`Duplicate onboarding prompt key: ${prompt.key}`)
    promptKeys.add(prompt.key)
    const optionKeys = new Set<string>()
    for (const option of prompt.options) {
      if (!logicalKey.test(option.key)) {
        throw new BlueprintError(`Invalid onboarding option key: ${option.key}`)
      }
      if (optionKeys.has(option.key)) {
        throw new BlueprintError(`Duplicate onboarding option key: ${option.key}`)
      }
      optionKeys.add(option.key)
      for (const key of option.channelKeys ?? []) {
        checkChannelKey(key, `onboarding prompt ${prompt.key}`)
      }
      for (const key of option.roleKeys ?? []) {
        if (!roleKeys.has(key)) {
          throw new BlueprintError(`Onboarding prompt ${prompt.key} refers to missing role ${key}`)
        }
      }
    }
  }
  const automodKeys = new Set<string>()
  for (const rule of blueprint.autoModerationRules ?? []) {
    if (!logicalKey.test(rule.key))
      throw new BlueprintError(`Invalid AutoMod rule key: ${rule.key}`)
    if (automodKeys.has(rule.key))
      throw new BlueprintError(`Duplicate AutoMod rule key: ${rule.key}`)
    automodKeys.add(rule.key)
    if (rule.actions.length === 0)
      throw new BlueprintError(`AutoMod rule ${rule.key} needs an action`)
    if (
      rule.trigger.type === 'mentionSpam' &&
      (rule.trigger.mentionTotalLimit < 1 || rule.trigger.mentionTotalLimit > 50)
    ) {
      throw new BlueprintError(
        `AutoMod rule ${rule.key} mentionTotalLimit must be between 1 and 50`,
      )
    }
    for (const key of rule.exemptRoleKeys ?? []) {
      if (!roleKeys.has(key))
        throw new BlueprintError(`AutoMod rule ${rule.key} refers to missing role ${key}`)
    }
    for (const key of rule.exemptChannelKeys ?? []) {
      checkChannelKey(key, `AutoMod rule ${rule.key}`)
    }
    for (const action of rule.actions) {
      if (action.type === 'sendAlert')
        checkChannelKey(action.channelKey, `AutoMod rule ${rule.key}`)
      if (
        action.type === 'timeout' &&
        (action.durationSeconds < 1 || action.durationSeconds > 2_419_200)
      ) {
        throw new BlueprintError(
          `AutoMod rule ${rule.key} timeout must be between 1 and 2419200 seconds`,
        )
      }
    }
  }
}

const roleChanged = (desired: RoleBlueprint, actual: GuildRoleSnapshot): boolean =>
  desired.name !== actual.name ||
  permissionBits(desired.permissions ?? []).toString() !== actual.permissions ||
  (desired.color ?? 0) !== actual.color ||
  (desired.hoist ?? false) !== actual.hoist ||
  (desired.mentionable ?? false) !== actual.mentionable

const channelChanged = (
  desired: ChannelBlueprint,
  actual: GuildChannelSnapshot,
  bindings: BlueprintBindings,
): boolean =>
  desired.name !== actual.name ||
  desired.kind !== actual.kind ||
  (desired.parentKey === undefined ? undefined : bindings.channels[desired.parentKey]) !==
    actual.parentId ||
  (desired.topic ?? null) !== (actual.topic ?? null) ||
  (desired.nsfw ?? false) !== (actual.nsfw ?? false) ||
  (desired.bitrate ?? actual.bitrate) !== actual.bitrate ||
  (desired.userLimit ?? actual.userLimit) !== actual.userLimit ||
  (desired.rateLimitPerUser ?? actual.rateLimitPerUser) !== actual.rateLimitPerUser ||
  (desired.defaultThreadRateLimitPerUser ?? actual.defaultThreadRateLimitPerUser) !==
    actual.defaultThreadRateLimitPerUser ||
  (desired.defaultAutoArchiveDuration ?? actual.defaultAutoArchiveDuration) !==
    actual.defaultAutoArchiveDuration ||
  (desired.defaultForumLayout === undefined
    ? actual.defaultForumLayout
    : forumLayouts[desired.defaultForumLayout]) !== actual.defaultForumLayout ||
  (desired.defaultSortOrder === undefined
    ? actual.defaultSortOrder
    : forumSortOrders[desired.defaultSortOrder]) !== actual.defaultSortOrder ||
  canonical(
    desired.defaultReactionEmoji === undefined
      ? actual.defaultReactionEmoji
      : desired.defaultReactionEmoji,
  ) !== canonical(actual.defaultReactionEmoji) ||
  canonical(
    desired.forumTags === undefined
      ? actual.forumTags
      : desired.forumTags.map(({ name, moderated, emojiId, emojiName }) => ({
          name,
          moderated: moderated ?? false,
          ...(emojiId === undefined ? {} : { emojiId }),
          ...(emojiName === undefined ? {} : { emojiName }),
        })),
  ) !==
    canonical(
      actual.forumTags?.map(({ name, moderated, emojiId, emojiName }) => ({
        name,
        moderated,
        ...(emojiId === undefined ? {} : { emojiId }),
        ...(emojiName === undefined ? {} : { emojiName }),
      })),
    )

const overwritesChanged = (
  desired: ChannelBlueprint,
  actual: GuildChannelSnapshot,
  bindings: BlueprintBindings,
  guildId: string,
): boolean => {
  const normalizedDesired = (desired.overwrites ?? [])
    .map((overwrite) => {
      const id =
        overwrite.target.type === 'everyone'
          ? guildId
          : overwrite.target.type === 'role'
            ? bindings.roles[overwrite.target.roleKey]
            : overwrite.target.type === 'roleId'
              ? overwrite.target.roleId
              : overwrite.target.memberId
      if (id === undefined) return undefined
      return {
        id,
        type: overwrite.target.type === 'member' ? 'member' : 'role',
        allow: permissionBits(overwrite.allow ?? []).toString(),
        deny: permissionBits(overwrite.deny ?? []).toString(),
      }
    })
    .filter((overwrite): overwrite is NonNullable<typeof overwrite> => overwrite !== undefined)
    .sort((left, right) => `${left.type}:${left.id}`.localeCompare(`${right.type}:${right.id}`))
  if (normalizedDesired.length !== (desired.overwrites ?? []).length) return true
  const normalizedActual = [...actual.overwrites]
    .map(({ id, type, allow, deny }) => ({ id, type, allow, deny }))
    .sort((left, right) => `${left.type}:${left.id}`.localeCompare(`${right.type}:${right.id}`))
  return canonical(normalizedDesired) !== canonical(normalizedActual)
}

const overwriteTargetIds = (
  desired: ChannelBlueprint,
  bindings: BlueprintBindings,
  guildId: string,
): ReadonlySet<string> =>
  new Set(
    (desired.overwrites ?? [])
      .map((overwrite) =>
        overwrite.target.type === 'everyone'
          ? guildId
          : overwrite.target.type === 'role'
            ? bindings.roles[overwrite.target.roleKey]
            : overwrite.target.type === 'roleId'
              ? overwrite.target.roleId
              : overwrite.target.memberId,
      )
      .filter((id): id is string => id !== undefined),
  )

const sortedKeys = <A extends { readonly key: string; readonly order?: number }>(
  values: ReadonlyArray<A>,
): ReadonlyArray<string> =>
  [...values]
    .sort(
      (left, right) => (left.order ?? 0) - (right.order ?? 0) || left.key.localeCompare(right.key),
    )
    .map(({ key }) => key)

const botHighestPosition = (snapshot: GuildSnapshot): number =>
  Math.max(
    -1,
    ...snapshot.roles
      .filter(({ id }) => snapshot.botRoleIds.includes(id))
      .map(({ position }) => position),
  )

const botPermissions = (snapshot: GuildSnapshot): bigint => {
  if (snapshot.botMemberId === snapshot.ownerId) {
    return Object.values(PermissionFlagsBits).reduce((left, right) => left | right, 0n)
  }
  let bits = BigInt(snapshot.roles.find(({ id }) => id === snapshot.guildId)?.permissions ?? '0')
  for (const role of snapshot.roles) {
    if (snapshot.botRoleIds.includes(role.id)) bits |= BigInt(role.permissions)
  }
  return bits
}

const containsDesired = (actual: unknown, desired: unknown): boolean => {
  if (Array.isArray(desired)) {
    return (
      Array.isArray(actual) &&
      actual.length === desired.length &&
      desired.every((value, index) => containsDesired(actual[index], value))
    )
  }
  if (typeof desired === 'object' && desired !== null) {
    if (typeof actual !== 'object' || actual === null || Array.isArray(actual)) return false
    return Object.entries(desired).every(([key, value]) =>
      containsDesired((actual as Record<string, unknown>)[key], value),
    )
  }
  return Object.is(actual, desired)
}

const encodesDifferently = (
  encode: () => Readonly<Record<string, unknown>>,
  actual: unknown,
): boolean => {
  try {
    return !containsDesired(actual, encode())
  } catch {
    return true
  }
}

export const planBlueprint = (options: {
  readonly blueprint: ServerBlueprint
  readonly snapshot: GuildSnapshot
  readonly bindings: BlueprintBindings
  readonly deleteManaged?: boolean
}): BlueprintPlan => {
  const { blueprint, snapshot, bindings } = options
  validateBlueprint(blueprint)
  if (blueprint.guildId !== snapshot.guildId) {
    throw new BlueprintError('blueprint and snapshot target different guilds')
  }
  const actions: Array<BlueprintAction> = []
  const warnings: Array<string> = []
  const highest = botHighestPosition(snapshot)
  const heldPermissions = botPermissions(snapshot)
  const administrator = (heldPermissions & PermissionFlagsBits.Administrator) !== 0n
  const desiredRoleKeys = new Set(blueprint.roles.map(({ key }) => key))
  const desiredChannelKeys = new Set(blueprint.channels.map(({ key }) => key))
  const desiredAutomodKeys = new Set((blueprint.autoModerationRules ?? []).map(({ key }) => key))

  for (const desired of blueprint.roles) {
    const missing = (desired.permissions ?? []).filter((name) => {
      const required = permissionBits([name])
      return !administrator && (heldPermissions & required) !== required
    })
    if (missing.length > 0) {
      throw new BlueprintError(
        `Role ${desired.key} grants permissions the bot does not hold: ${missing.join(', ')}`,
      )
    }
    const roleId = bindings.roles[desired.key]
    if (roleId === undefined) {
      actions.push({ type: 'role.create', key: desired.key, desired })
      continue
    }
    const actual = snapshot.roles.find(({ id }) => id === roleId)
    if (!actual) {
      throw new BlueprintError(
        `Binding for role ${desired.key} points to missing Discord role ${roleId}`,
      )
    }
    if (actual.managed || actual.id === snapshot.guildId) {
      throw new BlueprintError(`Role ${desired.key} is managed by Discord and cannot be changed`)
    }
    if (actual.position >= highest) {
      throw new BlueprintError(
        `Role ${desired.key} is at or above the bot's highest role; move the bot role above it first`,
      )
    }
    if (roleChanged(desired, actual)) {
      actions.push({ type: 'role.update', key: desired.key, roleId, desired })
    }
  }
  const roleOrder = sortedKeys(blueprint.roles)
  const currentRoleOrder = snapshot.roles
    .filter(({ id }) => Object.values(bindings.roles).includes(id))
    .sort((left, right) => left.position - right.position)
    .map(({ id }) => Object.entries(bindings.roles).find(([, bound]) => bound === id)?.[0])
    .filter((key): key is string => key !== undefined)
  if (roleOrder.length > 0 && canonical(roleOrder) !== canonical(currentRoleOrder)) {
    actions.push({ type: 'role.reorder', orderedKeys: roleOrder })
  }

  const categories = blueprint.channels.filter(({ kind }) => kind === 'category')
  const otherChannels = blueprint.channels.filter(({ kind }) => kind !== 'category')
  for (const desired of [...categories, ...otherChannels]) {
    const channelId = bindings.channels[desired.key]
    if (channelId === undefined) {
      actions.push({ type: 'channel.create', key: desired.key, desired })
      if ((desired.overwrites?.length ?? 0) > 0) {
        actions.push({
          type: 'channel.overwrites',
          key: desired.key,
          overwrites: desired.overwrites ?? [],
          deleteOverwriteIds: [],
        })
      }
      continue
    }
    const actual = snapshot.channels.find(({ id }) => id === channelId)
    if (!actual) {
      throw new BlueprintError(
        `Binding for channel ${desired.key} points to missing channel ${channelId}`,
      )
    }
    if (channelChanged(desired, actual, bindings)) {
      actions.push({ type: 'channel.update', key: desired.key, channelId, desired })
    }
    if (overwritesChanged(desired, actual, bindings, snapshot.guildId)) {
      const desiredTargets = overwriteTargetIds(desired, bindings, snapshot.guildId)
      actions.push({
        type: 'channel.overwrites',
        key: desired.key,
        channelId,
        overwrites: desired.overwrites ?? [],
        deleteOverwriteIds: actual.overwrites
          .filter(({ id }) => !desiredTargets.has(id))
          .map(({ id }) => id),
      })
    }
  }

  const channelOrder = sortedKeys(blueprint.channels)
  const currentChannelOrder = snapshot.channels
    .filter(({ id }) => Object.values(bindings.channels).includes(id))
    .sort((left, right) => left.position - right.position)
    .map(({ id }) => Object.entries(bindings.channels).find(([, bound]) => bound === id)?.[0])
    .filter((key): key is string => key !== undefined)
  if (channelOrder.length > 0 && canonical(channelOrder) !== canonical(currentChannelOrder)) {
    actions.push({ type: 'channel.reorder', orderedKeys: channelOrder })
  }

  if (
    blueprint.settings &&
    encodesDifferently(
      () => guildSettingsBody(blueprint.settings as GuildSettingsBlueprint, bindings.channels),
      snapshot.settings,
    )
  ) {
    actions.push({ type: 'guild.update', desired: blueprint.settings })
  }
  if (
    blueprint.welcomeScreen &&
    encodesDifferently(
      () => welcomeScreenBody(blueprint.welcomeScreen as WelcomeScreenBlueprint, bindings.channels),
      snapshot.welcomeScreen,
    )
  ) {
    actions.push({ type: 'welcome.update', desired: blueprint.welcomeScreen })
  }
  if (
    blueprint.onboarding &&
    encodesDifferently(
      () => onboardingBody(blueprint.onboarding as OnboardingBlueprint, bindings),
      snapshot.onboarding,
    )
  ) {
    actions.push({ type: 'onboarding.update', desired: blueprint.onboarding })
  }
  for (const desired of blueprint.autoModerationRules ?? []) {
    const ruleId = bindings.autoModerationRules?.[desired.key]
    if (!ruleId) {
      actions.push({ type: 'automod.create', key: desired.key, desired })
      continue
    }
    const actual = snapshot.autoModerationRules?.find(({ id }) => id === ruleId)
    if (!actual) {
      throw new BlueprintError(
        `Binding for AutoMod rule ${desired.key} points to missing Discord rule ${ruleId}`,
      )
    }
    if (encodesDifferently(() => autoModerationBody(desired, bindings), actual)) {
      actions.push({ type: 'automod.update', key: desired.key, ruleId, desired })
    }
  }

  if (options.deleteManaged) {
    for (const [key, ruleId] of Object.entries(bindings.autoModerationRules ?? {})) {
      if (!desiredAutomodKeys.has(key)) actions.push({ type: 'automod.delete', key, ruleId })
    }
    for (const [key, channelId] of Object.entries(bindings.channels)) {
      if (!desiredChannelKeys.has(key)) actions.push({ type: 'channel.delete', key, channelId })
    }
    for (const [key, roleId] of Object.entries(bindings.roles)) {
      if (!desiredRoleKeys.has(key)) actions.push({ type: 'role.delete', key, roleId })
    }
  } else {
    const omitted = [
      ...Object.keys(bindings.roles).filter((key) => !desiredRoleKeys.has(key)),
      ...Object.keys(bindings.channels).filter((key) => !desiredChannelKeys.has(key)),
      ...Object.keys(bindings.autoModerationRules ?? {}).filter(
        (key) => !desiredAutomodKeys.has(key),
      ),
    ]
    if (omitted.length > 0) {
      warnings.push(`Managed objects omitted but preserved: ${omitted.join(', ')}`)
    }
  }

  return {
    blueprintDigest: digest(blueprint),
    snapshotDigest: digest(snapshot),
    actions,
    destructive: actions.some(
      ({ type }) =>
        type === 'role.delete' || type === 'channel.delete' || type === 'automod.delete',
    ),
    warnings,
  }
}
