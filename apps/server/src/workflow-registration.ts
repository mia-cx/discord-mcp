import { DiscordApiError, type DiscordRestClient } from '@discord-mcp/discord-api'
import { assertGatewayEventIntents } from '@discord-mcp/discord-gateway'
import type { Database } from '@discord-mcp/persistence'
import type { EnabledWorkflow, WorkflowRouteRegistry } from '@discord-mcp/workflow-runtime'
import { Effect } from 'effect'
import { assertCommandPublishingGranted } from './interactions/command-policy.js'

interface WorkflowManifest {
  readonly triggers: ReadonlyArray<Record<string, unknown>>
}

interface WorkflowGrant {
  readonly routes: {
    readonly public: boolean
    readonly allowedHosts: ReadonlyArray<string>
    readonly allowedOrigins: ReadonlyArray<string>
    readonly allowedSourceCidrs: ReadonlyArray<string>
    readonly maxBodyBytes: number
  }
  readonly interactions: {
    readonly guildCommandPublishing: boolean
    readonly globalCommandPublishing: boolean
  }
  readonly discord: {
    readonly guildIds: ReadonlyArray<string>
  }
}

export interface WorkflowRegistrationServices {
  readonly database: Database
  readonly rest: DiscordRestClient
  readonly ensureApplicationId: () => Promise<string>
  readonly configuredGatewayIntents: number
  readonly developmentGuilds: ReadonlyArray<string>
}

export const registerWorkflowRevision = async (
  enabled: EnabledWorkflow,
  routes: WorkflowRouteRegistry | undefined,
  services: WorkflowRegistrationServices,
): Promise<void> => {
  if (!routes) return
  const manifest = JSON.parse(enabled.manifest_json) as WorkflowManifest
  const grant = JSON.parse(enabled.grants_json) as WorkflowGrant
  assertGatewayEventIntents(
    manifest.triggers.flatMap((trigger) =>
      trigger.type === 'gateway' && Array.isArray(trigger.eventTypes)
        ? trigger.eventTypes.filter((value): value is string => typeof value === 'string')
        : [],
    ),
    services.configuredGatewayIntents,
  )
  for (const trigger of manifest.triggers) {
    if (
      trigger.type !== 'http' ||
      typeof trigger.method !== 'string' ||
      typeof trigger.path !== 'string' ||
      typeof trigger.auth !== 'object' ||
      trigger.auth === null
    ) {
      continue
    }
    routes.register({
      workflowId: enabled.id,
      revision: enabled.revision,
      method: trigger.method,
      path: trigger.path,
      policy: {
        authentication: trigger.auth as Parameters<
          WorkflowRouteRegistry['register']
        >[0]['policy']['authentication'],
        allowedHosts: grant.routes.allowedHosts,
        allowedOrigins: grant.routes.allowedOrigins,
        allowedSourceCidrs: grant.routes.allowedSourceCidrs,
        maxBodyBytes: grant.routes.maxBodyBytes,
        ...(typeof trigger.requestSchema === 'object' && trigger.requestSchema !== null
          ? { requestSchema: trigger.requestSchema as Readonly<Record<string, unknown>> }
          : {}),
      },
      publicRouteGranted: grant.routes.public,
    })
  }

  const commandApplicationId = await services.ensureApplicationId()
  for (const trigger of manifest.triggers) {
    if (trigger.type !== 'interactionCommand' || typeof trigger.name !== 'string') continue
    const commandType =
      trigger.commandType === 'user' ? 2 : trigger.commandType === 'message' ? 3 : 1
    if (commandType === 1 && typeof trigger.description !== 'string') {
      throw new Error(`chat-input command ${trigger.name} requires a description`)
    }
    assertCommandPublishingGranted(trigger.global === true, grant.interactions, trigger.name)
    const targets =
      trigger.global === true
        ? [{ key: 'global', route: `/applications/${commandApplicationId}/commands` }]
        : [...new Set([...grant.discord.guildIds, ...services.developmentGuilds])].map(
            (guildId) => ({
              key: guildId,
              route: `/applications/${commandApplicationId}/guilds/${guildId}/commands`,
            }),
          )
    if (trigger.global !== true && targets.length === 0) {
      throw new Error(`guild command ${trigger.name} has no granted or development guild target`)
    }
    for (const target of targets) {
      const collision = services.database.get<{ workflow_id: string }>(
        `SELECT c.workflow_id FROM workflow_commands c
         JOIN workflows w ON w.id = c.workflow_id AND w.enabled_revision = c.revision
         WHERE c.command_key = ? AND c.command_type = ? AND c.guild_id = ?
         AND c.workflow_id != ? AND w.deleted_at IS NULL`,
        trigger.name,
        commandType,
        target.key,
        enabled.id,
      )
      if (collision) {
        throw new Error(
          `command ${trigger.name} type ${commandType} in ${target.key} is already owned by workflow ${collision.workflow_id}`,
        )
      }
      const existing = services.database.get<{ discord_command_id: string | null }>(
        `SELECT discord_command_id FROM workflow_commands
         WHERE workflow_id = ? AND revision = ? AND command_key = ?
         AND command_type = ? AND guild_id = ?`,
        enabled.id,
        enabled.revision,
        trigger.name,
        commandType,
        target.key,
      )
      if (existing?.discord_command_id) continue
      const command = await Effect.runPromise(
        services.rest.request<Record<string, unknown>>('POST', target.route, {
          body: {
            name: trigger.name,
            type: commandType,
            ...(commandType === 1 ? { description: trigger.description } : {}),
            ...(Array.isArray(trigger.options) ? { options: trigger.options } : {}),
            ...(Array.isArray(trigger.contexts) ? { contexts: trigger.contexts } : {}),
            ...(Array.isArray(trigger.integrationTypes)
              ? { integration_types: trigger.integrationTypes }
              : {}),
          },
        }),
      )
      services.database.run(
        `INSERT INTO workflow_commands
         (workflow_id, revision, command_key, command_type, discord_command_id, guild_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
        enabled.id,
        enabled.revision,
        trigger.name,
        commandType,
        String(command.id),
        target.key,
      )
    }
  }
}

export const unregisterWorkflowRevision = async (
  workflowId: string,
  revision: number,
  services: Pick<WorkflowRegistrationServices, 'database' | 'rest' | 'ensureApplicationId'>,
): Promise<void> => {
  const commands = services.database.all<{
    command_key: string
    discord_command_id: string | null
    guild_id: string | null
  }>(
    `SELECT command_key, discord_command_id, guild_id FROM workflow_commands
     WHERE workflow_id = ? AND revision = ?`,
    workflowId,
    revision,
  )
  const commandApplicationId = commands.some(
    ({ discord_command_id }) => discord_command_id !== null,
  )
    ? await services.ensureApplicationId()
    : undefined
  for (const command of commands) {
    if (!command.discord_command_id || !commandApplicationId) continue
    const route =
      command.guild_id === 'global' || command.guild_id === null
        ? `/applications/${commandApplicationId}/commands/${command.discord_command_id}`
        : `/applications/${commandApplicationId}/guilds/${command.guild_id}/commands/${command.discord_command_id}`
    await Effect.runPromise(services.rest.request('DELETE', route)).catch((cause: unknown) => {
      if (!(cause instanceof DiscordApiError) || cause.status !== 404) throw cause
    })
  }
  services.database.transaction(() => {
    services.database.run(
      'DELETE FROM workflow_commands WHERE workflow_id = ? AND revision = ?',
      workflowId,
      revision,
    )
    services.database.run(
      'DELETE FROM workflow_routes WHERE workflow_id = ? AND revision = ?',
      workflowId,
      revision,
    )
  })
}
