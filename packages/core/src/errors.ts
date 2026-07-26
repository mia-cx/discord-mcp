import { Schema } from 'effect'

/**
 * Every domain error is schema-backed so it serialises unchanged across the capability RPC
 * boundary to sandboxed workflow containers.
 *
 * `suggestion` is not decoration. A model's reflex on a failed Discord call is to retry with
 * permuted arguments, and repeated 401/403/429 responses are what walk an installation toward
 * Cloudflare's 10,000-invalid-responses-in-10-minutes IP ban. Every renderer must say what
 * happened, why, and what to do next — the last clause is the one that stops retry loops.
 */

export class ConfigurationError extends Schema.TaggedErrorClass<ConfigurationError>()(
  'ConfigurationError',
  {
    variable: Schema.String,
    message: Schema.String,
  },
) {}

export class AuthenticationError extends Schema.TaggedErrorClass<AuthenticationError>()(
  'AuthenticationError',
  {
    message: Schema.String,
  },
) {}

export class AuthorizationError extends Schema.TaggedErrorClass<AuthorizationError>()(
  'AuthorizationError',
  {
    message: Schema.String,
    missingScopes: Schema.Array(Schema.String),
  },
) {}

export class ValidationError extends Schema.TaggedErrorClass<ValidationError>()('ValidationError', {
  message: Schema.String,
  /** `path.to.field: reason` lines, already flattened for a model to act on. */
  issues: Schema.Array(Schema.String),
}) {}

export class DiscordApiError extends Schema.TaggedErrorClass<DiscordApiError>()('DiscordApiError', {
  message: Schema.String,
  httpStatus: Schema.optionalKey(Schema.Int),
  /** Discord's own JSON error code, e.g. 50035 invalid form body. */
  discordCode: Schema.optionalKey(Schema.Int),
  retryable: Schema.Boolean,
  /** Flattened from Discord's nested invalid-form-body tree. */
  issues: Schema.Array(Schema.String),
  suggestion: Schema.optionalKey(Schema.String),
}) {}

export class DiscordPermissionError extends Schema.TaggedErrorClass<DiscordPermissionError>()(
  'DiscordPermissionError',
  {
    message: Schema.String,
    missingPermission: Schema.optionalKey(Schema.String),
    suggestion: Schema.String,
  },
) {}

export class DiscordRateLimitError extends Schema.TaggedErrorClass<DiscordRateLimitError>()(
  'DiscordRateLimitError',
  {
    message: Schema.String,
    retryAfterMs: Schema.Int,
    global: Schema.Boolean,
  },
) {}

export class OperationNotFoundError extends Schema.TaggedErrorClass<OperationNotFoundError>()(
  'OperationNotFoundError',
  {
    operationId: Schema.String,
    suggestion: Schema.String,
  },
) {}

export class RateGuardTrippedError extends Schema.TaggedErrorClass<RateGuardTrippedError>()(
  'RateGuardTrippedError',
  {
    message: Schema.String,
    scope: Schema.String,
    failures: Schema.Int,
    windowMs: Schema.Int,
  },
) {}

export class PersistenceError extends Schema.TaggedErrorClass<PersistenceError>()(
  'PersistenceError',
  {
    operation: Schema.String,
    message: Schema.String,
  },
) {}

/** Errors the tool boundary knows how to render into an actionable `CallToolResult`. */
export type DomainError =
  | ConfigurationError
  | AuthenticationError
  | AuthorizationError
  | ValidationError
  | DiscordApiError
  | DiscordPermissionError
  | DiscordRateLimitError
  | OperationNotFoundError
  | RateGuardTrippedError
  | PersistenceError
