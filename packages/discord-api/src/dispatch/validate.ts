import { type AuthMode, ValidationError } from '@discord-mcp/core'
import type { OperationEntry } from '@mia-cx/discord-catalog'
import { Ajv2020 } from 'ajv/dist/2020.js'
import * as ajvFormats from 'ajv-formats'
import { Effect } from 'effect'

/**
 * Local validation, all of it, before any network call.
 *
 * Every rejection here is a request Discord never sees. That matters beyond latency: 400s are free
 * against Cloudflare's ban budget but 401/403 are not, and an agent that learns a shape by trial
 * and error against the live API is the exact failure mode `RateGuard` exists to stop. Failing
 * locally with a specific message converts a round trip into a fix on the next turn.
 */

/** Discord IDs are 17–21 decimal digits. Anything else is a typo or a hallucinated ID. */
const SNOWFLAKE = /^\d{17,21}$/

export interface DispatchArgs {
  readonly operationId: string
  readonly authProfile: string
  readonly path?: Record<string, string>
  readonly query?: Record<string, unknown>
  readonly body?: unknown
  readonly auditLogReason?: string
}

/**
 * `ajv-formats` ships an ESM-shaped `.d.ts` for a CJS module, so TypeScript collapses its
 * `export default` into the namespace and neither the namespace nor `.default` types as callable.
 * Node hands back `module.exports`, which is the plugin function. Asserting the one shape we rely
 * on is more honest than turning on `esModuleInterop` globally to paper over one dependency.
 */
const addFormats = (ajvFormats as unknown as { readonly default: (instance: Ajv2020) => void })
  .default

const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: true })
addFormats(ajv)

/**
 * The five operations Discord's own spec marks OAuth2-only.
 *
 * They are refused *only* under a bot profile — an OAuth2 profile can call them — so the message
 * must say which profile to use rather than implying the operation is unavailable.
 */
export const assertAuthProfileCanExecute = (
  op: OperationEntry,
  profileKind: AuthMode,
): Effect.Effect<void, ValidationError> =>
  op.auth.includes(profileKind)
    ? Effect.void
    : Effect.fail(
        new ValidationError({
          message: `Operation "${op.operationId}" cannot be executed with a ${profileKind} credential.`,
          issues: [
            `authProfile: this operation accepts ${op.auth.join(' or ')}, not ${profileKind}.`,
            ...(op.auth.includes('oauth2')
              ? [
                  `It reads data scoped to an authorizing Discord user, which a bot token has no way to identify. Create an OAuth2 profile with ${op.oauthScopes.length > 0 ? `the ${op.oauthScopes.join(', ')} scope(s)` : 'the required scopes'} via discord_oauth_profile_authorize, then pass its name as authProfile.`,
                ]
              : []),
          ],
        }),
      )

export const validatePathParams = (
  op: OperationEntry,
  provided: Record<string, string> | undefined,
): Effect.Effect<Record<string, string>, ValidationError> => {
  const path = provided ?? {}
  const issues: string[] = []

  for (const name of op.pathParams) {
    const value = path[name]
    if (value === undefined || value === '') {
      issues.push(`path.${name}: required by the path template "${op.path}" but not supplied.`)
      continue
    }
    // Only *_id parameters are snowflakes; codes, emoji names, and tokens are not.
    if (name.endsWith('_id') && !SNOWFLAKE.test(value)) {
      issues.push(
        `path.${name}: "${value}" is not a Discord ID. IDs are 17-21 digits. Find the real ID with a list tool rather than guessing.`,
      )
    }
  }

  const unknown = Object.keys(path).filter((k) => !op.pathParams.includes(k))
  for (const k of unknown) {
    issues.push(
      `path.${k}: not a parameter of "${op.path}". Expected: ${op.pathParams.join(', ') || '(none)'}.`,
    )
  }

  return issues.length === 0
    ? Effect.succeed(path)
    : Effect.fail(
        new ValidationError({ message: `Invalid path parameters for ${op.operationId}.`, issues }),
      )
}

export const validateQueryParams = (
  op: OperationEntry,
  provided: Record<string, unknown> | undefined,
): Effect.Effect<URLSearchParams, ValidationError> => {
  const query = provided ?? {}
  const issues: string[] = []

  // Unknown keys are rejected rather than dropped. Discord silently ignores parameters it does not
  // recognise, so `?limit=100` misspelled as `?limits=100` would return the default page and look
  // like a wrong answer from this server rather than a typo.
  for (const key of Object.keys(query)) {
    if (!op.queryParams.includes(key)) {
      issues.push(
        `query.${key}: not accepted by ${op.operationId}. Discord ignores unknown query parameters silently, so this would have returned a quietly wrong result. Accepted: ${op.queryParams.join(', ') || '(none)'}.`,
      )
    }
  }
  for (const required of op.requiredQuery) {
    if (query[required] === undefined) issues.push(`query.${required}: required but not supplied.`)
  }

  if (issues.length > 0) {
    return Effect.fail(
      new ValidationError({ message: `Invalid query parameters for ${op.operationId}.`, issues }),
    )
  }

  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue
    if (Array.isArray(value)) for (const v of value) params.append(key, String(v))
    else params.set(key, String(value))
  }
  return Effect.succeed(params)
}

/**
 * Validate the body against the catalog's own JSON Schema.
 *
 * The authoritative input is already JSON Schema, so this is nearly free, and it turns what would
 * be a Discord 400 with a nested error tree into an immediate, path-addressed message.
 */
export const validateBody = (
  op: OperationEntry,
  body: unknown,
  schema: Record<string, unknown> | undefined,
): Effect.Effect<void, ValidationError> => {
  if (op.requestBody === undefined) {
    return body === undefined
      ? Effect.void
      : Effect.fail(
          new ValidationError({
            message: `${op.operationId} does not accept a request body.`,
            issues: ['body: remove it.'],
          }),
        )
  }
  if (body === undefined) {
    return op.requestBody.required
      ? Effect.fail(
          new ValidationError({
            message: `${op.operationId} requires a request body.`,
            issues: ['body: required but not supplied. Call discord_api_describe for its schema.'],
          }),
        )
      : Effect.void
  }
  if (schema === undefined) return Effect.void

  return Effect.try({
    try: () => {
      const validate = ajv.compile(schema)
      if (validate(body)) return
      throw (validate.errors ?? []).map(
        (e: { instancePath: string; message?: string }) =>
          `body${e.instancePath.replaceAll('/', '.')}: ${e.message ?? 'invalid'}`,
      )
    },
    catch: (cause) =>
      new ValidationError({
        message: `Request body does not match the schema for ${op.operationId}.`,
        issues: Array.isArray(cause) ? (cause as string[]) : [String(cause)],
      }),
  })
}

/** Discord sends this as an HTTP header, so it must survive header encoding and stay short. */
const MAX_AUDIT_REASON_CHARS = 512

export const validateAuditLogReason = (
  op: OperationEntry,
  reason: string | undefined,
): Effect.Effect<void, ValidationError> => {
  if (reason === undefined) return Effect.void
  if (!op.auditLogReason) {
    return Effect.fail(
      new ValidationError({
        message: `${op.operationId} does not record an audit log reason.`,
        issues: ['auditLogReason: remove it; Discord would ignore it here.'],
      }),
    )
  }
  return reason.length <= MAX_AUDIT_REASON_CHARS
    ? Effect.void
    : Effect.fail(
        new ValidationError({
          message: 'Audit log reason is too long.',
          issues: [
            `auditLogReason: ${reason.length} characters; the maximum is ${MAX_AUDIT_REASON_CHARS}.`,
          ],
        }),
      )
}

/**
 * Percent-encode each substituted value so one containing `/` cannot escape its position and
 * address a different endpoint.
 *
 * The return type is `/${string}` because that is what @discordjs/rest's `RouteLike` requires;
 * every vendored path template starts with a slash, and `spec:check` asserts it.
 */
export const buildRoute = (op: OperationEntry, path: Record<string, string>): `/${string}` =>
  op.path.replaceAll(/\{([^}]+)\}/g, (_, name: string) =>
    encodeURIComponent(path[name] as string),
  ) as `/${string}`
