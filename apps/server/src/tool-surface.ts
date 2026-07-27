import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import {
  type DiscordOAuthProfiles,
  localAdministrator,
  type Principal,
  requireScopes,
  type Scope,
  type TokenEncryption,
} from '@discord-mcp/auth'
import {
  DiscordToolResultSchema,
  JsonValueSchema,
  McpInput,
  McpRequestContext,
  type McpStandardSchema,
  makeToolRegistry,
  type RegisteredToolMetadata,
  ToolRegistry,
} from '@discord-mcp/core'
import {
  actionableDiscordMessage,
  createGuildGetTool,
  DiscordDispatcher,
  DiscordRestClient,
  discordJsTransport,
  isDiscordFailure,
  type OperationRisk,
  operationCatalog,
} from '@discord-mcp/discord-api'
import {
  BlueprintApplier,
  type BlueprintBindings,
  BlueprintBindingsSchema,
  digest,
  explainPermissions,
  type GuildSnapshot,
  GuildSnapshotSchema,
  PreviewTokens,
  planBlueprint,
  type ServerBlueprint,
  ServerBlueprintSchema,
} from '@discord-mcp/discord-blueprints'
import type { GatewayEventStore, GatewayLifecycle } from '@discord-mcp/discord-gateway'
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
import type { WorkflowRuntimeManager, WorkflowStore } from '@discord-mcp/workflow-runtime'
import { type CallToolResult, McpServer } from '@modelcontextprotocol/server'
import { Cause, Effect, Exit, Layer, ManagedRuntime, Schema } from 'effect'
import { BlueprintDiscordExecutor, SqliteBlueprintJournal } from './blueprint-apply.js'
import { registerControlTools } from './control-tools.js'
import {
  curatedOperationForTool,
  curatedToolsForOperation,
  registerCuratedCatalogTools,
} from './curated-tools.js'
import { enforceDispatchMentionPolicy } from './mention-policy.js'
import { type AuditLog, type MetricsRegistry, writeStructuredLog } from './observability.js'
import { SqliteOperationPreviews } from './operation-previews.js'
import { registerResources } from './resources.js'

export interface ToolSurfaceServices {
  readonly rest: DiscordRestClient
  readonly dispatcher?: DiscordDispatcher
  readonly gatewayEvents?: GatewayEventStore
  readonly gateway?: GatewayLifecycle
  readonly principal?: Principal
  readonly database?: Database
  readonly blobs?: BlobStore
  readonly workflows?: WorkflowStore
  readonly oauthProfiles?: DiscordOAuthProfiles
  readonly blueprintPreviewKey?: Buffer
  readonly secretEncryption?: TokenEncryption
  readonly audit?: AuditLog
  readonly metrics?: MetricsRegistry
  readonly toolsets?: ReadonlySet<'operator' | 'automation' | 'admin' | 'api'>
  readonly workflowRuntime?: WorkflowRuntimeManager
  readonly maximumResponseBytes?: number
}

interface ResultMetadata {
  readonly operationId?: string
  readonly authProfile?: string
  readonly pagination?: {
    readonly hasMore: boolean
    readonly nextCursor?: string
  }
}

interface ActiveToolCall {
  readonly requestId: string
  readonly toolName: string
}

const activeToolCalls = new AsyncLocalStorage<ActiveToolCall>()
const currentRequestId = (): string => activeToolCalls.getStore()?.requestId ?? randomUUID()
const currentToolName = (): string => activeToolCalls.getStore()?.toolName ?? 'unknown'
const warningsSymbol = Symbol('discord-mcp-result-warnings')

interface ValueWithWarnings {
  readonly [warningsSymbol]: true
  readonly value: unknown
  readonly warnings: ReadonlyArray<string>
}

const messageAppearsContentRedacted = (value: unknown): boolean => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const message = value as Readonly<Record<string, unknown>>
  return (
    message.content === '' &&
    (!Array.isArray(message.embeds) || message.embeds.length === 0) &&
    (!Array.isArray(message.attachments) || message.attachments.length === 0) &&
    (!Array.isArray(message.components) || message.components.length === 0)
  )
}

const attachOperationWarnings = (value: unknown, operationId: string | undefined): unknown => {
  const appearsRedacted =
    operationId === 'get_message'
      ? messageAppearsContentRedacted(value)
      : operationId === 'list_messages' &&
        Array.isArray(value) &&
        value.length > 0 &&
        value.every(messageAppearsContentRedacted)
  if (!appearsRedacted) return value
  return {
    [warningsSymbol]: true,
    value,
    warnings: [
      'Discord returned message objects with all content-bearing fields empty. Enable the MESSAGE_CONTENT privileged intent in the Developer Portal.',
    ],
  } satisfies ValueWithWarnings
}

const isValueWithWarnings = (value: unknown): value is ValueWithWarnings =>
  typeof value === 'object' &&
  value !== null &&
  warningsSymbol in value &&
  (value as ValueWithWarnings)[warningsSymbol] === true

const utf8Prefix = (value: string, maximumBytes: number): string => {
  if (maximumBytes <= 0) return ''
  const bytes = Buffer.from(value)
  if (bytes.byteLength <= maximumBytes) return value
  const decoder = new TextDecoder('utf-8', { fatal: true })
  for (let end = maximumBytes; end >= Math.max(0, maximumBytes - 3); end -= 1) {
    try {
      return decoder.decode(bytes.subarray(0, end))
    } catch {
      // Try the preceding UTF-8 code-point boundary.
    }
  }
  return ''
}

const ok = (
  value: unknown,
  maximumResponseBytes = 25_000,
  metadata: ResultMetadata = {},
): CallToolResult => {
  const requestId = currentRequestId()
  const unwrappedValue = isValueWithWarnings(value) ? value.value : value
  const normalizedValue = unwrappedValue === undefined ? null : unwrappedValue
  const warnings = isValueWithWarnings(value)
    ? value.warnings
    : typeof value === 'object' &&
        value !== null &&
        'warnings' in value &&
        Array.isArray(value.warnings)
      ? value.warnings.filter((warning): warning is string => typeof warning === 'string')
      : []
  const serialized = JSON.stringify(normalizedValue)
  const truncated = Buffer.byteLength(serialized) > maximumResponseBytes
  const inferredCursor =
    typeof normalizedValue === 'object' &&
    normalizedValue !== null &&
    'nextCursor' in normalizedValue &&
    typeof normalizedValue.nextCursor === 'string'
      ? normalizedValue.nextCursor
      : undefined
  const pagination =
    metadata.pagination ??
    (inferredCursor === undefined ? undefined : { hasMore: true, nextCursor: inferredCursor })
  const data = truncated
    ? {
        truncated: true,
        preview: utf8Prefix(serialized, Math.max(0, maximumResponseBytes - 1_000)),
        continuation:
          'Use the operation pagination cursor or the matching discord:// MCP resource to retrieve bounded detail.',
      }
    : normalizedValue
  const structured = {
    ok: true,
    data,
    meta: {
      requestId,
      authProfile: metadata.authProfile ?? 'bot',
      ...(metadata.operationId === undefined ? {} : { operationId: metadata.operationId }),
      ...(pagination === undefined ? {} : { pagination }),
      truncated,
    },
    warnings: truncated
      ? [...warnings, 'response truncated at the configured byte limit']
      : warnings,
  }
  return {
    content: [
      {
        type: 'text',
        text: truncated
          ? `${JSON.stringify(data)}\nResponse truncated; use pagination or the matching MCP resource.`
          : serialized,
      },
    ],
    structuredContent: structured,
  }
}

const failed = (cause: unknown): CallToolResult => {
  const message = isDiscordFailure(cause)
    ? actionableDiscordMessage(cause)
    : cause instanceof Error
      ? cause.message
      : String(cause)
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: `${message}\nDo not retry unchanged arguments.`,
      },
    ],
    structuredContent: {
      ok: false,
      error: {
        code:
          cause instanceof Error
            ? cause.name
                .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
                .replaceAll(/[^A-Za-z0-9]+/g, '_')
                .toUpperCase()
            : 'UNKNOWN_ERROR',
        message,
        retryable: isDiscordFailure(cause) ? cause.retryable : false,
        ...(isDiscordFailure(cause) && cause.status !== undefined
          ? { httpStatus: cause.status }
          : {}),
        ...(isDiscordFailure(cause) && cause.code !== undefined ? { discordCode: cause.code } : {}),
        ...(isDiscordFailure(cause) && cause.retryAfterMs !== undefined
          ? { retryAfterMs: cause.retryAfterMs }
          : {}),
        ...(isDiscordFailure(cause) && cause.code === 50_013
          ? { missingPermission: 'Discord reported Missing Permissions' }
          : {}),
        suggestion:
          isDiscordFailure(cause) && cause.status === 403
            ? 'Do not retry; call discord_permissions_explain.'
            : 'Do not retry unchanged arguments.',
      },
      meta: { requestId: currentRequestId() },
    },
  }
}

const attemptResult = async (
  run: () => unknown | Promise<unknown>,
  maximumResponseBytes: number,
  metadata: ResultMetadata = {},
): Promise<CallToolResult> => {
  try {
    return ok(await run(), maximumResponseBytes, metadata)
  } catch (cause) {
    return failed(cause)
  }
}

const DispatchInput = Schema.Struct({
  operationId: Schema.String,
  authProfile: Schema.optionalKey(Schema.String),
  authMode: Schema.optionalKey(Schema.Literals(['bot', 'oauth2', 'webhook', 'interaction'])),
  path: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  query: Schema.optionalKey(Schema.Record(Schema.String, JsonValueSchema)),
  body: Schema.optionalKey(JsonValueSchema),
  secretRefs: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  auditLogReason: Schema.optionalKey(Schema.String),
  previewToken: Schema.optionalKey(Schema.String),
  files: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        blobId: Schema.String,
        filename: Schema.optionalKey(Schema.String),
        contentType: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
})

export const buildToolServer = (services: ToolSurfaceServices): McpServer => {
  const server = new McpServer(
    { name: 'discord-mcp', version: '1.0.0' },
    {
      capabilities: { tools: {} },
      instructions:
        'Use a curated discord_* tool or discord_api_search first. Describe unfamiliar operations, preview destructive/admin calls, then execute with the returned token. For workflows: create, validate, publish, grant, then enable.',
    },
  )
  const closeServer = server.close.bind(server)
  server.close = async () => {
    try {
      await closeServer()
    } finally {
      await runtime.dispose()
    }
  }
  const enabledToolsets =
    services.toolsets ??
    new Set<'operator' | 'automation' | 'admin' | 'api'>(['operator', 'automation', 'api'])
  const registry = makeToolRegistry({
    enabled: (name) =>
      enabledToolsets.has(toolsetFor(name)) && gateAvailable(gateFor(name), services),
  })
  const generatedOutputSchemas = new Map<Schema.Top, McpStandardSchema>()
  const outputSchemaFor = (name: string): McpStandardSchema => {
    const dataSchema = outputDataSchemaForTool(name)
    const cached = generatedOutputSchemas.get(dataSchema)
    if (cached) return cached
    const schema = McpInput(
      DiscordToolResultSchema(dataSchema as unknown as Schema.ConstraintDecoder<unknown, never>),
    ) as McpStandardSchema
    generatedOutputSchemas.set(dataSchema, schema)
    return schema
  }
  const runtime = ManagedRuntime.make(Layer.succeed(ToolRegistry, registry))
  const requestContext = <A, E>(
    program: Effect.Effect<A, E, never>,
    signal: AbortSignal,
    request?: {
      readonly id?: unknown
      readonly _meta?: { readonly progressToken?: string | number | undefined } | undefined
      readonly notify?: ((message: never) => Promise<unknown>) | undefined
    },
  ) =>
    program.pipe(
      Effect.provideService(McpRequestContext, {
        signal,
        requestId: request?.id === undefined ? currentRequestId() : String(request.id),
        ...(request?._meta?.progressToken === undefined
          ? {}
          : { progressToken: request._meta.progressToken }),
        ...(request?.notify === undefined
          ? {}
          : {
              notify: async (message: unknown) => {
                await request.notify?.(message as never)
              },
            }),
        principal: { id: principal.id, scopes: principal.scopes },
      }),
    )
  const runEffect = async <A, E>(
    program: Effect.Effect<A, E, never>,
    signal: AbortSignal,
    request?: {
      readonly id?: unknown
      readonly _meta?: { readonly progressToken?: string | number | undefined } | undefined
      readonly notify?: ((message: never) => Promise<unknown>) | undefined
    },
  ): Promise<A> => {
    const exit = await runtime.runPromiseExit(requestContext(program, signal, request), { signal })
    return Exit.match(exit, {
      onFailure: (cause) => {
        throw Cause.squash(cause)
      },
      onSuccess: (value) => value,
    })
  }
  const originalRegisterTool = server.registerTool.bind(server)
  server.registerTool = ((name: string, ...parameters: ReadonlyArray<unknown>) => {
    const [definition, handler, ...rest] = parameters
    if (typeof definition !== 'object' || definition === null) {
      throw new Error(`Invalid MCP tool definition: ${name}`)
    }
    const configured = definition as {
      readonly title?: string
      readonly description?: string
      readonly inputSchema?: {
        readonly '~standard'?: {
          readonly jsonSchema?: {
            readonly input?: (options: { readonly target: string }) => Record<string, unknown>
          }
        }
      }
      readonly outputSchema?: unknown
      readonly annotations?: {
        readonly destructiveHint?: boolean
        readonly openWorldHint?: boolean
      }
    }
    const completedDefinition = registry.prepare(name, {
      ...configured,
      title: configured.title ?? titleFor(name),
      description: enrichToolDescription(
        name,
        configured.description ?? titleFor(name),
        configured.annotations,
      ),
      outputSchema: configured.outputSchema ?? outputSchemaFor(name),
    } as RegisteredToolMetadata)
    if (!completedDefinition) return undefined
    const wrappedHandler =
      typeof handler === 'function'
        ? (...arguments_: ReadonlyArray<unknown>) => {
            const context = arguments_[1] as
              | {
                  readonly mcpReq?: {
                    readonly id?: string | number
                    readonly signal?: AbortSignal
                    readonly _meta?: {
                      readonly progressToken?: string | number | undefined
                    }
                    readonly notify?: ((message: never) => Promise<unknown>) | undefined
                  }
                }
              | undefined
            const signal = context?.mcpReq?.signal ?? new AbortController().signal
            return activeToolCalls.run(
              {
                requestId:
                  context?.mcpReq?.id === undefined ? randomUUID() : String(context.mcpReq.id),
                toolName: name,
              },
              () =>
                runEffect(
                  Effect.tryPromise({
                    try: () => Promise.resolve(handler(...arguments_)),
                    catch: (cause) => cause,
                  }),
                  signal,
                  context?.mcpReq,
                ),
            )
          }
        : handler
    return (originalRegisterTool as (...args: ReadonlyArray<unknown>) => unknown)(
      name,
      completedDefinition,
      wrappedHandler,
      ...rest,
    )
  }) as typeof server.registerTool
  const dispatcher =
    services.dispatcher ??
    new DiscordDispatcher(
      services.rest,
      services.database === undefined ? undefined : new SqliteOperationPreviews(services.database),
      services.blobs === undefined
        ? undefined
        : {
            read: async (blobId, principalId) => {
              const metadata = services.blobs?.getMetadata(blobId, principalId)
              const data = await services.blobs?.readForDiscord(blobId)
              if (!metadata || !data) throw new Error('blob persistence is unavailable')
              return { data, filename: metadata.filename, contentType: metadata.mimeType }
            },
          },
      services.oauthProfiles === undefined
        ? undefined
        : {
            resolve: async (profileId, principalId, authMode) => {
              if (authMode !== 'oauth2') throw new Error('named profiles require oauth2 authMode')
              const accessToken = await services.oauthProfiles?.accessToken(profileId, principalId)
              if (!accessToken) throw new Error('OAuth profile is unavailable')
              return new DiscordRestClient(
                discordJsTransport(accessToken, 'Bearer'),
                services.rest.rateGuard,
                profileId,
              )
            },
          },
      services.database === undefined || services.secretEncryption === undefined
        ? undefined
        : {
            resolve: async (reference, principalId) => {
              const row = services.database?.get<{ id: string; ciphertext: Uint8Array }>(
                `SELECT id, ciphertext FROM encrypted_secrets
                 WHERE owner_principal_id = ? AND name = ?`,
                principalId,
                reference,
              )
              if (!row) throw new Error(`named secret ${reference} does not exist`)
              return services.secretEncryption?.decrypt(row.ciphertext, `secret:${row.id}`) ?? ''
            },
          },
    )
  const principal = services.principal ?? localAdministrator()
  const attempt = async (
    run: () => unknown | Promise<unknown>,
    metadata: ResultMetadata = {},
  ): Promise<CallToolResult> => {
    const started = performance.now()
    const result = await attemptResult(
      async () => attachOperationWarnings(await run(), metadata.operationId),
      services.maximumResponseBytes ?? 25_000,
      metadata,
    )
    const outcome = result.isError ? 'failure' : 'success'
    const tool = currentToolName()
    services.metrics?.increment('discord_mcp_tool_calls_total', { tool, outcome })
    services.metrics?.increment(
      'discord_mcp_tool_duration_milliseconds_total',
      {
        tool,
        outcome,
      },
      performance.now() - started,
    )
    if (
      result.structuredContent &&
      typeof result.structuredContent === 'object' &&
      'meta' in result.structuredContent &&
      typeof result.structuredContent.meta === 'object' &&
      result.structuredContent.meta !== null &&
      'truncated' in result.structuredContent.meta &&
      result.structuredContent.meta.truncated === true
    ) {
      services.metrics?.increment('discord_mcp_tool_response_truncations_total', { tool })
    }
    services.audit?.record({
      principalId: principal.id,
      action: tool,
      targetType: 'mcp_tool',
      targetId: tool,
      requestId: currentRequestId(),
      detail: result.isError
        ? { kind: 'mcp.tool.call', error: result.content[0] }
        : { kind: 'mcp.tool.call' },
      outcome,
    })
    writeStructuredLog({
      level: result.isError ? 'warning' : 'info',
      event: 'mcp.tool.call',
      requestId: currentRequestId(),
      principalId: principal.id,
      ...(metadata.operationId === undefined ? {} : { operationId: metadata.operationId }),
      durationMs: performance.now() - started,
      outcome,
      detail: result.isError
        ? {
            tool,
            errorCode:
              result.structuredContent &&
              typeof result.structuredContent === 'object' &&
              'error' in result.structuredContent &&
              typeof result.structuredContent.error === 'object' &&
              result.structuredContent.error !== null &&
              'code' in result.structuredContent.error
                ? result.structuredContent.error.code
                : 'UNKNOWN_ERROR',
          }
        : { tool },
    })
    return result
  }
  const blueprintPreviews = new PreviewTokens(services.blueprintPreviewKey ?? Buffer.alloc(32, 7))
  const resolvePresentation = (
    presentation: MessagePresentation,
  ): Exclude<MessagePresentation, { type: 'template' }> => {
    if (presentation.type !== 'template') return presentation
    if (!services.database) throw new Error('template persistence is unavailable')
    const document = new VersionedDocumentStore(services.database, 'message-template').getPublished(
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
        if (!services.blobs) throw new Error('blob persistence is unavailable')
        services.blobs.getMetadata(attachment.blobId, principal.id)
        return {
          data: await services.blobs.readForDiscord(attachment.blobId),
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
  const guildGet = createGuildGetTool(services.rest)
  registerResources(server, principal, services.database)
  server.registerTool(
    guildGet.name,
    {
      title: guildGet.title,
      description: guildGet.description,
      inputSchema: McpInput(guildGet.input),
      annotations: guildGet.annotations,
    },
    async (args, context) =>
      attempt(() => {
        requireScopes(principal, ['mcp:read'])
        return runEffect(guildGet.handler(args), context.mcpReq.signal, context.mcpReq)
      }),
  )

  const SearchInput = Schema.Struct({
    query: Schema.optionalKey(Schema.String),
    method: Schema.optionalKey(Schema.Literals(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])),
    family: Schema.optionalKey(Schema.String),
    auth: Schema.optionalKey(Schema.Literals(['bot', 'oauth2', 'webhook', 'interaction'])),
    risk: Schema.optionalKey(
      Schema.Literals(['read', 'write', 'destructive', 'bot_admin', 'credential']),
    ),
    limit: Schema.optionalKey(Schema.Int),
    cursor: Schema.optionalKey(Schema.String),
  })
  server.registerTool(
    'discord_api_search',
    {
      description: 'Search the complete pinned Discord HTTP operation catalog locally.',
      inputSchema: McpInput(SearchInput),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) =>
      attempt(() => {
        requireScopes(principal, ['mcp:read'])
        const result = operationCatalog.search(args)
        return {
          ...result,
          operations: result.operations.map((operation) => ({
            ...operation,
            curatedTools: curatedToolsForOperation(operation.operationId),
          })),
        }
      }),
  )

  const DescribeInput = Schema.Struct({ operationId: Schema.String })
  server.registerTool(
    'discord_api_describe',
    {
      description: 'Describe one pinned Discord operation, its auth, risk, parameters, and body.',
      inputSchema: McpInput(DescribeInput),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ operationId }) =>
      attempt(() => {
        requireScopes(principal, ['mcp:read'])
        const operation = operationCatalog.describe(operationId)
        return {
          ...operation,
          curatedTools: curatedToolsForOperation(operationId),
          requiredPermissions: [],
          overrideWarnings: operation.overrides.map(
            ({ field, rationale }) => `${field}: ${rationale}`,
          ),
        }
      }),
  )

  server.registerTool(
    'discord_api_preview',
    {
      description:
        'Validate a cataloged operation locally and mint a 60-second bound token when guarded.',
      inputSchema: McpInput(DispatchInput),
      annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (args) =>
      attempt(
        () => {
          const normalized = enforceDispatchMentionPolicy(
            args,
            principal.scopes.has('mentions:broad'),
          )
          const operation = operationCatalog.describe(normalized.operationId)
          const scope: Scope =
            operation.risk === 'read'
              ? 'mcp:read'
              : operation.risk === 'destructive'
                ? 'mcp:destructive'
                : operation.risk === 'bot_admin'
                  ? 'bot:admin'
                  : 'mcp:write'
          requireScopes(principal, [scope])
          return dispatcher.preview(principal.id, normalized)
        },
        { operationId: args.operationId, authProfile: args.authProfile ?? 'bot' },
      ),
  )

  const registerDispatcher = (
    name: string,
    risk: OperationRisk,
    description: string,
    destructiveHint: boolean,
  ) => {
    server.registerTool(
      name,
      {
        description,
        inputSchema: McpInput(DispatchInput),
        annotations: {
          readOnlyHint: risk === 'read',
          destructiveHint,
          idempotentHint: risk === 'read',
          openWorldHint: true,
        },
      },
      async (args, context) =>
        attempt(
          async () => {
            const scope: Scope =
              risk === 'read'
                ? 'mcp:read'
                : risk === 'destructive'
                  ? 'mcp:destructive'
                  : risk === 'bot_admin'
                    ? 'bot:admin'
                    : 'mcp:write'
            requireScopes(principal, [scope])
            const normalized = enforceDispatchMentionPolicy(
              args,
              principal.scopes.has('mentions:broad'),
            )
            return runEffect(
              dispatcher.dispatch(principal.id, risk, normalized),
              context.mcpReq.signal,
              context.mcpReq,
            )
          },
          { operationId: args.operationId, authProfile: args.authProfile ?? 'bot' },
        ),
    )
  }
  registerDispatcher('discord_api_read', 'read', 'Execute a read-only cataloged operation.', false)
  registerDispatcher('discord_api_write', 'write', 'Execute a reversible cataloged write.', false)
  registerDispatcher(
    'discord_api_destructive',
    'destructive',
    'Execute a destructive operation using an exact unexpired preview token.',
    true,
  )
  registerDispatcher(
    'discord_api_admin',
    'bot_admin',
    'Execute a bot-administration operation using an exact unexpired preview token.',
    true,
  )
  registerCuratedCatalogTools(server, dispatcher, principal, attempt)
  const executeCatalog = (
    operationId: string,
    input: Omit<Parameters<DiscordDispatcher['preview']>[1], 'operationId'>,
    signal: AbortSignal,
    previewOnly = false,
  ) => {
    const operation = operationCatalog.describe(operationId)
    const dispatch = { operationId, ...input }
    if (previewOnly) return dispatcher.preview(principal.id, dispatch)
    return runEffect(dispatcher.dispatch(principal.id, operation.risk, dispatch), signal)
  }
  server.registerTool(
    'discord_message_pin_update',
    {
      description: 'Pin or unpin a channel message.',
      inputSchema: McpInput(
        Schema.Struct({
          channelId: Schema.String,
          messageId: Schema.String,
          action: Schema.Literals(['pin', 'unpin']),
          previewOnly: Schema.optionalKey(Schema.Boolean),
          previewToken: Schema.optionalKey(Schema.String),
        }),
      ),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ channelId, messageId, action, previewOnly, previewToken }, context) =>
      attempt(() => {
        requireScopes(principal, [action === 'unpin' ? 'mcp:destructive' : 'mcp:write'])
        return executeCatalog(
          action === 'pin' ? 'create_pin' : 'delete_pin',
          {
            path: { channel_id: channelId, message_id: messageId },
            ...(previewToken === undefined ? {} : { previewToken }),
          },
          context.mcpReq.signal,
          previewOnly,
        )
      }),
  )
  server.registerTool(
    'discord_message_reaction_update',
    {
      description: 'Add, remove, or clear message reactions with a semantic action.',
      inputSchema: McpInput(
        Schema.Struct({
          channelId: Schema.String,
          messageId: Schema.String,
          emoji: Schema.optionalKey(Schema.String),
          userId: Schema.optionalKey(Schema.String),
          action: Schema.Literals(['add', 'removeMine', 'removeUser', 'clearEmoji', 'clearAll']),
          previewOnly: Schema.optionalKey(Schema.Boolean),
          previewToken: Schema.optionalKey(Schema.String),
        }),
      ),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ channelId, messageId, emoji, userId, action, previewOnly, previewToken }, context) =>
      attempt(() => {
        requireScopes(principal, [action.startsWith('clear') ? 'mcp:destructive' : 'mcp:write'])
        const operationId = {
          add: 'add_my_message_reaction',
          removeMine: 'delete_my_message_reaction',
          removeUser: 'delete_user_message_reaction',
          clearEmoji: 'delete_all_message_reactions_by_emoji',
          clearAll: 'delete_all_message_reactions',
        }[action]
        if (action !== 'clearAll' && !emoji) throw new Error('emoji is required for this action')
        if (action === 'removeUser' && !userId) throw new Error('userId is required')
        return executeCatalog(
          operationId,
          {
            path: {
              channel_id: channelId,
              message_id: messageId,
              ...(emoji === undefined ? {} : { emoji_name: emoji }),
              ...(userId === undefined ? {} : { user_id: userId }),
            },
            ...(previewToken === undefined ? {} : { previewToken }),
          },
          context.mcpReq.signal,
          previewOnly,
        )
      }),
  )
  server.registerTool(
    'discord_thread_member_update',
    {
      description: 'Join, leave, add, or remove a thread member.',
      inputSchema: McpInput(
        Schema.Struct({
          threadId: Schema.String,
          userId: Schema.optionalKey(Schema.String),
          action: Schema.Literals(['join', 'leave', 'add', 'remove']),
          previewOnly: Schema.optionalKey(Schema.Boolean),
          previewToken: Schema.optionalKey(Schema.String),
        }),
      ),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ threadId, userId, action, previewOnly, previewToken }, context) =>
      attempt(() => {
        requireScopes(principal, [action === 'remove' ? 'mcp:destructive' : 'mcp:write'])
        if ((action === 'add' || action === 'remove') && !userId) {
          throw new Error('userId is required for add/remove')
        }
        const operationId = {
          join: 'join_thread',
          leave: 'leave_thread',
          add: 'add_thread_member',
          remove: 'delete_thread_member',
        }[action]
        return executeCatalog(
          operationId,
          {
            path: {
              channel_id: threadId,
              ...(userId === undefined ? {} : { user_id: userId }),
            },
            ...(previewToken === undefined ? {} : { previewToken }),
          },
          context.mcpReq.signal,
          previewOnly,
        )
      }),
  )
  registerControlTools(
    server,
    {
      ...(services.database === undefined ? {} : { database: services.database }),
      ...(services.blobs === undefined ? {} : { blobs: services.blobs }),
      ...(services.workflows === undefined ? {} : { workflows: services.workflows }),
      ...(services.oauthProfiles === undefined ? {} : { oauthProfiles: services.oauthProfiles }),
      ...(services.workflowRuntime === undefined
        ? {}
        : { workflowRuntime: services.workflowRuntime }),
    },
    principal,
    attempt,
  )

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
          services.rest.request('POST', `/channels/${channelId}/messages`, {
            body: encoded.payload,
            ...(files.length === 0 ? {} : { files }),
          }),
          context.mcpReq.signal,
          context.mcpReq,
        )
        if (services.database && typeof result === 'object' && result !== null) {
          const messageId = (result as { readonly id?: unknown }).id
          if (typeof messageId === 'string') {
            for (const binding of encoded.report.interactiveBindings) {
              services.database.run(
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
          services.rest.request<Record<string, unknown>>(
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
          services.rest.request('PATCH', `/channels/${channelId}/messages/${messageId}`, {
            body: encoded.payload,
            ...(files.length === 0 ? {} : { files }),
          }),
          context.mcpReq.signal,
          context.mcpReq,
        )
        if (services.database) {
          for (const binding of encoded.report.interactiveBindings) {
            services.database.run(
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
        if (!services.database || !services.secretEncryption) {
          throw new Error('encrypted webhook secrets are unavailable')
        }
        const secret = services.database.get<{ id: string; ciphertext: Uint8Array }>(
          `SELECT id, ciphertext FROM encrypted_secrets
           WHERE owner_principal_id = ? AND name = ?`,
          principal.id,
          secretRef,
        )
        if (!secret) throw new Error(`webhook secret ${secretRef} does not exist`)
        const token = services.secretEncryption.decrypt(secret.ciphertext, `secret:${secret.id}`)
        const resolved = resolvePresentation(presentation as MessagePresentation)
        authorizeBroadMentions(resolved)
        const encoded = encodeMessage(resolved, `principal:${principal.id}:webhook:${webhookId}`)
        assertPrincipalOwnedBindings(encoded.report.interactiveBindings)
        if (!applicationOwned && encoded.report.interactiveBindings.length > 0) {
          throw new Error('non-application-owned webhooks cannot send interactive components')
        }
        const files = await resolveMessageFiles(resolved)
        const result = await runEffect(
          services.rest.request('POST', `/webhooks/${webhookId}/${token}`, {
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
          services.database.run(
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

  const PermissionsInput = Schema.Struct({
    snapshot: GuildSnapshotSchema,
    memberId: Schema.String,
    roleIds: Schema.Array(Schema.String),
    channelId: Schema.optionalKey(Schema.String),
  })
  server.registerTool(
    'discord_permissions_explain',
    {
      description: 'Compute named effective Discord permissions and explain every overwrite stage.',
      inputSchema: McpInput(PermissionsInput),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) =>
      attempt(() => {
        requireScopes(principal, ['server:plan'])
        return explainPermissions({
          snapshot: args.snapshot as GuildSnapshot,
          memberId: args.memberId,
          roleIds: args.roleIds,
          ...(args.channelId === undefined ? {} : { channelId: args.channelId }),
        })
      }),
  )

  const GuildInspectInput = Schema.Struct({ guildId: Schema.String })
  const inspectGuild = async (guildId: string, signal: AbortSignal, requireReadScope = true) => {
    if (requireReadScope) requireScopes(principal, ['mcp:read'])
    if (!/^\d{17,21}$/.test(guildId)) throw new Error('guildId must be a Discord snowflake')
    const [guild, channels, roles, user] = await runEffect(
      Effect.all(
        [
          services.rest.request<Record<string, unknown>>('GET', `/guilds/${guildId}`, {
            query: new URLSearchParams({ with_counts: 'true' }),
          }),
          services.rest.request<ReadonlyArray<Record<string, unknown>>>(
            'GET',
            `/guilds/${guildId}/channels`,
          ),
          services.rest.request<ReadonlyArray<Record<string, unknown>>>(
            'GET',
            `/guilds/${guildId}/roles`,
          ),
          services.rest.request<Record<string, unknown>>('GET', '/users/@me'),
        ],
        { concurrency: 4 },
      ),
      signal,
    )
    const botId = String(user.id)
    const member = await runEffect(
      services.rest.request<Record<string, unknown>>('GET', `/guilds/${guildId}/members/${botId}`),
      signal,
    )
    const [onboarding, welcomeScreen, autoModerationRules] = await runEffect(
      Effect.all(
        [
          services.rest
            .request<Record<string, unknown>>('GET', `/guilds/${guildId}/onboarding`)
            .pipe(Effect.catch(() => Effect.succeed(null))),
          services.rest
            .request<Record<string, unknown>>('GET', `/guilds/${guildId}/welcome-screen`)
            .pipe(Effect.catch(() => Effect.succeed(null))),
          services.rest
            .request<ReadonlyArray<Record<string, unknown>>>(
              'GET',
              `/guilds/${guildId}/auto-moderation/rules`,
            )
            .pipe(Effect.catch(() => Effect.succeed([]))),
        ],
        { concurrency: 2 },
      ),
      signal,
    )
    const snapshot: GuildSnapshot = {
      guildId,
      ownerId: String(guild.owner_id),
      botMemberId: botId,
      botRoleIds: Array.isArray(member.roles) ? member.roles.map(String) : [],
      settings: guild,
      roles: roles.map((role) => ({
        id: String(role.id),
        name: String(role.name),
        permissions: String(role.permissions ?? '0'),
        color: Number(role.color ?? 0),
        hoist: Boolean(role.hoist),
        mentionable: Boolean(role.mentionable),
        position: Number(role.position ?? 0),
        managed: Boolean(role.managed),
      })),
      channels: channels.map((channel) => ({
        id: String(channel.id),
        kind: discordChannelKind(Number(channel.type)),
        name: String(channel.name),
        ...(channel.parent_id === undefined || channel.parent_id === null
          ? {}
          : { parentId: String(channel.parent_id) }),
        ...(channel.topic === undefined ? {} : { topic: channel.topic as string | null }),
        ...(channel.nsfw === undefined ? {} : { nsfw: Boolean(channel.nsfw) }),
        ...(channel.bitrate === undefined ? {} : { bitrate: Number(channel.bitrate) }),
        ...(channel.user_limit === undefined ? {} : { userLimit: Number(channel.user_limit) }),
        ...(channel.rate_limit_per_user === undefined
          ? {}
          : { rateLimitPerUser: Number(channel.rate_limit_per_user) }),
        ...(channel.default_thread_rate_limit_per_user === undefined
          ? {}
          : {
              defaultThreadRateLimitPerUser: Number(channel.default_thread_rate_limit_per_user),
            }),
        ...(channel.default_auto_archive_duration === undefined
          ? {}
          : { defaultAutoArchiveDuration: Number(channel.default_auto_archive_duration) }),
        ...(channel.default_forum_layout === undefined
          ? {}
          : { defaultForumLayout: Number(channel.default_forum_layout) }),
        ...(channel.default_sort_order === undefined
          ? {}
          : {
              defaultSortOrder:
                channel.default_sort_order === null ? null : Number(channel.default_sort_order),
            }),
        ...(channel.default_reaction_emoji === undefined
          ? {}
          : {
              defaultReactionEmoji:
                channel.default_reaction_emoji === null
                  ? null
                  : discordEmoji(channel.default_reaction_emoji),
            }),
        ...(Array.isArray(channel.available_tags)
          ? {
              forumTags: channel.available_tags.map((tag) => {
                const value = tag as Record<string, unknown>
                return {
                  ...(value.id === undefined ? {} : { id: String(value.id) }),
                  name: String(value.name),
                  moderated: Boolean(value.moderated),
                  ...(value.emoji_id === undefined || value.emoji_id === null
                    ? {}
                    : { emojiId: String(value.emoji_id) }),
                  ...(value.emoji_name === undefined || value.emoji_name === null
                    ? {}
                    : { emojiName: String(value.emoji_name) }),
                }
              }),
            }
          : {}),
        position: Number(channel.position ?? 0),
        overwrites: Array.isArray(channel.permission_overwrites)
          ? channel.permission_overwrites.map((overwrite) => {
              const value = overwrite as Record<string, unknown>
              return {
                id: String(value.id),
                type: Number(value.type) === 1 ? ('member' as const) : ('role' as const),
                allow: String(value.allow ?? '0'),
                deny: String(value.deny ?? '0'),
              }
            })
          : [],
      })),
      ...(welcomeScreen === null ? {} : { welcomeScreen }),
      ...(onboarding === null ? {} : { onboarding }),
      autoModerationRules,
    }
    return {
      guild,
      onboarding,
      welcomeScreen,
      autoModerationRules,
      snapshot,
      botEffectivePermissions: explainPermissions({
        snapshot,
        memberId: botId,
        roleIds: snapshot.botRoleIds,
      }),
    }
  }
  for (const [name, description] of [
    ['discord_guild_inspect', 'Inspect guild settings and a normalized blueprint snapshot.'],
    ['discord_server_snapshot', 'Capture a normalized guild snapshot for blueprint planning.'],
  ] as const) {
    server.registerTool(
      name,
      {
        description,
        inputSchema: McpInput(GuildInspectInput),
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      },
      async ({ guildId }, context) => attempt(() => inspectGuild(guildId, context.mcpReq.signal)),
    )
  }

  const BlueprintPlanInput = Schema.Struct({
    blueprintId: Schema.optionalKey(Schema.String),
    revision: Schema.optionalKey(Schema.Int),
    blueprint: Schema.optionalKey(ServerBlueprintSchema),
    snapshot: GuildSnapshotSchema,
    bindings: Schema.optionalKey(BlueprintBindingsSchema),
    deleteManaged: Schema.optionalKey(Schema.Boolean),
  })
  server.registerTool(
    'discord_server_blueprint_plan',
    {
      description:
        'Plan an idempotent server reconciliation locally. Planning never mutates Discord.',
      inputSchema: McpInput(BlueprintPlanInput),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) =>
      attempt(() => {
        requireScopes(principal, ['server:plan'])
        let blueprint = args.blueprint as ServerBlueprint | undefined
        let bindings = args.bindings as BlueprintBindings | undefined
        if (services.database) {
          if (!args.blueprintId) {
            throw new Error('blueprintId is required; planning operates on published revisions')
          }
          const published = new VersionedDocumentStore(
            services.database,
            'server-blueprint',
          ).getPublished(args.blueprintId, args.revision, principal.id)
          blueprint = {
            ...(published.document as ServerBlueprint),
            id: args.blueprintId,
            revision: published.revision,
          }
          bindings = loadBlueprintBindings(services.database, args.blueprintId)
        }
        if (!blueprint) throw new Error('blueprint is required')
        const plan = planBlueprint({
          blueprint,
          snapshot: args.snapshot as GuildSnapshot,
          bindings: bindings ?? { roles: {}, channels: {} },
          ...(args.deleteManaged === undefined ? {} : { deleteManaged: args.deleteManaged }),
        })
        return {
          ...plan,
          previewToken: blueprintPreviews.issue({
            principalId: principal.id,
            guildId: blueprint.guildId,
            blueprintDigest: plan.blueprintDigest,
            snapshotDigest: plan.snapshotDigest,
            actionsDigest: digest(plan.actions),
          }),
          expiresInMs: 60_000,
        }
      }),
  )

  const BlueprintApplyInput = Schema.Struct({
    blueprintId: Schema.String,
    revision: Schema.optionalKey(Schema.Int),
    deleteManaged: Schema.optionalKey(Schema.Boolean),
    previewToken: Schema.String,
    resumeExecutionId: Schema.optionalKey(Schema.String),
  })
  server.registerTool(
    'discord_server_blueprint_apply',
    {
      description:
        'Apply an exact published blueprint plan with a bound preview token and durable resume journal.',
      inputSchema: McpInput(BlueprintApplyInput),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args, context) =>
      attempt(async () => {
        requireScopes(principal, ['server:apply'])
        if (args.deleteManaged === true) requireScopes(principal, ['mcp:destructive'])
        if (!services.database) throw new Error('blueprint persistence is unavailable')
        const published = new VersionedDocumentStore(
          services.database,
          'server-blueprint',
        ).getPublished(args.blueprintId, args.revision, principal.id)
        const blueprint: ServerBlueprint = {
          ...(published.document as ServerBlueprint),
          id: args.blueprintId,
          revision: published.revision,
        }
        const currentSnapshot = (
          await inspectGuild(blueprint.guildId, context.mcpReq.signal, false)
        ).snapshot
        const plan = planBlueprint({
          blueprint,
          snapshot: currentSnapshot,
          bindings: loadBlueprintBindings(services.database, args.blueprintId),
          ...(args.deleteManaged === undefined ? {} : { deleteManaged: args.deleteManaged }),
        })
        blueprintPreviews.verify(args.previewToken, {
          principalId: principal.id,
          guildId: blueprint.guildId,
          blueprintDigest: plan.blueprintDigest,
          snapshotDigest: plan.snapshotDigest,
          actionsDigest: digest(plan.actions),
        })
        const applier = new BlueprintApplier(
          new SqliteBlueprintJournal(
            services.database,
            args.blueprintId,
            published.revision,
            principal.id,
          ),
          new BlueprintDiscordExecutor(
            services.database,
            dispatcher,
            principal.id,
            args.blueprintId,
            blueprint.guildId,
          ),
        )
        const started = performance.now()
        try {
          const result = await applier.apply(plan, args.resumeExecutionId)
          services.metrics?.increment('discord_mcp_blueprint_apply_total', {
            outcome: 'success',
          })
          services.metrics?.observe(
            'discord_mcp_blueprint_apply_duration_milliseconds',
            performance.now() - started,
            { outcome: 'success' },
          )
          return result
        } catch (cause) {
          services.metrics?.increment('discord_mcp_blueprint_apply_total', {
            outcome: 'failure',
          })
          services.metrics?.observe(
            'discord_mcp_blueprint_apply_duration_milliseconds',
            performance.now() - started,
            { outcome: 'failure' },
          )
          throw cause
        }
      }),
  )

  const GatewayRecentInput = Schema.Struct({
    types: Schema.optionalKey(Schema.Array(Schema.String)),
    cursor: Schema.optionalKey(Schema.String),
    limit: Schema.optionalKey(Schema.Int),
  })
  server.registerTool(
    'discord_gateway_status',
    {
      description: 'Inspect the local Discord Gateway connection state.',
      inputSchema: McpInput(Schema.Record(Schema.String, Schema.Never)),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () =>
      attempt(() => {
        requireScopes(principal, ['mcp:read'])
        return {
          mode: services.gateway?.mode ?? 'off',
          status: services.gateway?.status ?? 'disconnected',
        }
      }),
  )

  const PresenceInput = Schema.Struct({
    since: Schema.optionalKey(Schema.NullOr(Schema.Number)),
    activities: Schema.optionalKey(Schema.Array(JsonValueSchema)),
    status: Schema.optionalKey(Schema.Literals(['online', 'dnd', 'idle', 'invisible', 'offline'])),
    afk: Schema.optionalKey(Schema.Boolean),
  })
  server.registerTool(
    'discord_presence_set',
    {
      description: 'Set the bot presence through the managed Gateway connection.',
      inputSchema: McpInput(PresenceInput),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) =>
      attempt(async () => {
        requireScopes(principal, ['bot:admin'])
        if (!services.gateway) throw new Error('Gateway is not configured')
        await services.gateway.send({
          op: 3,
          d: {
            since: args.since ?? null,
            activities: args.activities ?? [],
            status: args.status ?? 'online',
            afk: args.afk ?? false,
          },
        })
        return { sent: true }
      }),
  )

  const VoiceStateInput = Schema.Struct({
    guildId: Schema.String.pipe(Schema.check(Schema.isPattern(/^\d{17,21}$/))),
    channelId: Schema.NullOr(Schema.String.pipe(Schema.check(Schema.isPattern(/^\d{17,21}$/)))),
    selfMute: Schema.optionalKey(Schema.Boolean),
    selfDeaf: Schema.optionalKey(Schema.Boolean),
  })
  server.registerTool(
    'discord_voice_state_set',
    {
      description:
        'Join, move, or leave a guild voice channel through the managed Gateway connection; null leaves.',
      inputSchema: McpInput(VoiceStateInput),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ guildId, channelId, selfMute, selfDeaf }) =>
      attempt(async () => {
        requireScopes(principal, ['bot:admin'])
        if (!services.gateway) throw new Error('Gateway is not configured')
        await services.gateway.send({
          op: 4,
          d: {
            guild_id: guildId,
            channel_id: channelId,
            self_mute: selfMute ?? false,
            self_deaf: selfDeaf ?? false,
          },
        })
        return { sent: true }
      }),
  )

  server.registerTool(
    'discord_gateway_recent_events',
    {
      description: 'Read normalized durable Gateway events with a monotonic cursor.',
      inputSchema: McpInput(GatewayRecentInput),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) =>
      attempt(() => {
        requireScopes(principal, ['mcp:read'])
        if (!services.gatewayEvents) throw new Error('Gateway event persistence is not configured')
        return (services.gateway?.ensureConnected() ?? Promise.resolve()).then(() =>
          services.gatewayEvents?.recent(args),
        )
      }),
  )

  const GatewayWaitInput = Schema.Struct({
    types: Schema.optionalKey(Schema.Array(Schema.String)),
    cursor: Schema.optionalKey(Schema.String),
    limit: Schema.optionalKey(Schema.Int),
    waitMs: Schema.optionalKey(Schema.Int),
  })
  server.registerTool(
    'discord_gateway_wait_for_event',
    {
      description: 'Wait race-free for a matching durable Gateway event; timeout is successful.',
      inputSchema: McpInput(GatewayWaitInput),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args, context) =>
      attempt(async () => {
        requireScopes(principal, ['mcp:read'])
        if (!services.gatewayEvents) throw new Error('Gateway event persistence is not configured')
        await (services.gateway?.ensureConnected() ?? Promise.resolve())
        const progressToken = context.mcpReq._meta?.progressToken
        let elapsed = 0
        const timer =
          progressToken === undefined
            ? undefined
            : setInterval(() => {
                elapsed += 5_000
                void context.mcpReq.notify({
                  method: 'notifications/progress',
                  params: {
                    progressToken,
                    progress: elapsed,
                    total: args.waitMs ?? 25_000,
                    message: 'Waiting for a matching Discord Gateway event',
                  },
                })
              }, 5_000)
        try {
          return await services.gatewayEvents.wait(args, context.mcpReq.signal)
        } finally {
          if (timer) clearInterval(timer)
        }
      }),
  )

  return server
}

const loadBlueprintBindings = (database: Database, blueprintId: string): BlueprintBindings => {
  const rows = database.all<{
    logical_type: 'role' | 'channel' | 'automod'
    logical_key: string
    discord_id: string
  }>(
    `SELECT logical_type, logical_key, discord_id FROM server_blueprint_bindings
     WHERE blueprint_id = ?`,
    blueprintId,
  )
  return {
    roles: Object.fromEntries(
      rows
        .filter(({ logical_type }) => logical_type === 'role')
        .map(({ logical_key, discord_id }) => [logical_key, discord_id]),
    ),
    channels: Object.fromEntries(
      rows
        .filter(({ logical_type }) => logical_type === 'channel')
        .map(({ logical_key, discord_id }) => [logical_key, discord_id]),
    ),
    autoModerationRules: Object.fromEntries(
      rows
        .filter(({ logical_type }) => logical_type === 'automod')
        .map(({ logical_key, discord_id }) => [logical_key, discord_id]),
    ),
  }
}

const discordEmoji = (
  value: unknown,
): { readonly emojiId?: string; readonly emojiName?: string } => {
  if (typeof value !== 'object' || value === null) return {}
  const emoji = value as Record<string, unknown>
  return {
    ...(emoji.emoji_id === undefined || emoji.emoji_id === null
      ? {}
      : { emojiId: String(emoji.emoji_id) }),
    ...(emoji.emoji_name === undefined || emoji.emoji_name === null
      ? {}
      : { emojiName: String(emoji.emoji_name) }),
  }
}

const discordChannelKind = (type: number): GuildSnapshot['channels'][number]['kind'] => {
  const kind = {
    0: 'text',
    2: 'voice',
    4: 'category',
    5: 'announcement',
    13: 'stage',
    15: 'forum',
    16: 'media',
  } as const
  const resolved = kind[type as keyof typeof kind]
  if (!resolved) throw new Error(`unsupported Discord channel type ${type}`)
  return resolved
}

const toolsetFor = (name: string): 'operator' | 'automation' | 'admin' | 'api' => {
  if (name.startsWith('discord_api_')) return 'api'
  if (
    name.startsWith('discord_workflow_') ||
    name.startsWith('discord_message_template_') ||
    name === 'discord_events_tail'
  ) {
    return 'automation'
  }
  if (
    name.startsWith('discord_oauth_') ||
    name.startsWith('discord_audit_') ||
    name.startsWith('discord_application_') ||
    name === 'discord_server_blueprint_apply'
  ) {
    return 'admin'
  }
  return 'operator'
}

type ToolGate = 'always' | 'gateway' | 'workflows'

const gateFor = (name: string): ToolGate => {
  if (name.startsWith('discord_workflow_') || name === 'discord_events_tail') {
    return 'workflows'
  }
  if (
    name === 'discord_presence_set' ||
    name === 'discord_voice_state_set' ||
    name === 'discord_gateway_status' ||
    name === 'discord_gateway_recent_events' ||
    name === 'discord_gateway_wait_for_event'
  ) {
    return 'gateway'
  }
  return 'always'
}

const gateAvailable = (gate: ToolGate, services: ToolSurfaceServices): boolean => {
  switch (gate) {
    case 'gateway':
      return services.gateway !== undefined || services.gatewayEvents !== undefined
    case 'workflows':
      return (
        services.database !== undefined ||
        services.workflows !== undefined ||
        services.workflowRuntime !== undefined
      )
    default:
      return true
  }
}

const JsonObjectDataSchema = Schema.Record(Schema.String, JsonValueSchema)
const NullableStringSchema = Schema.NullOr(Schema.String)
const DiscordEntityDataSchema = Schema.StructWithRest(Schema.Struct({ id: Schema.String }), [
  JsonObjectDataSchema,
])
const DiscordGuildDataSchema = Schema.StructWithRest(
  Schema.Struct({ id: Schema.String, name: Schema.String }),
  [JsonObjectDataSchema],
)

const OperationPreviewDataSchema = Schema.Struct({
  operation: JsonObjectDataSchema,
  normalized: Schema.Struct({
    route: Schema.String,
    query: JsonObjectDataSchema,
    body: JsonValueSchema,
  }),
  previewToken: Schema.optionalKey(Schema.String),
  expiresInMs: Schema.optionalKey(Schema.Number),
})

const CatalogPaginationSchema = Schema.Struct({
  style: Schema.Literals(['none', 'cursor', 'offset']),
  parameters: Schema.Array(Schema.String),
  limitParameter: Schema.optionalKey(Schema.String),
})

const CatalogOperationSummarySchema = Schema.Struct({
  operationId: Schema.String,
  method: Schema.Literals(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  path: Schema.String,
  family: Schema.String,
  risk: Schema.Literals(['read', 'write', 'destructive', 'bot_admin', 'credential']),
  auth: Schema.Array(Schema.Literals(['bot', 'oauth2', 'webhook', 'interaction'])),
  oauthScopes: Schema.Array(Schema.String),
  description: Schema.String,
  pagination: CatalogPaginationSchema,
  auditLogReason: Schema.Boolean,
  curatedTools: Schema.Array(Schema.String),
})

const CatalogOperationSchema = Schema.Struct({
  operationId: Schema.String,
  method: Schema.Literals(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  path: Schema.String,
  family: Schema.String,
  risk: Schema.Literals(['read', 'write', 'destructive', 'bot_admin', 'credential']),
  auth: Schema.Array(Schema.Literals(['bot', 'oauth2', 'webhook', 'interaction'])),
  oauthScopes: Schema.Array(Schema.String),
  parameters: Schema.Array(JsonObjectDataSchema),
  body: JsonObjectDataSchema,
  bodyRequired: Schema.Boolean,
  responseBodies: JsonObjectDataSchema,
  schemaNames: Schema.Array(Schema.String),
  sensitiveBodyFields: Schema.Array(Schema.String),
  description: Schema.String,
  searchTokens: Schema.String,
  auditLogReason: Schema.Boolean,
  botIncompatible: Schema.Boolean,
  pagination: CatalogPaginationSchema,
  documentationUrl: Schema.String,
  overrides: Schema.Array(
    Schema.Struct({
      field: Schema.String,
      rationale: Schema.String,
    }),
  ),
  dispatcherExample: JsonObjectDataSchema,
  curatedTools: Schema.Array(Schema.String),
  requiredPermissions: Schema.Array(Schema.String),
  overrideWarnings: Schema.Array(Schema.String),
})

const MentionAnalysisSchema = Schema.Struct({
  users: Schema.Array(Schema.String),
  roles: Schema.Array(Schema.String),
  broad: Schema.Array(Schema.Literals(['everyone', 'here'])),
})

const ValidationReportSchema = Schema.Struct({
  componentCount: Schema.Number,
  warnings: Schema.Array(Schema.String),
  mentions: MentionAnalysisSchema,
  attachmentManifest: Schema.Array(
    Schema.Struct({
      filename: Schema.String,
      source: Schema.Literals(['inline', 'blob']),
    }),
  ),
  interactiveBindings: Schema.Array(
    Schema.Struct({
      customId: Schema.String,
      action: Schema.Struct({
        type: Schema.Literals(['component', 'modal']),
        key: Schema.String,
      }),
    }),
  ),
})

const EncodedMessageDataSchema = Schema.Struct({
  payload: JsonObjectDataSchema,
  report: ValidationReportSchema,
  layout: Schema.String,
})

const EncodedModalDataSchema = Schema.Struct({
  payload: JsonObjectDataSchema,
  report: ValidationReportSchema,
})

const TemplateRenderDataSchema = Schema.Struct({
  presentation: MessagePresentationSchema,
  digest: Schema.String,
  warnings: Schema.Array(Schema.String),
})

const VersionedDocumentMetadataSchema = Schema.Struct({
  id: Schema.String,
  ownerPrincipalId: Schema.String,
  name: Schema.String,
  latestRevision: Schema.optionalKey(Schema.Number),
  archived: Schema.Boolean,
  createdAt: Schema.String,
  updatedAt: Schema.String,
})

const PublishedDocumentSchema = Schema.Struct({
  id: Schema.String,
  revision: Schema.Number,
  digest: Schema.String,
  document: JsonValueSchema,
  publishedBy: Schema.String,
  publishedAt: Schema.String,
})

const BlobMetadataSchema = Schema.Struct({
  id: Schema.String,
  ownerPrincipalId: Schema.String,
  filename: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Number,
  referenceCount: Schema.Number,
  createdAt: Schema.String,
})

const OAuthProfileMetadataSchema = Schema.Struct({
  id: Schema.String,
  ownerPrincipalId: Schema.String,
  name: Schema.String,
  scopes: Schema.Array(Schema.String),
  discordUserId: Schema.optionalKey(Schema.String),
  expiresAt: Schema.optionalKey(Schema.String),
  revoked: Schema.Boolean,
})

const PermissionExplanationSchema = Schema.Struct({
  permissions: Schema.Array(Schema.String),
  bits: Schema.String,
  trace: Schema.Array(Schema.String),
})

const GuildInspectionSchema = Schema.Struct({
  guild: JsonObjectDataSchema,
  onboarding: Schema.Union([Schema.Null, JsonObjectDataSchema]),
  welcomeScreen: Schema.Union([Schema.Null, JsonObjectDataSchema]),
  autoModerationRules: Schema.Array(JsonObjectDataSchema),
  snapshot: GuildSnapshotSchema,
  botEffectivePermissions: PermissionExplanationSchema,
})

const BlueprintPlanDataSchema = Schema.Struct({
  blueprintDigest: Schema.String,
  snapshotDigest: Schema.String,
  actions: Schema.Array(JsonValueSchema),
  destructive: Schema.Boolean,
  warnings: Schema.Array(Schema.String),
  previewToken: Schema.String,
  expiresInMs: Schema.Number,
})

const BlueprintExecutionSchema = Schema.Struct({
  id: Schema.String,
  blueprintDigest: Schema.String,
  snapshotDigest: Schema.String,
  actionsDigest: Schema.String,
  status: Schema.Literals(['running', 'completed', 'partial']),
  actions: Schema.Array(
    Schema.Struct({
      index: Schema.Number,
      action: JsonValueSchema,
      status: Schema.Literals(['pending', 'running', 'completed', 'failed']),
      result: Schema.optionalKey(JsonValueSchema),
      error: Schema.optionalKey(Schema.String),
    }),
  ),
})

const GatewayEventSchema = Schema.Struct({
  sequence: Schema.Number,
  discordEventId: Schema.optionalKey(Schema.String),
  eventType: Schema.String,
  payload: JsonValueSchema,
  correlationId: Schema.String,
  causationId: Schema.optionalKey(Schema.String),
  causalDepth: Schema.Number,
  receivedAt: Schema.String,
})

const GatewayRecentSchema = Schema.Struct({
  events: Schema.Array(GatewayEventSchema),
  cursor: Schema.String,
})

const WorkflowMetadataSchema = Schema.Struct({
  id: Schema.String,
  owner_principal_id: Schema.String,
  slug: Schema.String,
  name: Schema.String,
  enabled_revision: Schema.NullOr(Schema.Number),
  deleted_at: NullableStringSchema,
  created_at: Schema.String,
  updated_at: Schema.String,
})

const WorkflowRevisionMetadataSchema = Schema.Struct({
  revision: Schema.Number,
  source_digest: Schema.String,
  artifact_digest: NullableStringSchema,
  status: Schema.String,
  diagnostics_json: Schema.String,
  created_by: Schema.String,
  created_at: Schema.String,
})

const WorkflowDetailsSchema = Schema.Struct({
  ...WorkflowMetadataSchema.fields,
  revisions: Schema.Array(WorkflowRevisionMetadataSchema),
})

const WorkflowExecutionRowSchema = Schema.Struct({
  id: Schema.String,
  workflow_id: Schema.String,
  revision: Schema.Number,
  trigger_type: Schema.String,
  status: Schema.Literals(['queued', 'running', 'succeeded', 'failed', 'timed_out']),
  correlation_id: Schema.String,
  causation_id: NullableStringSchema,
  causal_depth: Schema.Number,
  started_at: Schema.String,
  finished_at: NullableStringSchema,
  logs: Schema.String,
  error_json: NullableStringSchema,
})

const WorkflowExecutionTailRowSchema = Schema.Struct({
  cursor: Schema.Number,
  ...WorkflowExecutionRowSchema.fields,
})

const WorkflowEventRowSchema = Schema.Struct({
  sequence: Schema.Number,
  workflow_id: Schema.String,
  event_type: Schema.String,
  payload_json: Schema.String,
  correlation_id: Schema.String,
  causation_id: NullableStringSchema,
  received_at: Schema.String,
})

const ComponentEventRowSchema = Schema.Struct({
  sequence: Schema.Number,
  owner_type: Schema.Literals(['principal', 'workflow']),
  owner_id: Schema.String,
  binding_handle: Schema.String,
  action_key: Schema.String,
  interaction_id: Schema.String,
  payload_json: Schema.String,
  correlation_id: Schema.String,
  received_at: Schema.String,
})

const AuditRowSchema = Schema.Struct({
  cursor: Schema.Number,
  id: Schema.String,
  principal_id: NullableStringSchema,
  action: Schema.String,
  target_type: NullableStringSchema,
  target_id: NullableStringSchema,
  request_id: NullableStringSchema,
  detail_json: Schema.String,
  outcome: Schema.Literals(['success', 'failure']),
  created_at: Schema.String,
})

const customOutputDataSchemas: Readonly<Record<string, Schema.Top>> = {
  discord_guild_get: DiscordGuildDataSchema,
  discord_api_search: Schema.Struct({
    operations: Schema.Array(CatalogOperationSummarySchema),
    nextCursor: Schema.optionalKey(Schema.String),
  }),
  discord_api_describe: CatalogOperationSchema,
  discord_api_preview: OperationPreviewDataSchema,
  discord_message_pin_update: Schema.Union([Schema.Null, OperationPreviewDataSchema]),
  discord_message_reaction_update: Schema.Union([Schema.Null, OperationPreviewDataSchema]),
  discord_thread_member_update: Schema.Union([Schema.Null, OperationPreviewDataSchema]),
  discord_message_validate: EncodedMessageDataSchema,
  discord_message_send: DiscordEntityDataSchema,
  discord_message_edit: DiscordEntityDataSchema,
  discord_webhook_execute: DiscordEntityDataSchema,
  discord_modal_validate: EncodedModalDataSchema,
  discord_permissions_explain: PermissionExplanationSchema,
  discord_guild_inspect: GuildInspectionSchema,
  discord_server_snapshot: GuildInspectionSchema,
  discord_server_blueprint_plan: BlueprintPlanDataSchema,
  discord_server_blueprint_apply: BlueprintExecutionSchema,
  discord_gateway_status: Schema.Struct({
    mode: Schema.Literals(['off', 'lazy', 'eager']),
    status: Schema.Literals(['disconnected', 'connecting', 'connected', 'failed']),
  }),
  discord_presence_set: Schema.Struct({ sent: Schema.Literal(true) }),
  discord_voice_state_set: Schema.Struct({ sent: Schema.Literal(true) }),
  discord_gateway_recent_events: GatewayRecentSchema,
  discord_gateway_wait_for_event: Schema.Struct({
    ...GatewayRecentSchema.fields,
    timedOut: Schema.Boolean,
  }),
  discord_message_template_list: Schema.Array(VersionedDocumentMetadataSchema),
  discord_message_template_get: Schema.Union([JsonObjectDataSchema, PublishedDocumentSchema]),
  discord_message_template_create: VersionedDocumentMetadataSchema,
  discord_message_template_update_draft: Schema.Struct({ updated: Schema.Literal(true) }),
  discord_message_template_validate: TemplateRenderDataSchema,
  discord_message_template_publish: PublishedDocumentSchema,
  discord_message_template_render: TemplateRenderDataSchema,
  discord_message_template_archive: Schema.Struct({ archived: Schema.Literal(true) }),
  discord_blob_put: BlobMetadataSchema,
  discord_blob_get_metadata: BlobMetadataSchema,
  discord_blob_delete: Schema.Null,
  discord_server_blueprint_list: Schema.Array(VersionedDocumentMetadataSchema),
  discord_server_blueprint_get: Schema.Union([ServerBlueprintSchema, PublishedDocumentSchema]),
  discord_server_blueprint_create: VersionedDocumentMetadataSchema,
  discord_server_blueprint_update_draft: Schema.Struct({ updated: Schema.Literal(true) }),
  discord_server_blueprint_validate: Schema.Struct({ valid: Schema.Literal(true) }),
  discord_server_blueprint_publish: PublishedDocumentSchema,
  discord_server_blueprint_archive: Schema.Struct({ archived: Schema.Literal(true) }),
  discord_audit_list: Schema.Array(AuditRowSchema),
  discord_oauth_profile_authorize: Schema.Struct({
    profileId: Schema.String,
    url: Schema.String,
    authorizationPath: Schema.String,
    expiresAt: Schema.String,
  }),
  discord_oauth_profile_list: Schema.Array(OAuthProfileMetadataSchema),
  discord_oauth_profile_get: OAuthProfileMetadataSchema,
  discord_oauth_profile_revoke: Schema.Null,
  discord_workflow_list: Schema.Array(WorkflowMetadataSchema),
  discord_workflow_get: WorkflowDetailsSchema,
  discord_workflow_create: Schema.Struct({ id: Schema.String, revision: Schema.Number }),
  discord_workflow_update_draft: Schema.Union([
    Schema.Struct({ created: Schema.Literal(true), revision: Schema.Number }),
    Schema.Struct({ updated: Schema.Literal(true), revision: Schema.Number }),
  ]),
  discord_workflow_validate: WorkflowDetailsSchema,
  discord_workflow_publish: Schema.Struct({ published: Schema.Literal(true) }),
  discord_workflow_grant: Schema.Struct({ granted: Schema.Literal(true) }),
  discord_workflow_enable: Schema.Struct({ enabled: Schema.Literal(true) }),
  discord_workflow_disable: Schema.Struct({ disabled: Schema.Literal(true) }),
  discord_workflow_rollback: Schema.Struct({ rolledBack: Schema.Literal(true) }),
  discord_workflow_delete: Schema.Struct({ deleted: Schema.Literal(true) }),
  discord_workflow_invoke: Schema.Struct({
    executionId: Schema.String,
    status: Schema.Literal('queued'),
  }),
  discord_workflow_execution_get: Schema.Union([
    WorkflowExecutionRowSchema,
    Schema.Struct({ missing: Schema.Literal(true) }),
  ]),
  discord_workflow_executions_tail: Schema.Array(WorkflowExecutionTailRowSchema),
  discord_events_tail: Schema.Array(
    Schema.Union([WorkflowEventRowSchema, ComponentEventRowSchema]),
  ),
}

/**
 * Every local high-level tool must opt into a named output contract. Dynamic
 * raw dispatch remains JSON-valued because its selected operation is known only
 * at call time; fixed Discord calls supply their pinned operation schema.
 */
const outputDataSchemaForTool = (name: string): Schema.Top => {
  if (
    name === 'discord_api_read' ||
    name === 'discord_api_write' ||
    name === 'discord_api_destructive' ||
    name === 'discord_api_admin'
  ) {
    return JsonValueSchema
  }
  const schema = customOutputDataSchemas[name]
  if (!schema) {
    throw new Error(`MCP tool ${name} must declare an explicit output data schema`)
  }
  return schema
}

const scopeForRisk = (risk: OperationRisk): Scope =>
  risk === 'read'
    ? 'mcp:read'
    : risk === 'destructive'
      ? 'mcp:destructive'
      : risk === 'bot_admin'
        ? 'bot:admin'
        : 'mcp:write'

const localScopeForTool = (name: string): string => {
  const curated = curatedOperationForTool(name)
  if (curated) return scopeForRisk(curated.risk)
  const fixed: Readonly<Record<string, string>> = {
    discord_guild_get: 'mcp:read',
    discord_api_search: 'mcp:read',
    discord_api_describe: 'mcp:read',
    discord_api_read: 'mcp:read',
    discord_api_write: 'mcp:write',
    discord_api_destructive: 'mcp:destructive',
    discord_api_admin: 'bot:admin',
    discord_message_validate: 'mcp:read',
    discord_message_send: 'mcp:write',
    discord_message_edit: 'mcp:write',
    discord_webhook_execute: 'mcp:write',
    discord_modal_validate: 'mcp:read',
    discord_permissions_explain: 'server:plan',
    discord_guild_inspect: 'mcp:read',
    discord_server_snapshot: 'mcp:read',
    discord_server_blueprint_plan: 'server:plan',
    discord_server_blueprint_apply: 'server:apply',
    discord_gateway_status: 'mcp:read',
    discord_presence_set: 'bot:admin',
    discord_voice_state_set: 'bot:admin',
    discord_gateway_recent_events: 'mcp:read',
    discord_gateway_wait_for_event: 'mcp:read',
  }
  if (name === 'discord_api_preview') {
    return 'one of mcp:read, mcp:write, mcp:destructive, or bot:admin, selected by operation risk'
  }
  if (name === 'discord_message_pin_update') {
    return 'mcp:write for pin; mcp:destructive for unpin'
  }
  if (name === 'discord_message_reaction_update') {
    return 'mcp:write for add/remove; mcp:destructive for clearEmoji/clearAll'
  }
  if (name === 'discord_thread_member_update') {
    return 'mcp:write for join/leave/add; mcp:destructive for remove'
  }
  return fixed[name] ?? 'declared by the selected tool'
}

const discordPermissionsForOperation = (operationId: string): string => {
  if (
    operationId === 'create_guild_channel' ||
    operationId === 'bulk_update_guild_channels' ||
    operationId === 'set_channel_permission_overwrite' ||
    operationId === 'delete_channel_permission_overwrite'
  ) {
    return 'MANAGE_CHANNELS'
  }
  if (operationId === 'update_channel' || operationId === 'delete_channel') {
    return 'MANAGE_CHANNELS for guild channels; thread ownership and thread permissions can also apply'
  }
  if (operationId === 'get_message' || operationId === 'list_messages') {
    return 'VIEW_CHANNEL and READ_MESSAGE_HISTORY'
  }
  if (operationId === 'delete_message' || operationId === 'bulk_delete_messages') {
    return 'MANAGE_MESSAGES, except a bot may delete its own message'
  }
  if (operationId === 'crosspost_message') return 'VIEW_CHANNEL, SEND_MESSAGES, and MANAGE_MESSAGES'
  if (operationId === 'create_thread_from_message' || operationId === 'create_thread') {
    return 'VIEW_CHANNEL, SEND_MESSAGES, and the applicable CREATE_*_THREADS permission'
  }
  if (operationId === 'list_guild_roles') {
    return 'none beyond access to the guild'
  }
  if (
    operationId === 'create_guild_role' ||
    operationId === 'update_guild_role' ||
    operationId === 'delete_guild_role' ||
    operationId === 'bulk_update_guild_roles' ||
    operationId === 'add_guild_member_role' ||
    operationId === 'delete_guild_member_role'
  ) {
    return 'MANAGE_ROLES plus Discord role-hierarchy eligibility'
  }
  if (operationId === 'delete_guild_member') return 'KICK_MEMBERS plus hierarchy eligibility'
  if (operationId === 'ban_user_from_guild' || operationId === 'unban_user_from_guild') {
    return 'BAN_MEMBERS plus hierarchy eligibility'
  }
  if (operationId === 'list_guild_bans') return 'BAN_MEMBERS'
  if (operationId === 'update_guild_member') {
    return 'field-dependent: MODERATE_MEMBERS, MANAGE_NICKNAMES, MOVE_MEMBERS, MUTE_MEMBERS, or DEAFEN_MEMBERS; hierarchy also applies'
  }
  if (operationId.includes('auto_moderation')) return 'MANAGE_GUILD'
  if (operationId === 'list_guild_audit_log_entries') return 'VIEW_AUDIT_LOG'
  if (operationId.includes('webhook'))
    return 'MANAGE_WEBHOOKS, unless executing with the webhook token'
  if (operationId === 'create_channel_invite') return 'CREATE_INSTANT_INVITE'
  if (operationId === 'list_guild_invites') return 'MANAGE_GUILD'
  if (operationId === 'invite_revoke') return 'MANAGE_CHANNELS for the invite channel'
  if (operationId === 'list_guild_scheduled_events') return 'none beyond access to the guild'
  if (operationId.includes('scheduled_event')) return 'CREATE_EVENTS or MANAGE_EVENTS'
  if (operationId === 'list_guild_emojis' || operationId === 'list_guild_stickers') {
    return 'none beyond access to the guild'
  }
  if (operationId === 'create_guild_emoji' || operationId === 'create_guild_sticker') {
    return 'CREATE_GUILD_EXPRESSIONS'
  }
  if (operationId === 'delete_guild_emoji' || operationId === 'delete_guild_sticker') {
    return 'MANAGE_GUILD_EXPRESSIONS'
  }
  if (operationId === 'list_guild_channels' || operationId === 'get_channel') {
    return 'VIEW_CHANNEL for non-public target channels'
  }
  if (operationId.includes('application_command')) {
    return 'none at guild level; the application must be authorized to manage its own commands'
  }
  return 'target-dependent; the pinned Discord OpenAPI does not declare a permission for this operation'
}

const localOnlyTool = (name: string): boolean =>
  name.startsWith('discord_message_template_') ||
  name.startsWith('discord_blob_') ||
  name.startsWith('discord_workflow_') ||
  name.startsWith('discord_oauth_profile_') ||
  name.startsWith('discord_audit_') ||
  name === 'discord_events_tail' ||
  name === 'discord_message_validate' ||
  name === 'discord_modal_validate' ||
  name === 'discord_permissions_explain' ||
  (name.startsWith('discord_server_blueprint_') && name !== 'discord_server_blueprint_apply') ||
  name.startsWith('discord_gateway_') ||
  name === 'discord_presence_set' ||
  name === 'discord_voice_state_set'

const mutualExclusionForTool = (name: string): string | undefined => {
  if (name === 'discord_channel_create') {
    return 'Mutual exclusion: fields from different channel kinds cannot be mixed.'
  }
  if (name === 'discord_channel_overwrite_set') {
    return 'Mutual exclusion: a permission cannot appear in both allow and deny.'
  }
  if (name === 'discord_member_timeout') {
    return 'Mutual exclusion: choose exactly one of durationSeconds, until, or clear.'
  }
  if (name === 'discord_message_pin_update') {
    return 'Mutual exclusion: action selects pin or unpin; the operation is never inferred.'
  }
  if (name === 'discord_message_reaction_update' || name === 'discord_thread_member_update') {
    return 'Mutual exclusion: action selects exactly one operation and its action-specific fields.'
  }
  return undefined
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

const enrichToolDescription = (
  name: string,
  description: string,
  annotations: { readonly destructiveHint?: boolean; readonly openWorldHint?: boolean } | undefined,
): string => {
  const sentences = [description.trim()]
  if (!description.includes('Required local scope:')) {
    sentences.push(`Required local scope: ${localScopeForTool(name)}.`)
  }
  const operation = curatedOperationForTool(name)
  if (operation) {
    sentences.push(
      `Required Discord guild permissions (bot auth): ${discordPermissionsForOperation(operation.operationId)}.`,
    )
    if (operation.oauthScopes.length > 0) {
      sentences.push(
        `Required OAuth scope(s), when using OAuth2: ${operation.oauthScopes.join(', ')}.`,
      )
    }
  } else if (localOnlyTool(name)) {
    sentences.push(
      'Required Discord guild permissions: none; this operation is local or Gateway-only.',
    )
  } else if (name.startsWith('discord_api_')) {
    sentences.push(
      'Required Discord permissions and OAuth scopes are operation-specific; call discord_api_describe before dispatch.',
    )
  } else if (name === 'discord_server_blueprint_apply') {
    sentences.push(
      'Required Discord guild permissions: MANAGE_ROLES, MANAGE_CHANNELS, and/or MANAGE_GUILD according to the planned actions; hierarchy applies.',
    )
  } else if (name === 'discord_message_send' || name === 'discord_message_edit') {
    sentences.push(
      'Required Discord guild permissions: VIEW_CHANNEL and SEND_MESSAGES; thread and attachment permissions apply when used.',
    )
  } else if (name === 'discord_webhook_execute') {
    sentences.push(
      'Required Discord guild permissions: none when the named webhook token is valid.',
    )
  } else {
    sentences.push(
      'Required Discord guild permissions: target-dependent; call discord_permissions_explain after a Discord 403.',
    )
  }
  const exclusion = mutualExclusionForTool(name)
  if (exclusion) sentences.push(exclusion)
  if (annotations?.destructiveHint === true) {
    sentences.push(
      'Destructive behavior: this can remove or replace Discord or persisted state; guarded Discord calls require an exact unexpired preview token.',
    )
  }
  if (annotations?.openWorldHint === true) {
    sentences.push(
      name === 'discord_presence_set' || name === 'discord_voice_state_set'
        ? 'On a Gateway failure, call discord_gateway_status; do not retry unchanged arguments.'
        : 'On Discord 403, call discord_permissions_explain; do not retry unchanged arguments.',
    )
  }
  return sentences.join(' ')
}

const titleFor = (name: string): string =>
  name
    .replace(/^discord_/, '')
    .split('_')
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ')
