import { timingSafeEqual } from 'node:crypto'
import { operationCatalog } from '@discord-mcp/discord-api'
import type { Database } from '@discord-mcp/persistence'
import { Schema } from 'effect'
import type { WorkflowGrant } from './types.js'

export interface CapabilityRequest {
  readonly workflowId: string
  readonly revision: number
  readonly credential: string
  readonly executionId?: string
  readonly operationId: string
  readonly guildId?: string
  readonly channelId?: string
  readonly oauthProfileId?: string
  readonly causalDepth: number
}

export class WorkflowGrantError extends Schema.TaggedErrorClass<WorkflowGrantError>()(
  'WorkflowGrantError',
  { message: Schema.String },
) {
  constructor(message: string) {
    super({ message })
  }
}

export class CapabilityBroker {
  readonly #credentials = new Map<string, string>()
  readonly #actions = new Map<string, Array<number>>()

  constructor(readonly database: Database) {}

  register(workflowId: string, revision: number, credential: string): void {
    this.#credentials.set(`${workflowId}:${revision}`, credential)
  }

  authenticate(
    request: Pick<
      CapabilityRequest,
      'workflowId' | 'revision' | 'credential' | 'executionId' | 'causalDepth'
    >,
  ): WorkflowGrant {
    const expectedCredential = this.#credentials.get(`${request.workflowId}:${request.revision}`)
    if (expectedCredential === undefined || !safeEqual(expectedCredential, request.credential)) {
      throw new WorkflowGrantError('invalid revision capability credential')
    }
    const workflow = this.database.get<{ enabled_revision: number | null }>(
      'SELECT enabled_revision FROM workflows WHERE id = ? AND deleted_at IS NULL',
      request.workflowId,
    )
    if (workflow?.enabled_revision !== request.revision) {
      const drainingExecution =
        request.executionId === undefined
          ? undefined
          : this.database.get(
              `SELECT id FROM workflow_executions
               WHERE id = ? AND workflow_id = ? AND revision = ? AND status = 'running'`,
              request.executionId,
              request.workflowId,
              request.revision,
            )
      if (!drainingExecution) throw new WorkflowGrantError('workflow revision is not enabled')
    }
    if (request.causalDepth > 5)
      throw new WorkflowGrantError('maximum causal workflow depth exceeded')
    const row = this.database.get<{ grants_json: string }>(
      'SELECT grants_json FROM workflow_grants WHERE workflow_id = ? AND revision = ?',
      request.workflowId,
      request.revision,
    )
    if (!row) throw new WorkflowGrantError('workflow has no approved grant')
    return JSON.parse(row.grants_json) as WorkflowGrant
  }

  authorize(request: CapabilityRequest, now = Date.now()): WorkflowGrant {
    const grant = this.authenticate(request)
    const operation = operationCatalog.describe(request.operationId)
    if (operation.risk === 'credential') {
      throw new WorkflowGrantError('credential operations are never available to workflows')
    }
    if (
      !grant.discord.operationIds.includes(operation.operationId) &&
      !grant.discord.operationFamilies.includes(operation.family)
    ) {
      throw new WorkflowGrantError(`operation ${operation.operationId} is not granted`)
    }
    if (operation.risk === 'bot_admin' && !grant.discord.botAdmin) {
      throw new WorkflowGrantError('bot-administration access is not granted')
    }
    const requiresGuild = operation.parameters.some(
      (parameter) => parameter.in === 'path' && parameter.required && parameter.name === 'guild_id',
    )
    const requiresChannel = operation.parameters.some(
      (parameter) =>
        parameter.in === 'path' && parameter.required && parameter.name === 'channel_id',
    )
    if (requiresGuild && request.guildId === undefined) {
      throw new WorkflowGrantError('Discord operation target guild was not supplied to the broker')
    }
    if (requiresChannel && request.channelId === undefined) {
      throw new WorkflowGrantError(
        'Discord operation target channel was not supplied to the broker',
      )
    }
    if (request.guildId !== undefined && !grant.discord.guildIds.includes(request.guildId)) {
      throw new WorkflowGrantError(`guild ${request.guildId} is not granted`)
    }
    if (request.channelId !== undefined && !grant.discord.channelIds.includes(request.channelId)) {
      throw new WorkflowGrantError(`channel ${request.channelId} is not granted`)
    }
    if (
      request.oauthProfileId !== undefined &&
      !grant.discord.oauthProfileIds.includes(request.oauthProfileId)
    ) {
      throw new WorkflowGrantError(`OAuth profile ${request.oauthProfileId} is not granted`)
    }
    const key = `${request.workflowId}:${request.revision}`
    const recent = (this.#actions.get(key) ?? []).filter((timestamp) => timestamp > now - 60_000)
    if (recent.length >= grant.discord.maxActionsPerMinute) {
      throw new WorkflowGrantError('workflow action budget exceeded')
    }
    recent.push(now)
    this.#actions.set(key, recent)
    return grant
  }
}

const safeEqual = (left: string, right: string): boolean => {
  const leftBytes = Buffer.from(left)
  const rightBytes = Buffer.from(right)
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}
