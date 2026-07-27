import {
  encodeMessage,
  encodeModal,
  type MessagePresentation,
  type ModalPresentation,
} from '@discord-mcp/discord-presentations'
import type { Database } from '@discord-mcp/persistence'
import type { InteractionCallback } from './handler.js'

interface WorkflowResponseOwner {
  readonly database: Database
  readonly workflowId: string
  readonly revision: number
}

export const workflowInteractionCallback = (
  value: unknown,
  owner?: WorkflowResponseOwner,
): InteractionCallback => {
  if (typeof value !== 'object' || value === null) {
    throw new Error('interaction workflow returned no response')
  }
  const response = value as {
    readonly __interactionResponse?: unknown
    readonly __autocompleteResponse?: unknown
  }
  if (response.__autocompleteResponse !== undefined) {
    return {
      type: 8,
      data: { choices: validateAutocompleteChoices(response.__autocompleteResponse) },
    }
  }
  if (
    typeof response.__interactionResponse !== 'object' ||
    response.__interactionResponse === null
  ) {
    throw new Error(
      'interaction workflow must return Discord.respondToInteraction(...) or Discord.respondToAutocomplete(...)',
    )
  }
  const input = response.__interactionResponse as {
    readonly presentation?: MessagePresentation
    readonly modal?: ModalPresentation
    readonly ephemeral?: boolean
  }
  if (input.modal) {
    const encoded = encodeModal(input.modal, `workflow:${owner?.workflowId ?? 'modal'}`)
    persistInteractionBindings(owner, encoded.report.interactiveBindings)
    return { type: 9, data: encoded.payload }
  }
  if (!input.presentation || input.presentation.type === 'template') {
    throw new Error('interaction response requires a concrete presentation')
  }
  const encoded = encodeMessage(
    input.presentation,
    `workflow:${owner?.workflowId ?? 'interaction'}`,
  )
  persistInteractionBindings(owner, encoded.report.interactiveBindings)
  const flags = typeof encoded.payload.flags === 'number' ? encoded.payload.flags : 0
  return {
    type: 4,
    data: {
      ...encoded.payload,
      ...(input.ephemeral ? { flags: flags | 64 } : {}),
    },
  }
}

const validateAutocompleteChoices = (
  value: unknown,
): ReadonlyArray<{ readonly name: string; readonly value: string | number }> => {
  if (!Array.isArray(value) || value.length > 25) {
    throw new Error('autocomplete response must contain at most 25 choices')
  }
  return value.map((choice, index) => {
    if (typeof choice !== 'object' || choice === null || Array.isArray(choice)) {
      throw new Error(`autocomplete choice ${index} must be an object`)
    }
    const record = choice as Readonly<Record<string, unknown>>
    if (typeof record.name !== 'string' || record.name.length < 1 || record.name.length > 100) {
      throw new Error(`autocomplete choice ${index} name must contain 1–100 characters`)
    }
    if (
      !(
        (typeof record.value === 'string' &&
          record.value.length >= 1 &&
          record.value.length <= 100) ||
        (typeof record.value === 'number' && Number.isFinite(record.value))
      )
    ) {
      throw new Error(`autocomplete choice ${index} value is invalid`)
    }
    return { name: record.name, value: record.value }
  })
}

const persistInteractionBindings = (
  owner: WorkflowResponseOwner | undefined,
  bindings: ReadonlyArray<{
    readonly customId: string
    readonly action: { readonly type: 'workflow' | 'event'; readonly key: string }
  }>,
): void => {
  if (!owner) return
  for (const binding of bindings) {
    owner.database.run(
      `INSERT INTO component_bindings
       (handle, owner_type, owner_id, owner_revision, action_type, action_key, created_at)
       VALUES (?, 'workflow', ?, ?, ?, ?, ?)
       ON CONFLICT(handle) DO UPDATE SET owner_type = excluded.owner_type,
       owner_id = excluded.owner_id, owner_revision = excluded.owner_revision,
       action_type = excluded.action_type, action_key = excluded.action_key`,
      binding.customId,
      owner.workflowId,
      owner.revision,
      binding.action.type,
      binding.action.key,
      new Date().toISOString(),
    )
  }
}
