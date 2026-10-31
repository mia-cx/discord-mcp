import { countIfAvailable, type RateGuardTrippedError, requestSignal } from '@discord-mcp/core'
import { REST, type RequestData, type RouteLike } from '@discordjs/rest'
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
  /** False sends no bot token, for routes that carry their own, such as interaction replies. */
  readonly auth?: false
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
          Effect.sync(() => {
            const client = new REST({
              version: '10',
              timeout: config.timeoutMs,
              retries: config.retries,
              // Absorb short waits inside the client; fail fast on long ones so a tool call
              // returns an actionable rate-limit error instead of hanging.
              rejectOnRateLimit: (info) => info.timeToReset > config.maxRateLimitWaitMs,
            })
            client.setToken(Redacted.value(config.token))
            return client
          }),
          // The token is process-lifetime; there is no socket to close, but clearing it keeps the
          // credential out of a heap snapshot taken after shutdown.
          (client) => Effect.sync(() => client.setToken('')),
        )

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
              ...(req.auth === false ? { auth: false } : {}),
              ...(signal === undefined ? {} : { signal }),
            }

            const result = yield* Effect.tryPromise({
              try: () => {
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
              },
              catch: (cause) => cause,
            }).pipe(
              Effect.catch((cause) =>
                Effect.gen(function* () {
                  const { status, body, retryAfterMs, global } = readError(cause)
                  yield* countIfAvailable('discord.request.failed')
                  if (retryAfterMs !== undefined) yield* countIfAvailable('discord.rate_limit_wait')
                  // 400s are free against Cloudflare's budget; only 401/403/429 are counted.
                  if (isCountedRejection(status)) yield* guard.recordRejection(scope)
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
      }),
    )
}
