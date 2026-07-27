import type { Database } from '@discord-mcp/persistence'
import type { ComponentBinding, DiscordInteraction } from './handler.js'

export type InteractionTarget =
  | {
      readonly kind: 'workflow'
      readonly workflowId: string
      readonly triggerType:
        | 'interactionCommand'
        | 'interactionComponent'
        | 'interactionModal'
        | 'interactionAutocomplete'
      readonly triggerKey: string
    }
  | {
      readonly kind: 'event'
      readonly ownerType: 'principal' | 'workflow'
      readonly ownerId: string
      readonly actionKey: string
      readonly bindingHandle: string
    }

export const resolveInteractionTarget = (
  database: Database,
  interaction: DiscordInteraction,
  binding: ComponentBinding | undefined,
): InteractionTarget => {
  if (binding) {
    if (binding.actionType === 'event') {
      if (binding.ownerType !== 'principal' && binding.ownerType !== 'workflow') {
        throw new Error('component event binding has no valid inbox owner')
      }
      const handle = interaction.data?.custom_id
      if (!handle) throw new Error('component event binding has no opaque handle')
      return {
        kind: 'event',
        ownerType: binding.ownerType,
        ownerId: binding.ownerId,
        actionKey: binding.actionKey,
        bindingHandle: handle,
      }
    }
    if (binding.actionType !== 'workflow' || binding.ownerType !== 'workflow') {
      throw new Error('component workflow binding has no published workflow owner')
    }
    return {
      kind: 'workflow',
      workflowId: binding.ownerId,
      triggerType: interaction.type === 5 ? 'interactionModal' : 'interactionComponent',
      triggerKey: binding.actionKey,
    }
  }

  const commandId = interaction.data?.id
  if (typeof commandId !== 'string' || !/^\d{17,21}$/.test(commandId)) {
    throw new Error('application command interaction has no registered command id')
  }
  const command = database.get<{
    workflow_id: string
    command_key: string
  }>(
    `SELECT c.workflow_id, c.command_key
     FROM workflow_commands c
     JOIN workflows w ON w.id = c.workflow_id AND w.enabled_revision = c.revision
     WHERE c.discord_command_id = ?
       AND (c.guild_id = 'global' OR c.guild_id = ?)
       AND w.deleted_at IS NULL`,
    commandId,
    interaction.guild_id ?? '',
  )
  if (!command) throw new Error('interaction command is not owned by an enabled workflow revision')
  return {
    kind: 'workflow',
    workflowId: command.workflow_id,
    triggerType: interaction.type === 4 ? 'interactionAutocomplete' : 'interactionCommand',
    triggerKey: command.command_key,
  }
}

export const persistComponentEvent = (
  database: Database,
  interaction: DiscordInteraction,
  target: Extract<InteractionTarget, { readonly kind: 'event' }>,
  now = Date.now(),
): void => {
  database.run(
    `INSERT INTO component_events
     (owner_type, owner_id, binding_handle, action_key, interaction_id, payload_json,
      correlation_id, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    target.ownerType,
    target.ownerId,
    target.bindingHandle,
    target.actionKey,
    interaction.id,
    JSON.stringify(interaction),
    interaction.id,
    new Date(now).toISOString(),
  )
}
