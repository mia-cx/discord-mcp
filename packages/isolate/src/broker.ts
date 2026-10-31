import type { DiscordRequest, DiscordRestError } from '@discord-mcp/discord-api/relay'
import type { OperationEntry } from '@mia-cx/discord-catalog'
import { Effect } from 'effect'
import { EgressBlockedError, fetchPublic } from './egress.ts'
import { checkHost, checkOperation, matchOperation, type ScriptGrants } from './grants.ts'

/** Handles every request an isolate makes, whatever its URL. */
export type Broker = (request: Request) => Promise<Response>

export interface Denial {
  readonly method: string
  readonly url: string
  readonly reason: string
}

export interface BrokerOptions {
  readonly operations: ReadonlyArray<OperationEntry>
  readonly grants: ScriptGrants
  /** Replays an authorized Discord call with the real token. */
  readonly discord: (call: DiscordRequest) => Effect.Effect<unknown, DiscordRestError>
  /** Outbound HTTP to granted hosts. Defaults to the public internet only. */
  readonly egress?: (request: Request) => Promise<Response>
  readonly onDenied: (denial: Denial) => void
}

const DISCORD_API = '/api/v10/'

/** A Discord-shaped error body, so discord.js inside the isolate raises its usual DiscordAPIError. */
const discordError = (status: number, message: string, headers: Record<string, string> = {}) =>
  Response.json({ code: 0, message }, { status, headers })

const replyFor = (result: unknown) =>
  result instanceof ArrayBuffer
    ? new Response(result.byteLength === 0 ? null : result, {
        status: result.byteLength === 0 ? 204 : 200,
      })
    : Response.json(result)

const failureFor = (error: DiscordRestError) => {
  switch (error._tag) {
    case 'DiscordRateLimitError': {
      const seconds = error.retryAfterMs / 1000
      return Response.json(
        { code: 0, message: error.message, retry_after: seconds, global: error.global },
        {
          status: 429,
          headers: {
            'retry-after': String(seconds),
            'x-ratelimit-scope': error.global ? 'global' : 'user',
            ...(error.global ? { 'x-ratelimit-global': 'true' } : {}),
          },
        },
      )
    }
    case 'DiscordPermissionError':
      return discordError(403, `${error.message} ${error.suggestion}`)
    case 'DiscordApiError':
      return Response.json(
        {
          code: error.discordCode ?? 0,
          message: [error.message, ...error.issues].join('\n'),
        },
        { status: error.httpStatus ?? 502 },
      )
    case 'RateGuardTrippedError':
      return discordError(503, error.message)
  }
}

/** Discord bodies are small JSON; the broker buffers one in relay memory, so it is capped. */
const BODY_LIMIT_BYTES = 1024 * 1024

type Refusal = { readonly refusal: string }

const readBody = async (request: Request): Promise<{ readonly body?: unknown } | Refusal> => {
  if (request.body === null) return {}
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of request.body) {
    size += chunk.byteLength
    if (size > BODY_LIMIT_BYTES) return { refusal: `The body exceeds ${BODY_LIMIT_BYTES} bytes.` }
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text === '') return {}
  if (!(request.headers.get('content-type') ?? '').startsWith('application/json')) {
    return { refusal: 'Scripts send JSON bodies only; file uploads are not supported.' }
  }
  try {
    return { body: JSON.parse(text) as unknown }
  } catch {
    return { refusal: 'The body is not valid JSON.' }
  }
}

const auditLogReason = (request: Request): { readonly reason?: string } | Refusal => {
  const header = request.headers.get('x-audit-log-reason')
  if (header === null) return {}
  try {
    return { reason: decodeURIComponent(header) }
  } catch {
    return { refusal: 'X-Audit-Log-Reason is not valid URI encoding.' }
  }
}

/**
 * The isolate's only outbound service.
 *
 * A Discord REST call is matched to a catalog operation by method and path, checked against the
 * script's grants, and replayed through the relay's own client, which holds the real token. The
 * placeholder token the isolate sent is discarded. Anything else is outbound HTTP, allowed only to
 * granted hosts on the public internet.
 */
export const makeBroker = (options: BrokerOptions): Broker => {
  const refuse = (request: Request, reason: string) => {
    options.onDenied({ method: request.method, url: request.url, reason })
    return discordError(403, `Refused by the script broker: ${reason}`)
  }

  const discord = async (request: Request, url: URL, route: `/${string}`) => {
    const operation = matchOperation(options.operations, request.method, route)
    if (operation === undefined) {
      return refuse(request, `${request.method} ${route} is not a cataloged Discord operation.`)
    }
    const decision = checkOperation(options.grants, operation)
    if (!decision.allowed) return refuse(request, decision.reason)

    const reason = auditLogReason(request)
    if ('refusal' in reason) return refuse(request, reason.refusal)
    const body = await readBody(request)
    if ('refusal' in body) return refuse(request, body.refusal)
    return Effect.runPromise(
      options
        .discord({
          method: operation.method,
          route,
          operationFamily: operation.family,
          ...(url.search === '' ? {} : { query: url.searchParams }),
          ...(body.body === undefined ? {} : { body: body.body }),
          ...(reason.reason === undefined ? {} : { auditLogReason: reason.reason }),
        })
        .pipe(
          Effect.map(replyFor),
          Effect.catch((error) => Effect.succeed(failureFor(error))),
        ),
      { signal: request.signal },
    )
  }

  const outbound = async (request: Request, url: URL) => {
    const decision = checkHost(options.grants, url)
    if (!decision.allowed) return refuse(request, decision.reason)
    return (options.egress ?? fetchPublic)(request).catch((error: unknown) => {
      if (error instanceof EgressBlockedError) return refuse(request, error.message)
      throw error
    })
  }

  return async (request) => {
    const url = new URL(request.url)
    if (url.hostname !== 'discord.com') return outbound(request, url)
    if (!url.pathname.startsWith(DISCORD_API)) {
      return refuse(request, `${url.pathname} is not part of Discord's v10 REST API.`)
    }
    return discord(request, url, `/${url.pathname.slice(DISCORD_API.length)}` as const)
  }
}
