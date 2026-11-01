import { Cause, Result, type Schema, SchemaIssue } from 'effect'
import type { DomainError } from '../errors.ts'

/** PLAN.md: responses above this truncate with an explicit cursor or resource link. */
export const MAX_RESPONSE_CHARS = 25_000

export interface ResultMeta {
  readonly requestId: string
  readonly operationId?: string
  readonly authProfile: string
  readonly pagination?: { readonly hasMore: boolean; readonly nextCursor?: string }
  readonly truncated: boolean
}

/** What a failed tool call reports. Every field exists to forestall a blind retry. */
export interface ToolErrorPayload {
  readonly code: string
  readonly message: string
  readonly retryable: boolean
  readonly httpStatus?: number
  readonly discordCode?: number
  readonly retryAfterMs?: number
  readonly missingPermission?: string
  readonly suggestion?: string
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
      readonly error: ToolErrorPayload
      readonly meta: { readonly requestId: string }
    }

/** The MCP `CallToolResult` shape we emit. Structured JSON plus concise text. */
export interface CallToolResultLike {
  readonly content: ReadonlyArray<{ readonly type: 'text'; readonly text: string }>
  readonly structuredContent?: unknown
  readonly isError?: boolean
}

const truncate = (text: string): { text: string; truncated: boolean } =>
  text.length <= MAX_RESPONSE_CHARS
    ? { text, truncated: false }
    : {
        text: `${text.slice(0, MAX_RESPONSE_CHARS)}\n\n[truncated at ${MAX_RESPONSE_CHARS} characters; narrow the request or page with a cursor]`,
        truncated: true,
      }

export const successResult = <A>(
  result: DiscordToolResult<A> & { ok: true },
): CallToolResultLike => {
  const { text, truncated } = truncate(JSON.stringify(result.data, null, 2))
  const warnings =
    result.warnings.length > 0
      ? `\n\nWarnings:\n${result.warnings.map((w) => `- ${w}`).join('\n')}`
      : ''
  return {
    content: [{ type: 'text', text: text + warnings }],
    structuredContent: {
      ...result,
      meta: { ...result.meta, truncated: result.meta.truncated || truncated },
    },
    isError: false,
  }
}

export const errorResult = (requestId: string, error: ToolErrorPayload): CallToolResultLike => {
  const lines = [
    `${error.code}: ${error.message}`,
    error.httpStatus === undefined ? undefined : `HTTP ${error.httpStatus}`,
    error.discordCode === undefined ? undefined : `Discord code ${error.discordCode}`,
    error.missingPermission === undefined
      ? undefined
      : `Missing permission: ${error.missingPermission}`,
    error.retryAfterMs === undefined ? undefined : `Retry after ${error.retryAfterMs}ms`,
    error.suggestion,
  ].filter((l): l is string => l !== undefined)

  return {
    content: [{ type: 'text', text: lines.join('\n') }],
    structuredContent: { ok: false, error, meta: { requestId } },
    isError: true,
  }
}

/**
 * Flatten Discord's nested invalid-form-body tree into `path: message [CODE]` lines.
 *
 * `{"components":{"0":{"accessory":{"_errors":[{"code":"BASE_TYPE_REQUIRED","message":"..."}]}}}}`
 * becomes `components.0.accessory: This field is required [BASE_TYPE_REQUIRED]`. The nested form
 * is close to unreadable; the flattened form is something a model fixes on the next turn.
 */
export const flattenDiscordErrors = (errors: unknown, prefix = ''): ReadonlyArray<string> => {
  if (errors === null || typeof errors !== 'object') return []
  const out: string[] = []

  for (const [key, value] of Object.entries(errors as Record<string, unknown>)) {
    if (key === '_errors') {
      if (!Array.isArray(value)) continue
      for (const e of value) {
        if (e === null || typeof e !== 'object') continue
        const { code, message } = e as { code?: string; message?: string }
        const path = prefix === '' ? '(root)' : prefix
        out.push(`${path}: ${message ?? 'invalid'}${code === undefined ? '' : ` [${code}]`}`)
      }
      continue
    }
    out.push(...flattenDiscordErrors(value, prefix === '' ? key : `${prefix}.${key}`))
  }
  return out
}

/**
 * Format Effect schema issues as `- path.to.field: message` lines.
 *
 * The standard-schema formatter is the v4 equivalent of v3's ArrayFormatter. The tree formatter
 * goes to stderr only — it is for an operator reading logs, not for a model reading a tool result.
 */
const standardSchemaFormatter = SchemaIssue.makeFormatterStandardSchemaV1()

export const formatSchemaError = (error: Schema.SchemaError): ReadonlyArray<string> =>
  standardSchemaFormatter(error.issue).issues.map((issue) => {
    const path =
      issue.path === undefined || issue.path.length === 0 ? '(root)' : issue.path.join('.')
    return `${path}: ${issue.message}`
  })

const DEFECT_SUGGESTION =
  'This is a bug in discord-mcp, not a problem with your arguments; do not retry with different arguments. Report it with the request ID.'

/**
 * Turn any failure cause into an actionable error payload.
 *
 * Unknown defects deliberately do not leak stack traces to a remote MCP caller — the full cause is
 * recorded in structured logs instead.
 */
export const renderCause = (cause: Cause.Cause<unknown>): ToolErrorPayload => {
  const failure = Cause.findError(cause)

  if (Result.isSuccess(failure)) {
    const error = failure.success
    if (error !== null && typeof error === 'object' && '_tag' in error) {
      if ((error as { _tag: string })._tag === 'SchemaError') {
        const issues = formatSchemaError(error as Schema.SchemaError)
        return {
          code: 'ValidationError',
          message: 'The arguments did not match this tool’s input schema.',
          retryable: false,
          suggestion: `Fix these fields and call again:\n${issues.map((i) => `- ${i}`).join('\n')}`,
        }
      }
      return renderDomainError(error as DomainError)
    }
  }
  if (Cause.hasInterrupts(cause)) {
    return {
      code: 'Interrupted',
      message: 'The request was cancelled before it completed.',
      retryable: true,
      suggestion: 'Nothing was necessarily left undone; re-issue the call if you still need it.',
    }
  }
  return {
    code: 'InternalError',
    message: 'An unexpected internal error occurred.',
    retryable: false,
    suggestion: DEFECT_SUGGESTION,
  }
}

const renderDomainError = (e: DomainError): ToolErrorPayload => {
  switch (e._tag) {
    case 'ValidationError':
      return {
        code: e._tag,
        message: e.message,
        retryable: false,
        suggestion:
          e.issues.length === 0
            ? 'Correct the arguments and call again.'
            : `Fix these fields and call again:\n${e.issues.map((i) => `- ${i}`).join('\n')}`,
      }
    case 'AuthorizationError':
      return {
        code: e._tag,
        message: e.message,
        retryable: false,
        suggestion: `Do not retry; this principal is missing the scope(s): ${e.missingScopes.join(', ')}. Tell the user which scope to grant.`,
      }
    case 'AuthenticationError':
      return {
        code: e._tag,
        message: e.message,
        retryable: false,
        suggestion: 'Do not retry; tell the user to check the configured credential.',
      }
    case 'DiscordPermissionError':
      return {
        code: e._tag,
        message: e.message,
        retryable: false,
        ...(e.missingPermission === undefined ? {} : { missingPermission: e.missingPermission }),
        suggestion: e.suggestion,
      }
    case 'DiscordRateLimitError':
      return {
        code: e._tag,
        message: e.message,
        retryable: true,
        retryAfterMs: e.retryAfterMs,
        suggestion: `Wait ${e.retryAfterMs}ms before the next call. Do not send the same request in a loop.`,
      }
    case 'RateGuardTrippedError':
      return {
        code: e._tag,
        message: e.message,
        retryable: false,
        suggestion: `Do not retry. ${e.failures} rejected Discord responses in ${Math.round(e.windowMs / 60_000)} minutes for ${e.scope} tripped the circuit breaker. Diagnose permissions with discord_permissions_explain or check credentials, then tell the user.`,
      }
    case 'DiscordApiError':
      return {
        code: e._tag,
        message: e.message,
        retryable: e.retryable,
        ...(e.httpStatus === undefined ? {} : { httpStatus: e.httpStatus }),
        ...(e.discordCode === undefined ? {} : { discordCode: e.discordCode }),
        suggestion:
          e.suggestion ??
          (e.issues.length > 0
            ? `Fix these fields and call again:\n${e.issues.map((i) => `- ${i}`).join('\n')}`
            : 'Read the message before retrying; an identical retry will fail identically.'),
      }
    case 'OperationNotFoundError':
      return {
        code: e._tag,
        message: `Unknown operation "${e.operationId}".`,
        retryable: false,
        suggestion: e.suggestion,
      }
    case 'DiscordGatewayError':
      return {
        code: e._tag,
        message: e.message,
        retryable: false,
        suggestion: e.suggestion,
      }
    case 'PersistenceError':
      return {
        code: e._tag,
        message: `Local storage failed during ${e.operation}.`,
        retryable: false,
        suggestion:
          "Do not retry; this is a problem with the server's database, not with your arguments. Tell the user to check DATABASE_PATH, disk space, and file permissions.",
      }
    case 'ConfigurationError':
      return {
        code: e._tag,
        message: `${e.variable}: ${e.message}`,
        retryable: false,
        suggestion: 'Do not retry; this is a server configuration problem the user must fix.',
      }
    case 'SandboxError':
      return {
        code: e._tag,
        message: e.message,
        retryable: false,
        suggestion: sandboxSuggestion(e.phase, e.diagnostics),
      }
  }
}

/**
 * What to do about a sandbox failure, by phase.
 *
 * A build failure is the workflow author's to fix and the diagnostics say how; an engine failure is
 * the operator's and no retry will help. Conflating them would send a model into a retry loop
 * against a sandbox that is not running.
 */
const sandboxSuggestion = (
  phase: 'engine' | 'build' | 'start' | 'protocol' | 'policy',
  diagnostics: ReadonlyArray<string> | undefined,
): string => {
  const detail =
    diagnostics === undefined || diagnostics.length === 0
      ? ''
      : `\n${diagnostics.map((d) => `- ${d}`).join('\n')}`

  switch (phase) {
    case 'build':
      return `The workflow did not build. Fix the source, save a new draft with workflow_update_draft, and validate that.${detail}`
    case 'policy':
      return `The request was refused before anything ran. Change the request to comply.${detail}`
    case 'start':
    case 'engine':
    case 'protocol':
      return `Do not retry; the workflow sandbox is unavailable or misconfigured. Tell the user to check the server's workflow execution backend.${detail}`
  }
}
