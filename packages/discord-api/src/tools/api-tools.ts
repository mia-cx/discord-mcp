import { defineTool, type RiskClass, Snowflake } from '@discord-mcp/core'
import { Effect, Schema } from 'effect'
import { OperationCatalog } from '../catalog/service.ts'
import { docsUrlFor, type OperationEntry } from '../catalog/types.ts'
import { type AuthProfiles, dispatch, preview } from '../dispatch/dispatcher.ts'
import type { PreviewTokens } from '../dispatch/preview.ts'
import type { DiscordRest } from '../rest.ts'

const HttpMethodSchema = Schema.Literals(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
const RiskSchema = Schema.Literals(['read', 'write', 'destructive', 'bot_admin', 'credential'])
const AuthSchema = Schema.Literals(['bot', 'oauth2', 'webhook', 'interaction'])

const DEFAULT_SEARCH_LIMIT = 20
const MAX_SEARCH_LIMIT = 100

// ------------------------------------------------------------------ search

const SearchInput = Schema.Struct({
  query: Schema.optionalKey(
    Schema.String.annotate({
      description:
        'Plain language works: "kick a member", "post a message with buttons". Searches a maintained gloss of synonyms, because Discord\'s spec supplies no operation summaries.',
    }),
  ),
  method: Schema.optionalKey(HttpMethodSchema),
  family: Schema.optionalKey(
    Schema.String.annotate({ description: 'e.g. guild, channel, message, role, member.' }),
  ),
  auth: Schema.optionalKey(AuthSchema),
  risk: Schema.optionalKey(RiskSchema),
  limit: Schema.optionalKey(
    Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: MAX_SEARCH_LIMIT }))),
  ),
  cursor: Schema.optionalKey(Schema.String),
})

export const apiSearch = defineTool<typeof SearchInput.Type, unknown, OperationCatalog>({
  name: 'discord_api_search',
  title: 'Search the Discord API catalog',
  description: [
    'Find Discord HTTP API operations by plain-language description, method, family, auth mode, or risk class.',
    '',
    'Start here when no curated discord_* tool covers what you need. Results name the curated tool',
    'when one exists — prefer it, since curated tools have stricter schemas and better errors.',
    'Follow up with discord_api_describe before calling an unfamiliar operation.',
  ].join('\n'),
  toolset: 'api',
  risk: 'read',
  scopes: ['mcp:read'],
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: SearchInput,
  handler: (args) =>
    Effect.gen(function* () {
      const catalog = yield* OperationCatalog
      const { hits, nextCursor } = catalog.search({
        ...(args.query === undefined ? {} : { query: args.query }),
        ...(args.method === undefined ? {} : { method: args.method }),
        ...(args.family === undefined ? {} : { family: args.family as OperationEntry['family'] }),
        ...(args.auth === undefined ? {} : { auth: args.auth }),
        ...(args.risk === undefined ? {} : { risk: args.risk }),
        limit: args.limit ?? DEFAULT_SEARCH_LIMIT,
        ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
      })

      return {
        results: hits.map(({ operation }) => ({
          operationId: operation.operationId,
          method: operation.method,
          path: operation.path,
          risk: operation.risk,
          family: operation.family,
          auth: operation.auth,
          ...(operation.curatedTool === undefined
            ? {}
            : { preferCuratedTool: operation.curatedTool }),
        })),
        ...(nextCursor === undefined ? {} : { nextCursor }),
        totalReturned: hits.length,
      }
    }),
})

// ------------------------------------------------------------------ describe

const DescribeInput = Schema.Struct({
  operationId: Schema.String.annotate({
    description: 'Exact operation ID from discord_api_search.',
  }),
})

export const apiDescribe = defineTool<typeof DescribeInput.Type, unknown, OperationCatalog>({
  name: 'discord_api_describe',
  title: 'Describe a Discord API operation',
  description: [
    'Full detail for one operation: parameters, request body schema with its transitive $defs,',
    'auth modes, required OAuth scopes, risk class, pagination style, audit-log support, and a',
    'ready-to-use dispatcher example.',
    '',
    'Call this before dispatching an operation you have not used before. It costs no Discord request.',
  ].join('\n'),
  toolset: 'api',
  risk: 'read',
  scopes: ['mcp:read'],
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: DescribeInput,
  handler: (args) =>
    Effect.gen(function* () {
      const catalog = yield* OperationCatalog
      const op = yield* catalog.get(args.operationId)
      const schemas = yield* catalog.schemas
      const detail = schemas.details[op.operationId]
      const bodySchema = yield* catalog.bodySchema(op.operationId)

      const dispatcherFor: Record<RiskClass, string> = {
        read: 'discord_api_read',
        write: 'discord_api_write',
        destructive: 'discord_api_destructive',
        bot_admin: 'discord_api_admin',
        credential: '(not callable — use the dedicated OAuth or secret-management flow)',
      }

      return {
        operationId: op.operationId,
        method: op.method,
        path: op.path,
        description: detail?.description ?? null,
        risk: op.risk,
        family: op.family,
        auth: op.auth,
        oauthScopes: op.oauthScopes,
        pathParams: op.pathParams.map((name) => ({
          name,
          required: true,
          isSnowflake: name.endsWith('_id'),
          description: detail?.paramDescriptions[name] ?? null,
        })),
        queryParams: op.queryParams.map((name) => ({
          name,
          required: op.requiredQuery.includes(name),
          schema: detail?.querySchemas[name] ?? null,
          description: detail?.paramDescriptions[name] ?? null,
        })),
        requestBody:
          op.requestBody === undefined ? null : { ...op.requestBody, schema: bodySchema ?? null },
        pagination: op.pagination,
        auditLogReason: op.auditLogReason,
        sensitiveParams: op.sensitiveParams,
        docsUrl: docsUrlFor(op),
        ...(op.curatedTool === undefined ? {} : { preferCuratedTool: op.curatedTool }),
        ...(op.override === undefined ? {} : { projectOverride: op.override }),
        example: {
          tool: dispatcherFor[op.risk],
          arguments: {
            operationId: op.operationId,
            authProfile: op.auth.includes('bot') ? 'bot' : '<an OAuth2 profile name>',
            ...(op.pathParams.length === 0
              ? {}
              : { path: Object.fromEntries(op.pathParams.map((p) => [p, '<id>'])) }),
            ...(op.requestBody === undefined ? {} : { body: {} }),
          },
          ...(op.risk === 'destructive' || op.risk === 'bot_admin'
            ? {
                note: 'Call discord_api_preview with these same arguments first and pass its previewToken.',
              }
            : {}),
        },
      }
    }),
})

// ------------------------------------------------------------------ dispatchers

const DispatchInput = Schema.Struct({
  operationId: Schema.String,
  authProfile: Schema.optionalKey(
    Schema.String.annotate({
      description: 'Defaults to "bot". Name of a Discord OAuth2 profile otherwise.',
    }),
  ),
  path: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.String).annotate({
      description: 'Path template parameters, e.g. { "guild_id": "123456789012345678" }.',
    }),
  ),
  query: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  body: Schema.optionalKey(Schema.Unknown),
  auditLogReason: Schema.optionalKey(
    Schema.String.annotate({ description: 'Recorded in the guild audit log. Say why, not what.' }),
  ),
  previewToken: Schema.optionalKey(Schema.String),
})

const PreviewInput = Schema.Struct({
  operationId: Schema.String,
  authProfile: Schema.optionalKey(Schema.String),
  path: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  query: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  body: Schema.optionalKey(Schema.Unknown),
  auditLogReason: Schema.optionalKey(Schema.String),
})

type DispatcherDeps = OperationCatalog | DiscordRest | PreviewTokens | AuthProfiles

const makeDispatcher = (spec: {
  name: string
  title: string
  description: ReadonlyArray<string>
  allowed: ReadonlyArray<RiskClass>
  requirePreviewToken: boolean
  scopes: ReadonlyArray<'mcp:read' | 'mcp:write' | 'mcp:destructive' | 'bot:admin'>
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean }
}) =>
  defineTool<typeof DispatchInput.Type, unknown, DispatcherDeps>({
    name: spec.name,
    title: spec.title,
    description: spec.description.join('\n'),
    toolset: 'api',
    risk: spec.allowed[0] ?? 'read',
    scopes: spec.scopes,
    annotations: { ...spec.annotations, openWorldHint: true },
    input: DispatchInput,
    handler: (args) =>
      dispatch(
        {
          operationId: args.operationId,
          authProfile: args.authProfile ?? 'bot',
          ...(args.path === undefined ? {} : { path: args.path }),
          ...(args.query === undefined ? {} : { query: args.query }),
          ...(args.body === undefined ? {} : { body: args.body }),
          ...(args.auditLogReason === undefined ? {} : { auditLogReason: args.auditLogReason }),
          ...(args.previewToken === undefined ? {} : { previewToken: args.previewToken }),
        },
        { allowed: spec.allowed, requirePreviewToken: spec.requirePreviewToken },
      ),
  })

export const apiPreview = defineTool<typeof PreviewInput.Type, unknown, DispatcherDeps>({
  name: 'discord_api_preview',
  title: 'Preview a destructive or administrative Discord call',
  description: [
    'Resolve and validate a call without performing it, and return a preview token bound to it.',
    '',
    'Required before discord_api_destructive and discord_api_admin. The token expires after 60',
    'seconds and binds the principal, operation, arguments, auth profile, and resolved targets, so',
    'it authorises exactly the call it described and nothing else.',
    'Show the user what this reports before executing.',
  ].join('\n'),
  toolset: 'api',
  risk: 'read',
  scopes: ['mcp:read'],
  annotations: { readOnlyHint: true, openWorldHint: false },
  input: PreviewInput,
  handler: (args) =>
    preview({
      operationId: args.operationId,
      authProfile: args.authProfile ?? 'bot',
      ...(args.path === undefined ? {} : { path: args.path }),
      ...(args.query === undefined ? {} : { query: args.query }),
      ...(args.body === undefined ? {} : { body: args.body }),
      ...(args.auditLogReason === undefined ? {} : { auditLogReason: args.auditLogReason }),
    }),
})

export const apiRead = makeDispatcher({
  name: 'discord_api_read',
  title: 'Call a read-only Discord API operation',
  description: [
    'Execute any cataloged read operation. Accepts only operations classified `read`, so no',
    'mutation can be reached through this tool whatever arguments are supplied.',
    '',
    'Prefer a curated discord_* tool when one exists. Arguments are validated locally first:',
    'unknown query keys, malformed IDs, and missing path parameters fail without a Discord request.',
  ],
  allowed: ['read'],
  requirePreviewToken: false,
  scopes: ['mcp:read'],
  annotations: { readOnlyHint: true, idempotentHint: true },
})

export const apiWrite = makeDispatcher({
  name: 'discord_api_write',
  title: 'Call a Discord API operation that creates or updates',
  description: [
    'Execute any cataloged write operation — creates and updates that are normally reversible.',
    'Deletes, bans, kicks, prunes, and bulk changes are not reachable here; they are',
    'discord_api_destructive and require a preview token.',
    '',
    'Supply auditLogReason on guild mutations so the change is attributable later.',
  ],
  allowed: ['write'],
  requirePreviewToken: false,
  scopes: ['mcp:write'],
  annotations: { destructiveHint: false },
})

export const apiDestructive = makeDispatcher({
  name: 'discord_api_destructive',
  title: 'Call a destructive Discord API operation',
  description: [
    'Execute a cataloged destructive operation: deletes, bans, kicks, prunes, bulk changes.',
    'Discord provides no undo for any of these.',
    '',
    'Requires the mcp:destructive scope and an unexpired preview token from discord_api_preview',
    'bound to this exact call. Show the user what the preview reports and get their agreement first.',
  ],
  allowed: ['destructive'],
  requirePreviewToken: true,
  scopes: ['mcp:destructive'],
  annotations: { destructiveHint: true, idempotentHint: false },
})

export const apiAdmin = makeDispatcher({
  name: 'discord_api_admin',
  title: 'Call a bot-administration Discord API operation',
  description: [
    'Execute a cataloged bot_admin operation: bot identity, application metadata, command',
    'registration, privileged configuration.',
    '',
    'Requires the bot:admin scope and an unexpired preview token. These change how the bot behaves',
    'everywhere it is installed, not just in one guild.',
  ],
  allowed: ['bot_admin'],
  requirePreviewToken: true,
  scopes: ['bot:admin'],
  annotations: { destructiveHint: true },
})

export const apiTools = [
  apiSearch,
  apiDescribe,
  apiPreview,
  apiRead,
  apiWrite,
  apiDestructive,
  apiAdmin,
]

/** Re-exported so the application layer can prove it provides everything the tools require. */
export type { DispatcherDeps }
export { Snowflake }
