import { Schema } from 'effect'
import catalogJson from './generated/catalog.json' with { type: 'json' }

export type OperationRisk = 'read' | 'write' | 'destructive' | 'bot_admin' | 'credential'
export type OperationAuth = 'bot' | 'oauth2' | 'webhook' | 'interaction'

export interface CatalogParameter {
  readonly name: string
  readonly in: 'path' | 'query' | 'header' | 'cookie'
  readonly required: boolean
  readonly schema: Readonly<Record<string, unknown>>
  readonly description?: string
  readonly sensitive: boolean
}

export interface CatalogOperation {
  readonly operationId: string
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  readonly path: string
  readonly family: string
  readonly risk: OperationRisk
  readonly auth: ReadonlyArray<OperationAuth>
  readonly oauthScopes: ReadonlyArray<string>
  readonly parameters: ReadonlyArray<CatalogParameter>
  readonly body: Readonly<Record<string, Readonly<Record<string, unknown>>>>
  readonly bodyRequired: boolean
  readonly responseBodies: Readonly<
    Record<string, Readonly<Record<string, Readonly<Record<string, unknown>>>>>
  >
  readonly schemaNames: ReadonlyArray<string>
  readonly sensitiveBodyFields: ReadonlyArray<string>
  readonly description: string
  readonly searchTokens: string
  readonly auditLogReason: boolean
  readonly botIncompatible: boolean
  readonly pagination: {
    readonly style: 'none' | 'cursor' | 'offset'
    readonly parameters: ReadonlyArray<string>
    readonly limitParameter?: string
  }
  readonly documentationUrl: string
  readonly overrides: ReadonlyArray<{
    readonly field: string
    readonly rationale: string
  }>
  readonly dispatcherExample: Readonly<Record<string, unknown>>
}

export type CatalogOperationSummary = Pick<
  CatalogOperation,
  | 'operationId'
  | 'method'
  | 'path'
  | 'family'
  | 'risk'
  | 'auth'
  | 'oauthScopes'
  | 'description'
  | 'pagination'
  | 'auditLogReason'
>

export interface CatalogSearch {
  readonly query?: string
  readonly method?: CatalogOperation['method']
  readonly family?: string
  readonly auth?: OperationAuth
  readonly risk?: OperationRisk
  readonly limit?: number
  readonly cursor?: string
}

const operations = catalogJson.operations as ReadonlyArray<CatalogOperation>
const byId = new Map(operations.map((operation) => [operation.operationId, operation]))

export const operationCatalog = {
  operationCount: catalogJson.operationCount,
  pathCount: catalogJson.pathCount,
  operations,

  get(operationId: string): CatalogOperation | undefined {
    return byId.get(operationId)
  },

  describe(operationId: string): CatalogOperation {
    const operation = byId.get(operationId)
    if (!operation) throw new OperationNotFoundError(operationId)
    return operation
  },

  search(input: CatalogSearch = {}): {
    readonly operations: ReadonlyArray<CatalogOperationSummary>
    readonly nextCursor?: string
  } {
    const limit = Math.max(1, Math.min(input.limit ?? 20, 100))
    const offset = decodeCursor(input.cursor)
    const terms = (input.query ?? '')
      .toLowerCase()
      .split(/\s+/)
      .filter((term) => term.length > 0)
    const filtered = operations.filter(
      (operation) =>
        (input.method === undefined || operation.method === input.method) &&
        (input.family === undefined || operation.family === input.family) &&
        (input.auth === undefined || operation.auth.includes(input.auth)) &&
        (input.risk === undefined || operation.risk === input.risk) &&
        terms.every((term) => operation.searchTokens.includes(term)),
    )
    const page = filtered
      .slice(offset, offset + limit)
      .map(
        ({
          operationId,
          method,
          path,
          family,
          risk,
          auth,
          oauthScopes,
          description,
          pagination,
          auditLogReason,
        }) => ({
          operationId,
          method,
          path,
          family,
          risk,
          auth,
          oauthScopes,
          description,
          pagination,
          auditLogReason,
        }),
      )
    const next = offset + page.length
    return {
      operations: page,
      ...(next < filtered.length ? { nextCursor: encodeCursor(next) } : {}),
    }
  },
} as const

export class OperationNotFoundError extends Schema.TaggedErrorClass<OperationNotFoundError>()(
  'OperationNotFoundError',
  { message: Schema.String, operationId: Schema.String },
) {
  constructor(readonly operationId: string) {
    super({
      message: `Discord operation "${operationId}" is not in the pinned catalog`,
      operationId,
    })
  }
}

const encodeCursor = (offset: number): string =>
  Buffer.from(JSON.stringify({ offset }), 'utf8').toString('base64url')

const decodeCursor = (cursor: string | undefined): number => {
  if (cursor === undefined) return 0
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      offset?: unknown
    }
    if (typeof value.offset !== 'number' || !Number.isInteger(value.offset) || value.offset < 0) {
      throw new Error('invalid offset')
    }
    return value.offset
  } catch {
    throw new Error('Invalid catalog cursor')
  }
}
