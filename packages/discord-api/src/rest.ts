import { AsyncLocalStorage } from 'node:async_hooks'
import { countIfAvailable, type RateGuardTrippedError, requestSignal } from '@discord-mcp/core'
import { REST, RESTEvents, type RequestData, type RouteLike } from '@discordjs/rest'
import { Config, Context, Effect, Layer, Redacted } from 'effect'
import { type MappedDiscordError, mapDiscordError } from './errors.ts'
import { isCountedRejection, RateGuard, rateGuardScope } from './rate-guard.ts'

/**
 * Everything a Discord request can fail with: a mapped Discord response, or the circuit breaker
 * refusing to send one at all.
 */
export type DiscordRestError = MappedDiscordError | RateGuardTrippedError

export interface DiscordRequest {
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  readonly route: RouteLike
  readonly query?: URLSearchParams
  readonly body?: unknown
  /** Discord surfaces this in the guild audit log. Header-encoded, so it must stay short. */
  readonly auditLogReason?: string
  /** Groups rate-guard accounting. Derived from the catalog once phase 2 lands. */
  readonly operationFamily: string
}

export interface RestConfig {
  readonly token: Redacted.Redacted<string>
  readonly timeoutMs: number
  readonly retries: number
  /**
   * Short rate-limit waits are absorbed by @discordjs/rest; longer ones fail fast instead of
   * blocking a tool call for minutes, because an MCP client is waiting on a response.
   */
  readonly maxRateLimitWaitMs: number
}

export const restConfig = Config.all({
  token: Config.redacted('DISCORD_TOKEN'),
  timeoutMs: Config.int('DISCORD_MCP_REST_TIMEOUT_MS').pipe(Config.withDefault(15_000)),
  retries: Config.int('DISCORD_MCP_REST_RETRIES').pipe(Config.withDefault(2)),
  maxRateLimitWaitMs: Config.int('DISCORD_MCP_REST_MAX_RATELIMIT_WAIT_MS').pipe(
    Config.withDefault(10_000),
  ),
})

/** The `@discordjs/rest` error shape we can read a status and body off. */
interface HttpErrorLike {
  readonly status?: number
  readonly code?: number
  readonly rawError?: unknown
  readonly message?: string
  readonly retryAfter?: number
  readonly global?: boolean
}

const readError = (
  cause: unknown,
): { status: number; body: unknown; retryAfterMs?: number; global?: boolean } => {
  const e = (cause ?? {}) as HttpErrorLike
  // A RateLimitError from @discordjs/rest carries retryAfter in seconds and no HTTP status.
  if (typeof e.retryAfter === 'number') {
    return {
      status: 429,
      body: { message: e.message ?? 'Rate limited.' },
      retryAfterMs: Math.round(e.retryAfter * 1000),
      ...(e.global === undefined ? {} : { global: e.global }),
    }
  }
  return {
    status: typeof e.status === 'number' ? e.status : 0,
    body: e.rawError ?? { message: e.message ?? String(cause) },
  }
}

/**
 * Marks the request in progress once Discord itself answers 429. `@discordjs/rest` raises the same
 * `RateLimitError` when it refuses a request locally, which never reaches Discord or Cloudflare.
 */
const answered429 = new AsyncLocalStorage<{ value: boolean }>()

const restClient = (config: Omit<RestConfig, 'token'>, makeRequest?: typeof fetch) =>
  new REST({
    version: '10',
    timeout: config.timeoutMs,
    retries: config.retries,
    // Absorb short waits inside the client; fail fast on long ones so a tool call
    // returns an actionable rate-limit error instead of hanging.
    rejectOnRateLimit: (info) => info.timeToReset > config.maxRateLimitWaitMs,
    // @discordjs/rest types `init` with its own undici's RequestInit; at runtime it is the standard one.
    ...(makeRequest === undefined
      ? {}
      : { makeRequest: (url: string, init: unknown) => makeRequest(url, init as RequestInit) }),
  }).on(RESTEvents.Response, (_request, response) => {
    // Shared-scope 429s are Discord's own resource limits and do not count toward the ban.
    if (response.status !== 429 || response.headers.get('x-ratelimit-scope') === 'shared') return
    const seen = answered429.getStore()
    if (seen !== undefined) seen.value = true
  })

/**
 * One bot's rate-limit state: `@discordjs/rest`'s bucket queues and the rejection guard. It holds
 * no token, so it can outlive the requests that share it. `close` stops its sweep timers.
 */
export interface RateLimiter {
  readonly client: REST
  readonly guard: RateGuard['Service']
  readonly close: () => void
}

/** `makeRequest` is the network seam; the default is `@discordjs/rest`'s own undici client. */
export const createRateLimiter = (
  config: Omit<RestConfig, 'token'>,
  makeRequest?: typeof fetch,
): RateLimiter => {
  const client = restClient(config, makeRequest)
  return {
    client,
    guard: Effect.runSync(RateGuard.make()),
    close: () => {
      client.clearHashSweeper()
      client.clearHandlerSweeper()
    },
  }
}

/**
 * The single holder of the bot token.
 *
 * Nothing above this service ever sees the credential: tools name operations, this service
 * performs them. `@discordjs/rest` owns rate-limit buckets, queues, retries, and multipart.
 */
export class DiscordRest extends Context.Service<
  DiscordRest,
  {
    readonly request: (req: DiscordRequest) => Effect.Effect<unknown, DiscordRestError>
    /** Escape hatch for the Gateway, which shares this REST instance so both use one token bucket. */
    readonly raw: REST
  }
>()('discord-api/DiscordRest') {
  static readonly layer = (config: RestConfig) =>
    Layer.effect(DiscordRest)(
      Effect.gen(function* () {
        // The guard is resolved once, at layer construction: callers name operations, they do not
        // carry the circuit breaker around.
        const guard = yield* RateGuard

        const rest = yield* Effect.acquireRelease(
          Effect.sync(() => restClient(config).setToken(Redacted.value(config.token))),
          // The token is process-lifetime; there is no socket to close, but clearing it keeps the
          // credential out of a heap snapshot taken after shutdown.
          (client) => Effect.sync(() => client.setToken('')),
        )
        return perform(rest, guard, config.token)
      }),
    )

  /**
   * Requests as `token` through a bot's shared limiter, so concurrent requests for that bot queue
   * in one set of buckets. The token travels with each request and never enters the limiter.
   */
  static readonly shared = (token: Redacted.Redacted<string>, limiter: RateLimiter) =>
    Layer.succeed(DiscordRest)(perform(limiter.client, limiter.guard, token))
}

const perform = (
  rest: REST,
  guard: RateGuard['Service'],
  token: Redacted.Redacted<string>,
): DiscordRest['Service'] => {
  const request = (req: DiscordRequest) =>
    Effect.gen(function* () {
      const scope = rateGuardScope('bot', req.operationFamily)
      yield* guard.check(scope)

      // The caller's cancellation signal, when there is a caller. Passing it to
      // @discordjs/rest aborts the in-flight HTTP request rather than abandoning it.
      const signal = yield* requestSignal

      const options: RequestData = {
        ...(req.query === undefined ? {} : { query: req.query }),
        ...(req.body === undefined ? {} : { body: req.body }),
        ...(req.auditLogReason === undefined ? {} : { reason: req.auditLogReason }),
        ...(signal === undefined ? {} : { signal }),
        auth: false,
        headers: { authorization: `Bot ${Redacted.value(token)}` },
      }

      const seen429 = { value: false }
      const result = yield* Effect.tryPromise({
        try: () =>
          answered429.run(seen429, () => {
            switch (req.method) {
              case 'GET':
                return rest.get(req.route, options)
              case 'POST':
                return rest.post(req.route, options)
              case 'PUT':
                return rest.put(req.route, options)
              case 'PATCH':
                return rest.patch(req.route, options)
              case 'DELETE':
                return rest.delete(req.route, options)
            }
          }),
        catch: (cause) => cause,
      }).pipe(
        Effect.catch((cause) =>
          Effect.gen(function* () {
            const { status, body, retryAfterMs, global } = readError(cause)
            yield* countIfAvailable('discord.request.failed')
            if (retryAfterMs !== undefined) yield* countIfAvailable('discord.rate_limit_wait')
            // 400s are free against Cloudflare's budget; only 401/403/429 are counted, and a
            // rate limit only when Discord answered it rather than the client refusing locally.
            if (retryAfterMs === undefined ? isCountedRejection(status) : seen429.value) {
              yield* guard.recordRejection(scope)
            }
            return yield* Effect.fail(
              mapDiscordError(status, body, {
                ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
                ...(global === undefined ? {} : { global }),
              }),
            )
          }),
        ),
      )

      yield* countIfAvailable('discord.request')
      return result
    })

  return { request, raw: rest }
}
