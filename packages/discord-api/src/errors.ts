import {
  DiscordApiError,
  DiscordPermissionError,
  DiscordRateLimitError,
  flattenDiscordErrors,
} from '@discord-mcp/core'

/** Discord's JSON error body. Only the fields we act on. */
interface DiscordErrorBody {
  readonly code?: number
  readonly message?: string
  readonly errors?: unknown
}

const isDiscordErrorBody = (v: unknown): v is DiscordErrorBody =>
  v !== null && typeof v === 'object'

/** Discord JSON error codes we give specific advice for. */
const MISSING_ACCESS = 50_001
const MISSING_PERMISSIONS = 50_013
const INVALID_FORM_BODY = 50_035

/**
 * Transport-level failures worth one retry; everything else is a decision, not a hiccup.
 * Deliberately excludes 429 — the rate limiter owns that path.
 */
const RETRYABLE_STATUSES = new Set([500, 502, 503, 504])

export type MappedDiscordError = DiscordApiError | DiscordPermissionError | DiscordRateLimitError

/**
 * Map a Discord HTTP failure into a typed error carrying an instruction.
 *
 * The instruction is the point. An agent's reflex on 403 is to retry with permuted arguments, and
 * repeated 401/403/429 responses are what walk an installation toward Cloudflare's ban threshold.
 * Naming the next diagnostic converts a retry loop into a report to the user.
 */
export const mapDiscordError = (
  status: number,
  body: unknown,
  headers?: { readonly retryAfterMs?: number; readonly global?: boolean },
): MappedDiscordError => {
  const parsed = isDiscordErrorBody(body) ? body : {}
  const message = parsed.message ?? `Discord returned HTTP ${status}.`
  const issues = flattenDiscordErrors(parsed.errors)

  if (status === 429) {
    return new DiscordRateLimitError({
      message,
      retryAfterMs: headers?.retryAfterMs ?? 1000,
      global: headers?.global ?? false,
    })
  }

  if (status === 401) {
    return new DiscordApiError({
      message,
      httpStatus: status,
      retryable: false,
      issues,
      ...(parsed.code === undefined ? {} : { discordCode: parsed.code }),
      suggestion:
        'Do not retry; the bot token is invalid, expired, or was reset. Tell the user to check DISCORD_TOKEN against the Developer Portal.',
    })
  }

  if (status === 403 || parsed.code === MISSING_PERMISSIONS || parsed.code === MISSING_ACCESS) {
    return new DiscordPermissionError({
      message,
      suggestion:
        'Do not retry with different arguments. Call discord_permissions_explain for this guild and channel to find which role or overwrite denies the bot, then report it to the user.',
    })
  }

  if (status === 404) {
    return new DiscordApiError({
      message,
      httpStatus: status,
      retryable: false,
      issues,
      ...(parsed.code === undefined ? {} : { discordCode: parsed.code }),
      suggestion:
        'Do not retry. Either the ID does not exist or the bot cannot see the resource. Verify the ID with a list tool before calling again.',
    })
  }

  if (parsed.code === INVALID_FORM_BODY && issues.length > 0) {
    return new DiscordApiError({
      message: 'Discord rejected the request body.',
      httpStatus: status,
      discordCode: parsed.code,
      retryable: false,
      issues,
      suggestion: `Fix these fields and call again:\n${issues.map((i) => `- ${i}`).join('\n')}`,
    })
  }

  return new DiscordApiError({
    message,
    httpStatus: status,
    retryable: RETRYABLE_STATUSES.has(status),
    issues,
    ...(parsed.code === undefined ? {} : { discordCode: parsed.code }),
    ...(RETRYABLE_STATUSES.has(status)
      ? { suggestion: 'A transient Discord-side failure. One retry is reasonable; a loop is not.' }
      : {}),
  })
}

/**
 * `MESSAGE_CONTENT` gates message content over REST as well as the Gateway. Without it, `content`,
 * `embeds`, `attachments`, and `components` come back as empty values on a 200 — which everyone
 * reads as a bug in this server. Detect the signature and say so.
 */
export const diagnoseMessageContentRedaction = (messages: unknown): string | undefined => {
  if (!Array.isArray(messages) || messages.length === 0) return undefined

  const allEmpty = messages.every((m) => {
    if (m === null || typeof m !== 'object') return false
    const msg = m as { content?: unknown; embeds?: unknown; attachments?: unknown }
    return (
      msg.content === '' &&
      Array.isArray(msg.embeds) &&
      msg.embeds.length === 0 &&
      Array.isArray(msg.attachments) &&
      msg.attachments.length === 0
    )
  })

  return allEmpty
    ? 'Every message came back with empty content, embeds, and attachments. This is the MESSAGE_CONTENT intent signature, not empty messages: the intent gates content over REST as well as the Gateway. Enable Message Content Intent at discord.com/developers/applications/<app-id>/bot and restart.'
    : undefined
}
