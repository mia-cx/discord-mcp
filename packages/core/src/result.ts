import { Schema } from 'effect'

export interface ResultMeta {
  readonly requestId: string
  readonly operationId?: string
  readonly authProfile: string
  readonly truncated: boolean
  readonly pagination?: {
    readonly hasMore: boolean
    readonly nextCursor?: string
  }
}

export type DiscordToolResult<A> =
  | {
      readonly ok: true
      readonly data: A
      readonly meta: ResultMeta
      readonly warnings: ReadonlyArray<string>
    }
  | {
      readonly ok: false
      readonly error: {
        readonly code: string
        readonly message: string
        readonly retryable: boolean
        readonly httpStatus?: number
        readonly discordCode?: number
        readonly retryAfterMs?: number
        readonly missingPermission?: string
        readonly suggestion?: string
      }
      readonly meta: { readonly requestId: string }
    }

export const ResultMetaSchema = Schema.Struct({
  requestId: Schema.String,
  operationId: Schema.optionalKey(Schema.String),
  authProfile: Schema.String,
  pagination: Schema.optionalKey(
    Schema.Struct({
      hasMore: Schema.Boolean,
      nextCursor: Schema.optionalKey(Schema.String),
    }),
  ),
  truncated: Schema.Boolean,
})

export const SuccessResultMetaSchema = Schema.Struct({
  requestId: Schema.String,
  operationId: Schema.optionalKey(Schema.String),
  authProfile: Schema.String,
  pagination: Schema.optionalKey(
    Schema.Struct({
      hasMore: Schema.Boolean,
      nextCursor: Schema.optionalKey(Schema.String),
    }),
  ),
  truncated: Schema.Boolean,
})

export const ResultErrorSchema = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  retryable: Schema.Boolean,
  httpStatus: Schema.optionalKey(Schema.Number),
  discordCode: Schema.optionalKey(Schema.Number),
  retryAfterMs: Schema.optionalKey(Schema.Number),
  missingPermission: Schema.optionalKey(Schema.String),
  suggestion: Schema.optionalKey(Schema.String),
})

export const TruncatedResultDataSchema = Schema.Struct({
  truncated: Schema.Literal(true),
  preview: Schema.String,
  continuation: Schema.String,
})

/** JSON-compatible value without the unconstrained semantics of Schema.Unknown. */
export const JsonValueSchema: Schema.Codec<unknown, unknown> = Schema.suspend(() =>
  Schema.Union([
    Schema.Null,
    Schema.Boolean,
    Schema.Finite,
    Schema.String,
    Schema.Array(JsonValueSchema),
    Schema.Record(Schema.String, JsonValueSchema),
  ]),
).annotate({ identifier: 'DiscordMcpJsonValue' })

/**
 * The structured result envelope shared by every MCP tool. Supplying a concrete
 * data schema gives the SDK strict output validation while still admitting the
 * bounded truncation representation produced by the transport boundary.
 */
export const DiscordToolResultSchema = (
  data: Schema.ConstraintDecoder<unknown, never> = JsonValueSchema as Schema.ConstraintDecoder<
    unknown,
    never
  >,
) =>
  Schema.Union([
    Schema.Struct({
      ok: Schema.Literal(true),
      data: Schema.Union([data, TruncatedResultDataSchema]),
      meta: SuccessResultMetaSchema,
      warnings: Schema.Array(Schema.String),
    }),
    Schema.Struct({
      ok: Schema.Literal(false),
      error: ResultErrorSchema,
      meta: Schema.Struct({ requestId: Schema.String }),
    }),
  ])
