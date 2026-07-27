import { Schema } from 'effect'

export interface DiscordInvalidField {
  readonly path: string
  readonly code?: string
  readonly message: string
}

interface DiscordErrorLeaf {
  readonly _errors?: ReadonlyArray<{ readonly code?: string; readonly message?: string }>
  readonly [key: string]: unknown
}

export const flattenDiscordErrors = (
  value: unknown,
  prefix = '',
): ReadonlyArray<DiscordInvalidField> => {
  if (typeof value !== 'object' || value === null) return []
  const object = value as DiscordErrorLeaf
  const fields: Array<DiscordInvalidField> = []
  for (const error of object._errors ?? []) {
    fields.push({
      path: prefix || 'request',
      ...(error.code === undefined ? {} : { code: error.code }),
      message: error.message ?? 'Invalid value',
    })
  }
  for (const [key, child] of Object.entries(object)) {
    if (key === '_errors') continue
    const path = prefix.length === 0 ? key : `${prefix}.${key}`
    fields.push(...flattenDiscordErrors(child, path))
  }
  return fields
}

const DiscordFailureFields = {
  message: Schema.String,
  status: Schema.optionalKey(Schema.Number),
  code: Schema.optionalKey(Schema.Number),
  fields: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      code: Schema.optionalKey(Schema.String),
      message: Schema.String,
    }),
  ),
  retryable: Schema.Boolean,
  retryAfterMs: Schema.optionalKey(Schema.Number),
}

export interface DiscordFailureOptions {
  readonly message: string
  readonly status?: number
  readonly code?: number
  readonly fields?: ReadonlyArray<DiscordInvalidField>
  readonly retryable?: boolean
  readonly retryAfterMs?: number
}

const failureFields = (options: DiscordFailureOptions) => ({
  message: options.message,
  ...(options.status === undefined ? {} : { status: options.status }),
  ...(options.code === undefined ? {} : { code: options.code }),
  fields: options.fields ?? [],
  retryable: options.retryable ?? false,
  ...(options.retryAfterMs === undefined ? {} : { retryAfterMs: options.retryAfterMs }),
})

export class DiscordApiError extends Schema.TaggedErrorClass<DiscordApiError>()(
  'DiscordApiError',
  DiscordFailureFields,
) {
  constructor(options: DiscordFailureOptions) {
    super(failureFields(options))
  }
}

export class DiscordPermissionError extends Schema.TaggedErrorClass<DiscordPermissionError>()(
  'DiscordPermissionError',
  DiscordFailureFields,
) {
  constructor(options: DiscordFailureOptions) {
    super(failureFields(options))
  }
}

export class DiscordRateLimitError extends Schema.TaggedErrorClass<DiscordRateLimitError>()(
  'DiscordRateLimitError',
  DiscordFailureFields,
) {
  constructor(options: DiscordFailureOptions) {
    super(failureFields(options))
  }
}

export type DiscordFailure = DiscordApiError | DiscordPermissionError | DiscordRateLimitError

export const isDiscordFailure = (value: unknown): value is DiscordFailure =>
  value instanceof DiscordApiError ||
  value instanceof DiscordPermissionError ||
  value instanceof DiscordRateLimitError

export const discordFailure = (options: DiscordFailureOptions): DiscordFailure => {
  if (options.status === 403) return new DiscordPermissionError(options)
  if (options.status === 429) return new DiscordRateLimitError(options)
  return new DiscordApiError(options)
}

/*
 * Keep construction centralized so Discord status variants remain schema-backed
 * while presenting one stable renderer contract to callers.
 */
export const actionableDiscordMessage = (error: DiscordFailure): string => {
  const detail =
    error.fields.length === 0
      ? ''
      : `\n${error.fields
          .map(
            ({ path, message, code }) =>
              `- ${path}: ${message}${code === undefined ? '' : ` [${code}]`}`,
          )
          .join('\n')}`
  if (error.status === 403) {
    return `${error.message}${detail}\nDo not retry; call discord_permissions_explain.`
  }
  if (error.status === 401) {
    return `${error.message}${detail}\nDo not retry; check the configured Discord credential.`
  }
  if (error.status === 429) {
    const wait =
      error.retryAfterMs === undefined ? 'the server-provided delay' : `${error.retryAfterMs} ms`
    return `${error.message}${detail}\nRate limited; wait ${wait} before another request.`
  }
  if (error.status === 400) {
    return `${error.message}${detail}\nCorrect the invalid fields before retrying.`
  }
  if (error.status !== undefined && error.status >= 500) {
    return `${error.message}${detail}\nDiscord is temporarily unavailable; do not immediately retry a write whose outcome is unknown.`
  }
  return `${error.message}${detail}`
}
