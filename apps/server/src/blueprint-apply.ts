import { randomUUID } from 'node:crypto'
import {
  type DiscordDispatcher,
  type DispatchInput,
  operationCatalog,
} from '@discord-mcp/discord-api'
import {
  autoModerationBody,
  type BlueprintAction,
  type BlueprintActionExecutor,
  BlueprintError,
  type BlueprintExecution,
  type BlueprintJournal,
  digest as blueprintDigest,
  guildSettingsBody,
  onboardingBody,
  permissionBits,
  welcomeScreenBody,
} from '@discord-mcp/discord-blueprints'
import type { Database } from '@discord-mcp/persistence'
import { Effect } from 'effect'

export class SqliteBlueprintJournal implements BlueprintJournal {
  constructor(
    readonly database: Database,
    readonly blueprintId: string,
    readonly revision: number,
    readonly principalId: string,
  ) {}

  create(plan: Parameters<BlueprintJournal['create']>[0]): BlueprintExecution {
    const id = randomUUID()
    const actionsDigest = digestActions(plan.actions)
    const now = new Date().toISOString()
    this.database.transaction(() => {
      this.database.run(
        `INSERT INTO server_blueprint_executions
         (id, blueprint_id, revision, principal_id, snapshot_digest, actions_digest,
          status, started_at)
         VALUES (?, ?, ?, ?, ?, ?, 'running', ?)`,
        id,
        this.blueprintId,
        this.revision,
        this.principalId,
        plan.snapshotDigest,
        actionsDigest,
        now,
      )
      plan.actions.forEach((action, index) => {
        this.database.run(
          `INSERT INTO server_blueprint_actions
           (execution_id, action_index, action_json, status)
           VALUES (?, ?, ?, 'pending')`,
          id,
          index,
          JSON.stringify(action),
        )
      })
    })
    return {
      id,
      blueprintDigest: plan.blueprintDigest,
      snapshotDigest: plan.snapshotDigest,
      actionsDigest,
      status: 'running',
      actions: plan.actions.map((action, index) => ({ index, action, status: 'pending' })),
    }
  }

  get(executionId: string): BlueprintExecution | undefined {
    const execution = this.database.get<{
      id: string
      snapshot_digest: string
      actions_digest: string
      status: BlueprintExecution['status']
    }>(
      `SELECT id, snapshot_digest, actions_digest, status
       FROM server_blueprint_executions
       WHERE id = ? AND blueprint_id = ? AND revision = ?`,
      executionId,
      this.blueprintId,
      this.revision,
    )
    if (!execution) return undefined
    const revision = this.database.get<{ document_json: string }>(
      `SELECT document_json FROM server_blueprint_revisions
       WHERE blueprint_id = ? AND revision = ?`,
      this.blueprintId,
      this.revision,
    )
    if (!revision) return undefined
    const actions = this.database
      .all<{
        action_index: number
        action_json: string
        status: 'pending' | 'running' | 'completed' | 'failed'
        result_json: string | null
      }>(
        `SELECT action_index, action_json, status, result_json
         FROM server_blueprint_actions WHERE execution_id = ? ORDER BY action_index`,
        executionId,
      )
      .map((row) => ({
        index: row.action_index,
        action: JSON.parse(row.action_json) as BlueprintAction,
        status: row.status,
        ...(row.result_json === null ? {} : { result: JSON.parse(row.result_json) }),
      }))
    return {
      id: execution.id,
      blueprintDigest: blueprintDigest(JSON.parse(revision.document_json)),
      snapshotDigest: execution.snapshot_digest,
      actionsDigest: execution.actions_digest,
      status: execution.status,
      actions,
    }
  }

  update(execution: BlueprintExecution): void {
    this.database.transaction(() => {
      this.database.run(
        `UPDATE server_blueprint_executions SET status = ?, finished_at = ?
         WHERE id = ?`,
        execution.status,
        execution.status === 'running' ? null : new Date().toISOString(),
        execution.id,
      )
      for (const action of execution.actions) {
        this.database.run(
          `UPDATE server_blueprint_actions SET status = ?, result_json = ?,
           started_at = CASE WHEN ? = 'running' THEN COALESCE(started_at, ?) ELSE started_at END,
           finished_at = CASE WHEN ? IN ('completed', 'failed') THEN ? ELSE finished_at END
           WHERE execution_id = ? AND action_index = ?`,
          action.status,
          action.result === undefined ? null : JSON.stringify(action.result),
          action.status,
          new Date().toISOString(),
          action.status,
          new Date().toISOString(),
          execution.id,
          action.index,
        )
      }
    })
  }
}

export class BlueprintDiscordExecutor implements BlueprintActionExecutor {
  constructor(
    readonly database: Database,
    readonly dispatcher: DiscordDispatcher,
    readonly principalId: string,
    readonly blueprintId: string,
    readonly guildId: string,
  ) {}

  async execute(action: BlueprintAction): Promise<unknown> {
    switch (action.type) {
      case 'guild.update':
        return this.#dispatch('update_guild', {
          path: { guild_id: this.guildId },
          body: guildSettingsBody(action.desired, this.#bindings('channel')),
        })
      case 'role.create': {
        const result = await this.#dispatch('create_guild_role', {
          path: { guild_id: this.guildId },
          body: roleBody(action.desired),
        })
        this.#bind('role', action.key, snowflakeFrom(result))
        return result
      }
      case 'role.update':
        return this.#dispatch('update_guild_role', {
          path: { guild_id: this.guildId, role_id: action.roleId },
          body: roleBody(action.desired),
        })
      case 'role.reorder':
        return this.#dispatch('bulk_update_guild_roles', {
          path: { guild_id: this.guildId },
          body: action.orderedKeys.map((key, position) => ({
            id: this.#binding('role', key),
            position: position + 1,
          })),
        })
      case 'role.delete': {
        const result = await this.#dispatch('delete_guild_role', {
          path: { guild_id: this.guildId, role_id: action.roleId },
        })
        this.#unbind('role', action.key)
        return result
      }
      case 'channel.create': {
        const result = await this.#dispatch('create_guild_channel', {
          path: { guild_id: this.guildId },
          body: channelBody(action.desired, (key) => this.#binding('channel', key)),
        })
        this.#bind('channel', action.key, snowflakeFrom(result))
        return result
      }
      case 'channel.update':
        return this.#dispatch('update_channel', {
          path: { channel_id: action.channelId },
          body: channelBody(action.desired, (key) => this.#binding('channel', key)),
        })
      case 'channel.overwrites': {
        const channelId = action.channelId ?? this.#binding('channel', action.key)
        const wanted = new Set<string>()
        const results: Array<unknown> = []
        for (const overwrite of action.overwrites) {
          const targetId =
            overwrite.target.type === 'everyone'
              ? this.guildId
              : overwrite.target.type === 'role'
                ? this.#binding('role', overwrite.target.roleKey)
                : overwrite.target.type === 'roleId'
                  ? overwrite.target.roleId
                  : overwrite.target.memberId
          wanted.add(targetId)
          results.push(
            await this.#dispatch('set_channel_permission_overwrite', {
              path: { channel_id: channelId, overwrite_id: targetId },
              body: {
                type: overwrite.target.type === 'member' ? 1 : 0,
                allow: permissionBits(overwrite.allow ?? []).toString(),
                deny: permissionBits(overwrite.deny ?? []).toString(),
              },
            }),
          )
        }
        for (const overwriteId of action.deleteOverwriteIds) {
          results.push(
            await this.#dispatch('delete_channel_permission_overwrite', {
              path: { channel_id: channelId, overwrite_id: overwriteId },
            }),
          )
        }
        return results
      }
      case 'channel.reorder':
        return this.#dispatch('bulk_update_guild_channels', {
          path: { guild_id: this.guildId },
          body: action.orderedKeys.map((key, position) => ({
            id: this.#binding('channel', key),
            position,
          })),
        })
      case 'channel.delete': {
        const result = await this.#dispatch('delete_channel', {
          path: { channel_id: action.channelId },
        })
        this.#unbind('channel', action.key)
        return result
      }
      case 'welcome.update':
        return this.#dispatch('update_guild_welcome_screen', {
          path: { guild_id: this.guildId },
          body: welcomeScreenBody(action.desired, this.#bindings('channel')),
        })
      case 'onboarding.update':
        return this.#dispatch('put_guilds_onboarding', {
          path: { guild_id: this.guildId },
          body: onboardingBody(action.desired, {
            roles: this.#bindings('role'),
            channels: this.#bindings('channel'),
            autoModerationRules: this.#bindings('automod'),
          }),
        })
      case 'automod.create': {
        const result = await this.#dispatch('create_auto_moderation_rule', {
          path: { guild_id: this.guildId },
          body: autoModerationBody(action.desired, {
            roles: this.#bindings('role'),
            channels: this.#bindings('channel'),
            autoModerationRules: this.#bindings('automod'),
          }),
        })
        this.#bind('automod', action.key, snowflakeFrom(result))
        return result
      }
      case 'automod.update':
        return this.#dispatch('update_auto_moderation_rule', {
          path: { guild_id: this.guildId, rule_id: action.ruleId },
          body: autoModerationBody(action.desired, {
            roles: this.#bindings('role'),
            channels: this.#bindings('channel'),
            autoModerationRules: this.#bindings('automod'),
          }),
        })
      case 'automod.delete': {
        const result = await this.#dispatch('delete_auto_moderation_rule', {
          path: { guild_id: this.guildId, rule_id: action.ruleId },
        })
        this.#unbind('automod', action.key)
        return result
      }
    }
  }

  async #dispatch(
    operationId: string,
    values: Omit<DispatchInput, 'operationId'>,
  ): Promise<unknown> {
    const operation = operationCatalog.describe(operationId)
    let input: DispatchInput = { operationId, ...values }
    if (operation.risk === 'destructive' || operation.risk === 'bot_admin') {
      const previewToken = this.dispatcher.preview(this.principalId, input).previewToken
      if (!previewToken)
        throw new BlueprintError(`no preview token for guarded action ${operationId}`)
      input = { ...input, previewToken }
    }
    return Effect.runPromise(this.dispatcher.dispatch(this.principalId, operation.risk, input))
  }

  #binding(type: 'role' | 'channel' | 'automod', key: string): string {
    const row = this.database.get<{ discord_id: string }>(
      `SELECT discord_id FROM server_blueprint_bindings
       WHERE blueprint_id = ? AND logical_type = ? AND logical_key = ?`,
      this.blueprintId,
      type,
      key,
    )
    if (!row) throw new BlueprintError(`missing ${type} binding for ${key}`)
    return row.discord_id
  }

  #bindings(type: 'role' | 'channel' | 'automod'): Readonly<Record<string, string>> {
    return Object.fromEntries(
      this.database
        .all<{ logical_key: string; discord_id: string }>(
          `SELECT logical_key, discord_id FROM server_blueprint_bindings
           WHERE blueprint_id = ? AND logical_type = ?`,
          this.blueprintId,
          type,
        )
        .map(({ logical_key, discord_id }) => [logical_key, discord_id]),
    )
  }

  #bind(type: 'role' | 'channel' | 'automod', key: string, discordId: string): void {
    this.database.run(
      `INSERT INTO server_blueprint_bindings
       (blueprint_id, logical_type, logical_key, discord_id, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(blueprint_id, logical_type, logical_key)
       DO UPDATE SET discord_id = excluded.discord_id`,
      this.blueprintId,
      type,
      key,
      discordId,
      new Date().toISOString(),
    )
  }

  #unbind(type: 'role' | 'channel' | 'automod', key: string): void {
    this.database.run(
      `DELETE FROM server_blueprint_bindings
       WHERE blueprint_id = ? AND logical_type = ? AND logical_key = ?`,
      this.blueprintId,
      type,
      key,
    )
  }
}

const digestActions = (actions: ReadonlyArray<BlueprintAction>): string => {
  const value = JSON.stringify(actions)
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

const snowflakeFrom = (value: unknown): string => {
  if (
    typeof value !== 'object' ||
    value === null ||
    typeof (value as { readonly id?: unknown }).id !== 'string'
  ) {
    throw new BlueprintError('Discord create response did not contain an id')
  }
  return (value as { readonly id: string }).id
}

const roleBody = (role: {
  readonly name: string
  readonly permissions?: ReadonlyArray<string>
  readonly color?: number
  readonly hoist?: boolean
  readonly mentionable?: boolean
}) => ({
  name: role.name,
  permissions: permissionBits(role.permissions ?? []).toString(),
  ...(role.color === undefined ? {} : { colors: { primary_color: role.color } }),
  ...(role.hoist === undefined ? {} : { hoist: role.hoist }),
  ...(role.mentionable === undefined ? {} : { mentionable: role.mentionable }),
})

const channelTypes: Readonly<Record<string, number>> = {
  text: 0,
  voice: 2,
  category: 4,
  announcement: 5,
  stage: 13,
  forum: 15,
  media: 16,
}

const channelBody = (
  channel: {
    readonly kind: string
    readonly name: string
    readonly parentKey?: string
    readonly topic?: string | null
    readonly nsfw?: boolean
    readonly bitrate?: number
    readonly userLimit?: number
    readonly rateLimitPerUser?: number
    readonly defaultThreadRateLimitPerUser?: number
    readonly defaultAutoArchiveDuration?: number
    readonly defaultForumLayout?: 'notSet' | 'list' | 'gallery'
    readonly defaultSortOrder?: 'latestActivity' | 'creationDate'
    readonly defaultReactionEmoji?: {
      readonly emojiId?: string
      readonly emojiName?: string
    } | null
    readonly forumTags?: ReadonlyArray<{
      readonly name: string
      readonly moderated?: boolean
      readonly emojiId?: string
      readonly emojiName?: string
    }>
  },
  binding: (key: string) => string,
) => ({
  name: channel.name,
  type: channelTypes[channel.kind],
  ...(channel.parentKey === undefined ? {} : { parent_id: binding(channel.parentKey) }),
  ...(channel.topic === undefined ? {} : { topic: channel.topic }),
  ...(channel.nsfw === undefined ? {} : { nsfw: channel.nsfw }),
  ...(channel.bitrate === undefined ? {} : { bitrate: channel.bitrate }),
  ...(channel.userLimit === undefined ? {} : { user_limit: channel.userLimit }),
  ...(channel.rateLimitPerUser === undefined
    ? {}
    : { rate_limit_per_user: channel.rateLimitPerUser }),
  ...(channel.defaultThreadRateLimitPerUser === undefined
    ? {}
    : { default_thread_rate_limit_per_user: channel.defaultThreadRateLimitPerUser }),
  ...(channel.defaultAutoArchiveDuration === undefined
    ? {}
    : { default_auto_archive_duration: channel.defaultAutoArchiveDuration }),
  ...(channel.defaultForumLayout === undefined
    ? {}
    : {
        default_forum_layout: { notSet: 0, list: 1, gallery: 2 }[channel.defaultForumLayout],
      }),
  ...(channel.defaultSortOrder === undefined
    ? {}
    : {
        default_sort_order: { latestActivity: 0, creationDate: 1 }[channel.defaultSortOrder],
      }),
  ...(channel.defaultReactionEmoji === undefined
    ? {}
    : channel.defaultReactionEmoji === null
      ? { default_reaction_emoji: null }
      : {
          default_reaction_emoji: {
            ...(channel.defaultReactionEmoji.emojiId === undefined
              ? {}
              : { emoji_id: channel.defaultReactionEmoji.emojiId }),
            ...(channel.defaultReactionEmoji.emojiName === undefined
              ? {}
              : { emoji_name: channel.defaultReactionEmoji.emojiName }),
          },
        }),
  ...(channel.forumTags === undefined
    ? {}
    : {
        available_tags: channel.forumTags.map((tag) => ({
          name: tag.name,
          moderated: tag.moderated ?? false,
          ...(tag.emojiId === undefined ? {} : { emoji_id: tag.emojiId }),
          ...(tag.emojiName === undefined ? {} : { emoji_name: tag.emojiName }),
        })),
      }),
})
