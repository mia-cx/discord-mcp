import { Schema } from 'effect'

/**
 * `credential` operations (OAuth exchange/refresh/revocation, webhook and interaction tokens) are
 * handled only by dedicated services and are never exposed as a tool.
 */
export const RiskClass = Schema.Literals([
  'read',
  'write',
  'destructive',
  'bot_admin',
  'credential',
])
export type RiskClass = typeof RiskClass.Type

export const AuthMode = Schema.Literals(['bot', 'oauth2', 'webhook', 'interaction'])
export type AuthMode = typeof AuthMode.Type

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/**
 * Coarse grouping used for search filters, `RateGuard` accounting, and workflow grants.
 *
 * Deliberately smaller than Discord's resource list: a family is a thing an operator asks about,
 * not a REST noun.
 */
export type OperationFamily =
  | 'application'
  | 'audit'
  | 'automod'
  | 'channel'
  | 'emoji'
  | 'entitlement'
  | 'gateway'
  | 'guild'
  | 'interaction'
  | 'invite'
  | 'lobby'
  | 'member'
  | 'message'
  | 'moderation'
  | 'oauth'
  | 'poll'
  | 'role'
  | 'scheduled-event'
  | 'soundboard'
  | 'stage'
  | 'sticker'
  | 'thread'
  | 'user'
  | 'voice'
  | 'webhook'

/** How a list endpoint pages, which decides what a cursor means for that operation. */
export type PaginationStyle = 'none' | 'snowflake' | 'offset' | 'token'

export interface OperationEntry {
  readonly operationId: string
  readonly method: HttpMethod
  /** Template with `{param}` placeholders, exactly as vendored. */
  readonly path: string
  /**
   * Every `{param}` in the path, merged from the path item **and** the operation.
   *
   * 130 of 150 paths carry their parameters on the path item, and operation-level parameters are
   * query-only. Reading `op.parameters` alone yields zero path parameters for those, which is the
   * single easiest thing in this project to get wrong; `spec:check` fails if any `{param}` in a
   * template is missing from this list.
   */
  readonly pathParams: ReadonlyArray<string>
  /**
   * Every query key Discord accepts here.
   *
   * Needed in full because unknown keys are *rejected*: Discord silently ignores parameters it
   * does not know, so a typo would otherwise return a confidently wrong answer.
   */
  readonly queryParams: ReadonlyArray<string>
  /** Usually empty. Query parameters Discord requires. */
  readonly requiredQuery: ReadonlyArray<string>
  readonly requestBody?: {
    readonly required: boolean
    readonly contentTypes: ReadonlyArray<string>
    /** Name in the lazily loaded schema map, not the schema itself. */
    readonly schemaName?: string
    readonly multipart: boolean
  }
  readonly responseSchemaName?: string
  /** Every auth mode that can execute this operation. Never empty; `spec:check` enforces it. */
  readonly auth: ReadonlyArray<AuthMode>
  /** OAuth2 scopes Discord documents for this operation, when it documents any. */
  readonly oauthScopes: ReadonlyArray<string>
  readonly risk: RiskClass
  readonly family: OperationFamily
  readonly pagination: PaginationStyle
  /** Whether Discord honours `X-Audit-Log-Reason` here. */
  readonly auditLogReason: boolean
  /** Parameters that must resolve through a secret reference, never a plain MCP string. */
  readonly sensitiveParams: ReadonlyArray<string>
  /** Set when the project overrode a derived value; carries the reason. */
  readonly override?: { readonly fields: ReadonlyArray<string>; readonly reason: string }
  /**
   * Indices into {@link CatalogIndex.tokenTable}.
   *
   * 3117 token instances draw from 243 distinct strings, so interning them is most of the
   * difference between a static index that costs something at every process start and one that
   * does not.
   */
  readonly tokens: ReadonlyArray<number>
  /** The curated tool that covers this operation, when one exists. */
  readonly curatedTool?: string
}

export interface CatalogIndex {
  /** Shared string table for {@link OperationEntry.tokens}. */
  readonly tokenTable: ReadonlyArray<string>
  readonly source: {
    readonly commit: string
    readonly sha256: string
    readonly apiVersion: string
    readonly counts: Record<string, number>
  }
  readonly operations: ReadonlyArray<OperationEntry>
}

/**
 * The wire form of an operation in the generated file: a positional tuple, not an object.
 *
 * Repeating sixteen key names across 242 operations costs about 37 KiB — a third of the index —
 * to express nothing. The generated file is machine-written and machine-read, so it pays that
 * cost in a `PACKED_FIELDS` comment once instead of per operation. {@link unpackOperation}
 * restores the named shape at module load, so nothing downstream sees the tuple.
 */
export type PackedOperation = readonly [
  operationId: string,
  method: HttpMethod,
  path: string,
  pathParams: ReadonlyArray<string>,
  queryParams: ReadonlyArray<string>,
  requiredQuery: ReadonlyArray<string>,
  requestBody: NonNullable<OperationEntry['requestBody']> | 0,
  responseSchemaName: string | 0,
  auth: ReadonlyArray<AuthMode>,
  oauthScopes: ReadonlyArray<string>,
  risk: RiskClass,
  family: OperationFamily,
  pagination: PaginationStyle,
  auditLogReason: 0 | 1,
  sensitiveParams: ReadonlyArray<string>,
  tokens: ReadonlyArray<number>,
  curatedTool: string | 0,
  override: NonNullable<OperationEntry['override']> | 0,
]

export const unpackOperation = (p: PackedOperation): OperationEntry => ({
  operationId: p[0],
  method: p[1],
  path: p[2],
  pathParams: p[3],
  queryParams: p[4],
  requiredQuery: p[5],
  ...(p[6] === 0 ? {} : { requestBody: p[6] }),
  ...(p[7] === 0 ? {} : { responseSchemaName: p[7] }),
  auth: p[8],
  oauthScopes: p[9],
  risk: p[10],
  family: p[11],
  pagination: p[12],
  auditLogReason: p[13] === 1,
  sensitiveParams: p[14],
  tokens: p[15],
  ...(p[16] === 0 ? {} : { curatedTool: p[16] }),
  ...(p[17] === 0 ? {} : { override: p[17] }),
})

/**
 * The lazily loaded tier: every component schema with `$ref` rewritten to `#/$defs/`, plus a
 * per-operation transitive closure expressed as name lists.
 *
 * Discord's schemas are recursive — `Channel.parent`, `Message.referenced_message`, component
 * trees — so they stay as a `$ref` graph with a scoped `$defs` closure rather than being
 * dereferenced. Full inlining would not terminate.
 */
export interface SchemaMap {
  readonly definitions: Record<string, unknown>
  readonly closures: Record<string, ReadonlyArray<string>>
  /** Prose and parameter schemas, needed only by `discord_api_describe`. */
  readonly details: Record<string, OperationDetail>
}

export interface OperationDetail {
  readonly description?: string
  /** A JSON request body the spec declares inline rather than as a named component schema. */
  readonly bodySchema?: Record<string, unknown>
  /** Query parameter JSON Schemas, keyed by parameter name. */
  readonly querySchemas: Record<string, unknown>
  readonly paramDescriptions: Record<string, string>
}
