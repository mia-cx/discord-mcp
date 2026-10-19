import { defineTool, type RiskClass, ValidationError } from '@discord-mcp/core'
import { Effect, Schema } from 'effect'
import { OperationCatalog } from '../catalog/service.ts'
import type { OperationEntry } from '../catalog/types.ts'
import {
  buildRoute,
  validateAuditLogReason,
  validateBody,
  validatePathParams,
  validateQueryParams,
} from '../dispatch/validate.ts'
import { DiscordRest } from '../rest.ts'
import { guildGet } from './guild-get.ts'
import { permissionsExplain } from './permissions-tool.ts'

const callable = (operation: OperationEntry) =>
  operation.auth.includes('bot') && operation.risk !== 'credential'

const operationFor = (operationId: string) =>
  Effect.gen(function* () {
    const catalog = yield* OperationCatalog
    const operation = yield* catalog.get(operationId)
    if (callable(operation)) return operation
    return yield* Effect.fail(
      new ValidationError({
        message: `${operationId} is not available through the bot-token relay.`,
        issues: ['operationId: choose a bot-authenticated operation with discord_api_search.'],
      }),
    )
  })

const search = defineTool({
  name: 'discord_api_search',
  title: 'Search bot-authenticated Discord API operations',
  description:
    'Find operations by words, HTTP method, or family. Read discord_api_describe for the exact parameters before calling an unfamiliar operation.',
  toolset: 'api',
  risk: 'read',
  scopes: [],
  annotations: { readOnlyHint: true, openWorldHint: false },
  input: Schema.Struct({
    query: Schema.optionalKey(Schema.String),
    method: Schema.optionalKey(Schema.Literals(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])),
    family: Schema.optionalKey(Schema.String),
    limit: Schema.optionalKey(
      Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
    ),
    cursor: Schema.optionalKey(Schema.String),
  }),
  handler: (args: {
    query?: string
    method?: OperationEntry['method']
    family?: string
    limit?: number
    cursor?: string
  }) =>
    Effect.map(OperationCatalog, (catalog) => {
      const { family, ...filters } = args
      const page = catalog.search({
        ...filters,
        auth: 'bot',
        limit: args.limit ?? 20,
        ...(family === undefined ? {} : { family: family as OperationEntry['family'] }),
      })
      return {
        results: page.hits
          .filter(({ operation }) => callable(operation))
          .map(({ operation }) => ({
            operationId: operation.operationId,
            method: operation.method,
            path: operation.path,
            family: operation.family,
            risk: operation.risk,
          })),
        ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
      }
    }),
})

const describe = defineTool({
  name: 'discord_api_describe',
  title: 'Describe a Discord API operation',
  description:
    'Read the path and query parameters, request body schema, risk class, and dispatcher for one bot-authenticated operation.',
  toolset: 'api',
  risk: 'read',
  scopes: [],
  annotations: { readOnlyHint: true, openWorldHint: false },
  input: Schema.Struct({ operationId: Schema.String }),
  handler: (args: { operationId: string }) =>
    Effect.gen(function* () {
      const operation = yield* operationFor(args.operationId)
      const catalog = yield* OperationCatalog
      const schemas = yield* catalog.schemas
      return {
        operationId: operation.operationId,
        method: operation.method,
        path: operation.path,
        pathParams: operation.pathParams,
        queryParams: operation.queryParams,
        requiredQuery: operation.requiredQuery,
        querySchemas: schemas.details[operation.operationId]?.querySchemas ?? {},
        requestBody: operation.requestBody ?? null,
        bodySchema: (yield* catalog.bodySchema(operation.operationId)) ?? null,
        auditLogReason: operation.auditLogReason,
        risk: operation.risk,
        tool: `discord_api_${operation.risk === 'bot_admin' ? 'admin' : operation.risk}`,
      }
    }),
})

const CallInput = Schema.Struct({
  operationId: Schema.String,
  path: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  query: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  body: Schema.optionalKey(Schema.Unknown),
  auditLogReason: Schema.optionalKey(Schema.String),
})

const dispatcher = (risk: Exclude<RiskClass, 'credential'>) =>
  defineTool({
    name: `discord_api_${risk === 'bot_admin' ? 'admin' : risk}`,
    title: `Execute a ${risk} Discord API operation`,
    description: `Execute a cataloged ${risk} operation with this request's bot token. Discord enforces the bot's permissions. ${risk === 'destructive' ? 'These operations can permanently delete Discord resources.' : 'Read discord_api_describe for the required parameters.'}`,
    toolset: 'api',
    risk,
    scopes: [],
    annotations: {
      readOnlyHint: risk === 'read',
      destructiveHint: risk === 'destructive' || risk === 'bot_admin',
      openWorldHint: true,
    },
    input: CallInput,
    handler: (args: typeof CallInput.Type) =>
      Effect.gen(function* () {
        const operation = yield* operationFor(args.operationId)
        if (operation.risk !== risk) {
          return yield* Effect.fail(
            new ValidationError({
              message: `${operation.operationId} is classified ${operation.risk}.`,
              issues: [
                `operationId: use discord_api_${operation.risk === 'bot_admin' ? 'admin' : operation.risk}.`,
              ],
            }),
          )
        }
        const catalog = yield* OperationCatalog
        const path = yield* validatePathParams(operation, args.path)
        const query = yield* validateQueryParams(operation, args.query)
        yield* validateAuditLogReason(operation, args.auditLogReason)
        yield* validateBody(operation, args.body, yield* catalog.bodySchema(operation.operationId))

        const rest = yield* DiscordRest
        return yield* rest.request({
          method: operation.method,
          route: buildRoute(operation, path),
          operationFamily: operation.family,
          ...(query.size === 0 ? {} : { query }),
          ...(args.body === undefined ? {} : { body: args.body }),
          ...(args.auditLogReason === undefined ? {} : { auditLogReason: args.auditLogReason }),
        })
      }),
  })

/** Bot-only tools with no profiles, preview-token store, database, or background processes. */
export const relayTools = [
  guildGet,
  permissionsExplain,
  search,
  describe,
  dispatcher('read'),
  dispatcher('write'),
  dispatcher('destructive'),
  dispatcher('bot_admin'),
]
