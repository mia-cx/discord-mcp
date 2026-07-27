import { chmod, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import {
  type DiscordDispatcher,
  type DispatchFile,
  type DispatchInput,
  operationCatalog,
} from '@discord-mcp/discord-api'
import {
  encodeMessage,
  type MessagePresentation,
  type MessageTemplateDocument,
  renderTemplate,
} from '@discord-mcp/discord-presentations'
import { type Database, VersionedDocumentStore } from '@discord-mcp/persistence'
import type { CapabilityBroker, WorkflowGrant } from '@discord-mcp/workflow-runtime'
import { Effect } from 'effect'
import { enforceDispatchMentionPolicy } from './mention-policy.js'

interface RpcRequest {
  readonly id: number
  readonly credential: string
  readonly workflowId: string
  readonly revision: number
  readonly executionId: string
  readonly method: string
  readonly params: unknown
}

const asRecord = (value: unknown): Readonly<Record<string, unknown>> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('capability parameters must be an object')
  }
  return value as Readonly<Record<string, unknown>>
}

const redactLogValue = (value: unknown, key = ''): unknown => {
  if (/token|secret|authorization|credential|content|body|base64/i.test(key)) return '[redacted]'
  if (Array.isArray(value)) return value.map((item) => redactLogValue(item))
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, child]) => [childKey, redactLogValue(child, childKey)]),
    )
  }
  if (typeof value === 'string') {
    return value
      .replaceAll(/\b(?:Bot|Bearer)\s+[A-Za-z0-9._~+/-]{12,}/gi, '[redacted]')
      .replaceAll(/\bdcmcp_[A-Za-z0-9_-]+/g, '[redacted]')
  }
  return value
}

export class CapabilityRpcServer {
  readonly dispatcher: DiscordDispatcher

  constructor(
    readonly database: Database,
    readonly broker: CapabilityBroker,
    dispatcher: DiscordDispatcher,
    readonly maximumLogBytes = 64 * 1024,
  ) {
    this.dispatcher = dispatcher
  }

  async handle(request: RpcRequest): Promise<unknown> {
    if (
      typeof request.credential !== 'string' ||
      typeof request.workflowId !== 'string' ||
      !Number.isInteger(request.revision) ||
      typeof request.executionId !== 'string'
    ) {
      throw new Error('invalid workflow capability identity')
    }
    this.#execution(request)
    const params = asRecord(request.params)
    switch (request.method) {
      case 'discord.request':
        return this.#discord(request, params)
      case 'discord.sendMessage':
        return this.#sendMessage(request, params)
      case 'discord.respondToInteraction':
        return this.#discord(request, {
          operationId: 'create_interaction_response',
          input: params,
        })
      case 'kv.get':
        return this.#kvGet(request, params)
      case 'kv.set':
        return this.#kvSet(request, params)
      case 'kv.delete':
        return this.#kvDelete(request, params)
      case 'http.fetch':
        return this.#http(request, params)
      case 'log.info':
      case 'log.error':
        return this.#log(request, request.method === 'log.error' ? 'error' : 'info', params)
      default:
        throw new Error(`unsupported capability method: ${request.method}`)
    }
  }

  async #discord(request: RpcRequest, params: Readonly<Record<string, unknown>>): Promise<unknown> {
    const operationId = params.operationId
    if (typeof operationId !== 'string') throw new Error('operationId is required')
    const input = asRecord(params.input)
    const operation = operationCatalog.describe(operationId)
    const owner = this.database.get<{ owner_principal_id: string }>(
      'SELECT owner_principal_id FROM workflows WHERE id = ?',
      request.workflowId,
    )
    if (!owner) throw new Error('workflow owner is unavailable')
    let dispatch: DispatchInput = {
      operationId,
      ...(typeof input.authProfile === 'string' ? { authProfile: input.authProfile } : {}),
      ...(typeof input.authMode === 'string'
        ? {
            authMode: input.authMode as 'bot' | 'oauth2' | 'webhook' | 'interaction',
          }
        : {}),
      ...(isStringRecord(input.path) ? { path: input.path } : {}),
      ...(isRecord(input.query) ? { query: input.query } : {}),
      ...(input.body === undefined ? {} : { body: input.body }),
      ...(typeof input.auditLogReason === 'string' ? { auditLogReason: input.auditLogReason } : {}),
      ...(Array.isArray(input.files)
        ? {
            files: input.files as ReadonlyArray<{
              readonly blobId: string
              readonly filename?: string
              readonly contentType?: string
            }>,
          }
        : {}),
    }
    const execution = this.#execution(request)
    const grant = this.broker.authorize({
      workflowId: request.workflowId,
      revision: request.revision,
      credential: request.credential,
      executionId: request.executionId,
      operationId,
      ...targets(dispatch),
      causalDepth: execution.causal_depth,
    })
    dispatch = enforceDispatchMentionPolicy(dispatch, grant.discord.broadMentions)
    const guarded = operation.risk === 'destructive' || operation.risk === 'bot_admin'
    let executable = dispatch
    if (guarded) {
      const previewToken = this.dispatcher.preview(owner.owner_principal_id, dispatch).previewToken
      if (!previewToken) throw new Error('guarded operation did not produce a preview token')
      executable = { ...dispatch, previewToken }
    }
    const result = await Effect.runPromise(
      this.dispatcher.dispatch(owner.owner_principal_id, operation.risk, executable),
    )
    if (operation.risk !== 'read') {
      this.#recordActionCausality(request, execution, result, dispatch)
    }
    return result
  }

  async #sendMessage(
    request: RpcRequest,
    params: Readonly<Record<string, unknown>>,
  ): Promise<unknown> {
    const channelId = params.channelId
    if (typeof channelId !== 'string' || !/^\d{17,21}$/.test(channelId)) {
      throw new Error('channelId must be a Discord snowflake')
    }
    const presentation = params.presentation as MessagePresentation
    const owner = this.database.get<{ owner_principal_id: string }>(
      'SELECT owner_principal_id FROM workflows WHERE id = ?',
      request.workflowId,
    )
    if (!owner) throw new Error('workflow owner is unavailable')
    const resolved =
      presentation.type === 'template'
        ? renderTemplate(
            new VersionedDocumentStore(this.database, 'message-template').getPublished(
              presentation.templateId,
              presentation.revision,
              owner.owner_principal_id,
            ).document as MessageTemplateDocument,
            presentation.variables,
          ).presentation
        : presentation
    const encoded = encodeMessage(resolved, `workflow:${request.workflowId}`)
    const grant = this.broker.authenticate({
      workflowId: request.workflowId,
      revision: request.revision,
      credential: request.credential,
      executionId: request.executionId,
      causalDepth: this.#execution(request).causal_depth,
    })
    if ((resolved.allowedMentions?.parse?.length ?? 0) > 0 && !grant.discord.broadMentions) {
      throw new Error('broad mentions require the workflow broadMentions grant')
    }
    const files: ReadonlyArray<DispatchFile> = (resolved.attachments ?? []).map((attachment) =>
      attachment.source === 'inline'
        ? {
            data: Buffer.from(attachment.data, 'base64'),
            filename: attachment.filename,
            ...(attachment.mimeType === undefined ? {} : { contentType: attachment.mimeType }),
          }
        : { blobId: attachment.blobId, filename: attachment.filename },
    )
    const result = await this.#discord(request, {
      operationId: 'create_message',
      input: {
        path: { channel_id: channelId },
        body: encoded.payload,
        ...(files.length === 0 ? {} : { files }),
      },
    })
    for (const binding of encoded.report.interactiveBindings) {
      this.database.run(
        `INSERT INTO component_bindings
         (handle, owner_type, owner_id, owner_revision, action_type, action_key, created_at)
         VALUES (?, 'workflow', ?, ?, ?, ?, ?)
         ON CONFLICT(handle) DO UPDATE SET owner_id = excluded.owner_id,
         owner_revision = excluded.owner_revision, action_type = excluded.action_type,
         action_key = excluded.action_key`,
        binding.customId,
        request.workflowId,
        request.revision,
        binding.action.type,
        binding.action.key,
        new Date().toISOString(),
      )
    }
    return result
  }

  #kvGet(request: RpcRequest, params: Readonly<Record<string, unknown>>): unknown {
    this.#assertKey(params.key)
    this.#assertEnabled(request)
    const row = this.database.get<{ value_json: string }>(
      'SELECT value_json FROM workflow_kv WHERE workflow_id = ? AND key = ?',
      request.workflowId,
      params.key as string,
    )
    return row ? JSON.parse(row.value_json) : undefined
  }

  #kvSet(request: RpcRequest, params: Readonly<Record<string, unknown>>): void {
    this.#assertKey(params.key)
    this.#assertEnabled(request)
    const value = JSON.stringify(params.value)
    if (Buffer.byteLength(value) > 64 * 1024) throw new Error('workflow KV value exceeds 64 KiB')
    this.database.run(
      `INSERT INTO workflow_kv(workflow_id, key, value_json, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(workflow_id, key) DO UPDATE SET value_json = excluded.value_json,
       updated_at = excluded.updated_at`,
      request.workflowId,
      params.key as string,
      value,
      new Date().toISOString(),
    )
  }

  #kvDelete(request: RpcRequest, params: Readonly<Record<string, unknown>>): void {
    this.#assertKey(params.key)
    this.#assertEnabled(request)
    this.database.run(
      'DELETE FROM workflow_kv WHERE workflow_id = ? AND key = ?',
      request.workflowId,
      params.key as string,
    )
  }

  async #http(request: RpcRequest, params: Readonly<Record<string, unknown>>): Promise<unknown> {
    this.#assertEnabled(request)
    const grantRow = this.database.get<{ grants_json: string }>(
      'SELECT grants_json FROM workflow_grants WHERE workflow_id = ? AND revision = ?',
      request.workflowId,
      request.revision,
    )
    if (!grantRow) throw new Error('workflow has no approved grant')
    const grant = JSON.parse(grantRow.grants_json) as WorkflowGrant
    if (typeof params.url !== 'string') throw new Error('HTTP URL is required')
    const url = new URL(params.url)
    if (url.protocol !== 'https:' || !grant.network.allowedOutboundHosts.includes(url.hostname)) {
      throw new Error(`outbound host ${url.hostname} is not granted`)
    }
    const init = isRecord(params.init) ? params.init : {}
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), grant.runtime.timeoutSeconds * 1_000)
    try {
      const response = await fetch(url, {
        method: typeof init.method === 'string' ? init.method : 'GET',
        ...(isStringRecord(init.headers) ? { headers: init.headers } : {}),
        ...(typeof init.body === 'string' ? { body: init.body } : {}),
        redirect: 'error',
        signal: controller.signal,
      })
      const body = new Uint8Array(await response.arrayBuffer())
      if (body.byteLength > 1024 * 1024) throw new Error('brokered HTTP response exceeds 1 MiB')
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body: Buffer.from(body).toString('base64'),
      }
    } finally {
      clearTimeout(timeout)
    }
  }

  #log(
    request: RpcRequest,
    level: 'info' | 'error',
    params: Readonly<Record<string, unknown>>,
  ): void {
    this.#assertEnabled(request)
    const message = typeof params.message === 'string' ? params.message : ''
    const line = `${JSON.stringify({
      level,
      message: redactLogValue(message),
      fields: redactLogValue(params.fields),
    })}\n`
    const row = this.database.get<{ id: string; logs: string }>(
      `SELECT id, logs FROM workflow_executions WHERE id = ? AND workflow_id = ?
       AND revision = ? AND status = 'running'`,
      request.executionId,
      request.workflowId,
      request.revision,
    )
    if (!row) return
    const combined = Buffer.from(`${row.logs}${line}`)
    let start = Math.max(0, combined.byteLength - this.maximumLogBytes)
    while (start < combined.byteLength && (combined[start] ?? 0) >> 6 === 2) start += 1
    const logs = combined.subarray(start).toString('utf8')
    this.database.run('UPDATE workflow_executions SET logs = ? WHERE id = ?', logs, row.id)
  }

  #assertEnabled(request: RpcRequest): void {
    this.broker.authenticate({
      workflowId: request.workflowId,
      revision: request.revision,
      credential: request.credential,
      executionId: request.executionId,
      causalDepth: this.#execution(request).causal_depth,
    })
  }

  #execution(request: RpcRequest): {
    readonly causal_depth: number
    readonly correlation_id: string
  } {
    const execution = this.database.get<{ causal_depth: number; correlation_id: string }>(
      `SELECT causal_depth, correlation_id FROM workflow_executions
       WHERE id = ? AND workflow_id = ? AND revision = ? AND status = 'running'`,
      request.executionId,
      request.workflowId,
      request.revision,
    )
    if (!execution) throw new Error('capability call is not bound to a running workflow execution')
    return execution
  }

  #recordActionCausality(
    request: RpcRequest,
    execution: { readonly causal_depth: number; readonly correlation_id: string },
    result: unknown,
    input: DispatchInput,
  ): void {
    const resultIds =
      isRecord(result) && typeof result.id === 'string' && /^\d{17,21}$/.test(result.id)
        ? [result.id]
        : []
    const pathIds = Object.entries(input.path ?? {})
      .filter(
        ([key, value]) =>
          [
            'message_id',
            'role_id',
            'emoji_id',
            'sticker_id',
            'guild_scheduled_event_id',
            'command_id',
            'thread_id',
          ].includes(key) && /^\d{17,21}$/.test(value),
      )
      .map(([, value]) => value)
    for (const entityId of new Set([...resultIds, ...pathIds])) {
      this.database.run(
        `INSERT INTO workflow_action_causality
         (discord_entity_id, execution_id, workflow_id, correlation_id, causal_depth, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(discord_entity_id) DO UPDATE SET
         execution_id = excluded.execution_id, workflow_id = excluded.workflow_id,
         correlation_id = excluded.correlation_id, causal_depth = excluded.causal_depth,
         created_at = excluded.created_at`,
        entityId,
        request.executionId,
        request.workflowId,
        execution.correlation_id,
        execution.causal_depth + 1,
        new Date().toISOString(),
      )
    }
  }

  #assertKey(key: unknown): asserts key is string {
    if (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(key)) {
      throw new Error('workflow KV key is invalid')
    }
  }
}

export const startCapabilitySocket = async (path: string, service: CapabilityRpcServer) => {
  await rm(path, { force: true })
  const server = createServer((socket) => {
    let buffer = ''
    let handled = false
    socket.setEncoding('utf8')
    socket.on('data', (chunk) => {
      if (handled) return
      buffer += chunk
      if (Buffer.byteLength(buffer) > 1024 * 1024) {
        handled = true
        socket.end(`${JSON.stringify({ ok: false, error: 'capability request exceeds 1 MiB' })}\n`)
        return
      }
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      handled = true
      let request: RpcRequest
      try {
        request = JSON.parse(buffer.slice(0, newline)) as RpcRequest
      } catch {
        socket.end(`${JSON.stringify({ ok: false, error: 'invalid JSON request' })}\n`)
        return
      }
      void service.handle(request).then(
        (result) => socket.end(`${JSON.stringify({ id: request.id, ok: true, result })}\n`),
        (cause: unknown) => {
          const error =
            typeof cause === 'object' &&
            cause !== null &&
            '_tag' in cause &&
            typeof cause._tag === 'string' &&
            'message' in cause &&
            typeof cause.message === 'string'
              ? {
                  tag: cause._tag,
                  message: cause.message,
                  ...('retryable' in cause && typeof cause.retryable === 'boolean'
                    ? { retryable: cause.retryable }
                    : {}),
                }
              : {
                  tag: cause instanceof Error ? cause.name : 'Error',
                  message: cause instanceof Error ? cause.message : String(cause),
                }
          socket.end(
            `${JSON.stringify({
              id: request.id,
              ok: false,
              error,
            })}\n`,
          )
        },
      )
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(path, resolve)
  })
  await chmod(path, 0o600)
  return server
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isStringRecord = (value: unknown): value is Readonly<Record<string, string>> =>
  isRecord(value) && Object.values(value).every((item) => typeof item === 'string')

const targets = (
  input: DispatchInput,
): {
  readonly guildId?: string
  readonly channelId?: string
  readonly oauthProfileId?: string
} => ({
  ...(input.path?.guild_id === undefined ? {} : { guildId: input.path.guild_id }),
  ...(input.path?.channel_id === undefined ? {} : { channelId: input.path.channel_id }),
  ...(input.authProfile === undefined || input.authProfile === 'bot'
    ? {}
    : { oauthProfileId: input.authProfile }),
})
