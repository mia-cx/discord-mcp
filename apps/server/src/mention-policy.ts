import type { DispatchInput } from '@discord-mcp/discord-api'

const messageBodyOperations = new Set([
  'create_message',
  'update_message',
  'create_lobby_message',
  'execute_webhook',
  'update_original_webhook_message',
  'update_webhook_message',
])

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const safeAllowedMentions = {
  parse: [],
  users: [],
  roles: [],
  replied_user: false,
} as const

const protectMessageBody = (
  body: Readonly<Record<string, unknown>>,
  broadMentionsAllowed: boolean,
): Readonly<Record<string, unknown>> => {
  const configured = body.allowed_mentions
  if (configured === undefined) return { ...body, allowed_mentions: safeAllowedMentions }
  if (!isRecord(configured)) return body
  const parse = configured.parse
  if (Array.isArray(parse) && parse.length > 0 && !broadMentionsAllowed) {
    throw new Error('broad mentions require the mentions:broad scope or workflow grant')
  }
  return {
    ...body,
    allowed_mentions: {
      ...configured,
      ...(parse === undefined ? { parse: [] } : {}),
      ...(configured.replied_user === undefined ? { replied_user: false } : {}),
    },
  }
}

/**
 * Discord applies broad mention parsing defaults when message-shaped raw API
 * bodies omit allowed_mentions. Normalize those bodies before preview hashing
 * and dispatch so raw catalog access cannot bypass the presentation policy.
 */
export const enforceDispatchMentionPolicy = (
  input: DispatchInput,
  broadMentionsAllowed: boolean,
): DispatchInput => {
  if (!isRecord(input.body)) return input
  let body = input.body
  if (messageBodyOperations.has(input.operationId)) {
    body = protectMessageBody(body, broadMentionsAllowed)
  } else if (input.operationId === 'create_thread' && isRecord(body.message)) {
    body = {
      ...body,
      message: protectMessageBody(body.message, broadMentionsAllowed),
    }
  } else if (
    input.operationId === 'create_interaction_response' &&
    (body.type === 4 || body.type === 7) &&
    isRecord(body.data)
  ) {
    body = {
      ...body,
      data: protectMessageBody(body.data, broadMentionsAllowed),
    }
  }
  return body === input.body ? input : { ...input, body }
}
