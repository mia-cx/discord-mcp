import { Schema } from 'effect'

/**
 * The capability RPC.
 *
 * Newline-delimited JSON between a workflow container and the broker, over the per-execution socket.
 * The container has no network, so this is the entire outside world as far as a workflow is
 * concerned — which is what makes an exhaustive, closed set of message kinds worth the rigidity.
 *
 * Every request carries the capability credential rather than relying on the connection's identity:
 * a socket in a volume could in principle be reached by something other than the runner, and a
 * per-call credential means that would gain nothing.
 */

export const CapabilityRequest = Schema.Struct({
  id: Schema.String,
  credential: Schema.String,
  call: Schema.Union([
    Schema.Struct({
      kind: Schema.Literal('discord'),
      operationId: Schema.String,
      path: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
      query: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
      body: Schema.optionalKey(Schema.Unknown),
      authProfile: Schema.optionalKey(Schema.String),
    }),
    Schema.Struct({
      kind: Schema.Literal('http'),
      url: Schema.String,
      method: Schema.optionalKey(Schema.String),
      headers: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
      body: Schema.optionalKey(Schema.String),
    }),
    Schema.Struct({
      kind: Schema.Literal('kv'),
      op: Schema.Literals(['get', 'set', 'delete']),
      key: Schema.String,
      value: Schema.optionalKey(Schema.Unknown),
      ttlSeconds: Schema.optionalKey(Schema.Int),
    }),
    Schema.Struct({
      kind: Schema.Literal('log'),
      level: Schema.Literals(['info', 'warn', 'error']),
      message: Schema.String,
      fields: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
    }),
    /** The handler's result. Sent once, and it ends the execution. */
    Schema.Struct({ kind: Schema.Literal('finish'), result: Schema.Unknown }),
  ]),
})
export type CapabilityRequest = typeof CapabilityRequest.Type

export const CapabilityResponse = Schema.Union([
  Schema.Struct({ id: Schema.String, ok: Schema.Literal(true), result: Schema.Unknown }),
  Schema.Struct({
    id: Schema.String,
    ok: Schema.Literal(false),
    /** True when the broker refused, false when Discord or the remote host failed the call. */
    denied: Schema.Boolean,
    message: Schema.String,
    suggestion: Schema.optionalKey(Schema.String),
  }),
])
export type CapabilityResponse = typeof CapabilityResponse.Type

/** A workflow cannot make the broker buffer without bound. */
export const MAX_CALL_BYTES = 1024 * 1024

/**
 * How much a workflow may log per execution before the rest is dropped.
 *
 * Dropped rather than truncated-and-failed: a chatty workflow is not a broken one, and killing it
 * over log volume would be a worse failure than losing the tail.
 */
export const MAX_LOG_BYTES = 64 * 1024
