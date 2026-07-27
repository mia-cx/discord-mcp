import { type Principal, requireScopes, type TokenEncryption } from '@discord-mcp/auth'
import { McpInput } from '@discord-mcp/core'
import type { DiscordRestClient } from '@discord-mcp/discord-api'
import {
  encodeMessage,
  encodeModal,
  encodeV2Upgrade,
  type MessagePresentation,
  MessagePresentationSchema,
  type ModalPresentation,
  ModalPresentationSchema,
  renderTemplate,
} from '@discord-mcp/discord-presentations'
import { type BlobStore, type Database, VersionedDocumentStore } from '@discord-mcp/persistence'
import type { CallToolResult, McpServer } from '@modelcontextprotocol/server'
import { type Effect, Schema } from 'effect'

interface McpRequest {
  readonly id?: unknown
  readonly _meta?: { readonly progressToken?: string | number | undefined } | undefined
  readonly notify?: ((message: never) => Promise<unknown>) | undefined
}

interface PresentationToolDependencies {
  readonly server: McpServer
  readonly rest: DiscordRestClient
  readonly principal: Principal
  readonly database?: Database
  readonly blobs?: BlobStore
  readonly secretEncryption?: TokenEncryption
  readonly attempt: (run: () => unknown | Promise<unknown>) => Promise<CallToolResult>
  readonly runEffect: <A, E>(
    program: Effect.Effect<A, E, never>,
    signal: AbortSignal,
    request?: McpRequest,
  ) => Promise<A>
}

const assertPrincipalOwnedBindings = (
  bindings: ReadonlyArray<{
    readonly action: { readonly type: 'workflow' | 'event'; readonly key: string }
  }>,
): void => {
  if (bindings.some(({ action }) => action.type === 'workflow')) {
    throw new Error(
      'MCP-authored messages can bind only event-inbox actions; workflow actions must be emitted by a published workflow revision',
    )
  }
}

export const registerPresentationTools = ({
  server,
  rest,
  principal,
  database,
  blobs,
  secretEncryption,
  attempt,
  runEffect,
}: PresentationToolDependencies): void => {
  const resolvePresentation = (
    presentation: MessagePresentation,
  ): Exclude<MessagePresentation, { type: 'template' }> => {
    if (presentation.type !== 'template') return presentation
    if (!database) throw new Error('template persistence is unavailable')
    const document = new VersionedDocumentStore(database, 'message-template').getPublished(
      presentation.templateId,
      presentation.revision,
      principal.id,
    ).document
    return renderTemplate(document as Parameters<typeof renderTemplate>[0], presentation.variables)
      .presentation
  }
  const resolveMessageFiles = async (
    presentation: Exclude<MessagePresentation, { type: 'template' }>,
  ) =>
    Promise.all(
      (presentation.attachments ?? []).map(async (attachment) => {
        if (attachment.source === 'inline') {
          return {
            data: Buffer.from(attachment.data, 'base64'),
            name: attachment.filename,
            ...(attachment.mimeType === undefined ? {} : { contentType: attachment.mimeType }),
          }
        }
        if (!blobs) throw new Error('blob persistence is unavailable')
        blobs.getMetadata(attachment.blobId, principal.id)
        return {
          data: await blobs.readForDiscord(attachment.blobId),
          name: attachment.filename,
        }
      }),
    )
  const authorizeBroadMentions = (
    presentation: Exclude<MessagePresentation, { type: 'template' }>,
  ): void => {
    if ((presentation.allowedMentions?.parse?.length ?? 0) > 0) {
      requireScopes(principal, ['mentions:broad'])
    }
  }

  const MessageInput = Schema.Struct({
    presentation: MessagePresentationSchema,
    namespace: Schema.optionalKey(Schema.String),
  })
  server.registerTool(
    'discord_message_validate',
    {
      description:
        'Validate and encode a legacy or Components V2 presentation locally, with an ASCII preview.',
      inputSchema: McpInput(MessageInput),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ presentation, namespace }) =>
      attempt(() => {
        requireScopes(principal, ['mcp:read'])
        return encodeMessage(resolvePresentation(presentation as MessagePresentation), namespace)
      }),
  )

  const SendInput = Schema.Struct({
    channelId: Schema.String,
    presentation: MessagePresentationSchema,
  })
  server.registerTool(
    'discord_message_send',
    {
      description: 'Validate and send a safe message to a Discord channel.',
      inputSchema: McpInput(SendInput),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ channelId, presentation }, context) =>
      attempt(async () => {
        requireScopes(principal, ['mcp:write'])
        if (!/^\d{17,21}$/.test(channelId)) throw new Error('channelId must be a Discord snowflake')
        const resolved = resolvePresentation(presentation as MessagePresentation)
        authorizeBroadMentions(resolved)
        const encoded = encodeMessage(resolved, `principal:${principal.id}:channel:${channelId}`)
        assertPrincipalOwnedBindings(encoded.report.interactiveBindings)
        const files = await resolveMessageFiles(resolved)
        const result = await runEffect(
          rest.request('POST', `/channels/${channelId}/messages`, {
            body: encoded.payload,
            ...(files.length === 0 ? {} : { files }),
          }),
          context.mcpReq.signal,
          context.mcpReq,
        )
        if (database && typeof result === 'object' && result !== null) {
          const messageId = (result as { readonly id?: unknown }).id
          if (typeof messageId === 'string') {
            for (const binding of encoded.report.interactiveBindings) {
              database.run(
                `INSERT INTO component_bindings
                 (handle, owner_type, owner_id, action_type, action_key, created_at)
                 VALUES (?, 'principal', ?, ?, ?, ?)
                 ON CONFLICT(handle) DO UPDATE SET owner_type = excluded.owner_type,
                 owner_id = excluded.owner_id, owner_revision = NULL,
                 action_type = excluded.action_type, action_key = excluded.action_key`,
                binding.customId,
                principal.id,
                binding.action.type,
                binding.action.key,
                new Date().toISOString(),
              )
            }
          }
        }
        return result
      }),
  )

  const MessageEditInput = Schema.Struct({
    channelId: Schema.String,
    messageId: Schema.String,
    presentation: MessagePresentationSchema,
  })
  server.registerTool(
    'discord_message_edit',
    {
      description:
        'Edit a message through the presentation pipeline, enforcing irreversible V2 upgrades.',
      inputSchema: McpInput(MessageEditInput),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ channelId, messageId, presentation }, context) =>
      attempt(async () => {
        requireScopes(principal, ['mcp:write'])
        if (!/^\d{17,21}$/.test(channelId) || !/^\d{17,21}$/.test(messageId)) {
          throw new Error('channelId and messageId must be Discord snowflakes')
        }
        const existing = await runEffect(
          rest.request<Record<string, unknown>>(
            'GET',
            `/channels/${channelId}/messages/${messageId}`,
          ),
          context.mcpReq.signal,
          context.mcpReq,
        )
        const resolved = resolvePresentation(presentation as MessagePresentation)
        authorizeBroadMentions(resolved)
        const alreadyV2 = (Number(existing.flags ?? 0) & 32_768) !== 0
        if (alreadyV2 && resolved.type === 'legacy') {
          throw new Error('a Components V2 message cannot be edited back to legacy')
        }
        const encoded =
          resolved.type === 'components_v2' && !alreadyV2
            ? encodeV2Upgrade(resolved, `principal:${principal.id}:message:${messageId}`)
            : encodeMessage(resolved, `principal:${principal.id}:message:${messageId}`)
        assertPrincipalOwnedBindings(encoded.report.interactiveBindings)
        const files = await resolveMessageFiles(resolved)
        const result = await runEffect(
          rest.request('PATCH', `/channels/${channelId}/messages/${messageId}`, {
            body: encoded.payload,
            ...(files.length === 0 ? {} : { files }),
          }),
          context.mcpReq.signal,
          context.mcpReq,
        )
        if (database) {
          for (const binding of encoded.report.interactiveBindings) {
            database.run(
              `INSERT INTO component_bindings
               (handle, owner_type, owner_id, action_type, action_key, created_at)
               VALUES (?, 'principal', ?, ?, ?, ?)
               ON CONFLICT(handle) DO UPDATE SET owner_type = excluded.owner_type,
               owner_id = excluded.owner_id, owner_revision = NULL,
               action_type = excluded.action_type, action_key = excluded.action_key`,
              binding.customId,
              principal.id,
              binding.action.type,
              binding.action.key,
              new Date().toISOString(),
            )
          }
        }
        return result
      }),
  )

  const WebhookExecuteInput = Schema.Struct({
    webhookId: Schema.String,
    secretRef: Schema.String,
    presentation: MessagePresentationSchema,
    applicationOwned: Schema.optionalKey(Schema.Boolean),
  })
  server.registerTool(
    'discord_webhook_execute',
    {
      description:
        'Execute a webhook using an encrypted token reference and the shared presentation pipeline.',
      inputSchema: McpInput(WebhookExecuteInput),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ webhookId, secretRef, presentation, applicationOwned }, context) =>
      attempt(async () => {
        requireScopes(principal, ['mcp:write'])
        if (!/^\d{17,21}$/.test(webhookId)) {
          throw new Error('webhookId must be a Discord snowflake')
        }
        if (!database || !secretEncryption) {
          throw new Error('encrypted webhook secrets are unavailable')
        }
        const secret = database.get<{ id: string; ciphertext: Uint8Array }>(
          `SELECT id, ciphertext FROM encrypted_secrets
           WHERE owner_principal_id = ? AND name = ?`,
          principal.id,
          secretRef,
        )
        if (!secret) throw new Error(`webhook secret ${secretRef} does not exist`)
        const token = secretEncryption.decrypt(secret.ciphertext, `secret:${secret.id}`)
        const resolved = resolvePresentation(presentation as MessagePresentation)
        authorizeBroadMentions(resolved)
        const encoded = encodeMessage(resolved, `principal:${principal.id}:webhook:${webhookId}`)
        assertPrincipalOwnedBindings(encoded.report.interactiveBindings)
        if (!applicationOwned && encoded.report.interactiveBindings.length > 0) {
          throw new Error('non-application-owned webhooks cannot send interactive components')
        }
        const files = await resolveMessageFiles(resolved)
        const result = await runEffect(
          rest.request('POST', `/webhooks/${webhookId}/${token}`, {
            query: new URLSearchParams({
              wait: 'true',
              ...(resolved.type === 'components_v2' ? { with_components: 'true' } : {}),
            }),
            body: encoded.payload,
            ...(files.length === 0 ? {} : { files }),
            auth: false,
          }),
          context.mcpReq.signal,
          context.mcpReq,
        )
        for (const binding of encoded.report.interactiveBindings) {
          database.run(
            `INSERT INTO component_bindings
             (handle, owner_type, owner_id, action_type, action_key, created_at)
             VALUES (?, 'principal', ?, ?, ?, ?)
             ON CONFLICT(handle) DO UPDATE SET owner_type = excluded.owner_type,
             owner_id = excluded.owner_id, owner_revision = NULL,
             action_type = excluded.action_type, action_key = excluded.action_key`,
            binding.customId,
            principal.id,
            binding.action.type,
            binding.action.key,
            new Date().toISOString(),
          )
        }
        return result
      }),
  )

  const ModalInput = Schema.Struct({ modal: ModalPresentationSchema })
  server.registerTool(
    'discord_modal_validate',
    {
      description: 'Validate a modal presentation locally without attempting to open it.',
      inputSchema: McpInput(ModalInput),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ modal }) =>
      attempt(() => {
        requireScopes(principal, ['mcp:read'])
        return encodeModal(modal as ModalPresentation)
      }),
  )
}
