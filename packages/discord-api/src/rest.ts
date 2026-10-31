import { createHash } from 'node:crypto'
import {
  countIfAvailable,
  DiscordRateLimitError,
  RateGuardTrippedError,
  requestSignal,
} from '@discord-mcp/core'
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
  /** The signed-in human behind an HTTP request, counted apart so new tokens cannot evade it. */
  readonly caller?: string
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
  // A RateLimitError from @discordjs/rest carries retryAfter in milliseconds and no HTTP status.
  if (typeof e.retryAfter === 'number') {
    return {
      status: 429,
      body: { message: e.message ?? 'Rate limited.' },
      retryAfterMs: Math.round(e.retryAfter),
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
        // One HTTP relay serves many bots, so each token's rejections are counted apart.
        const credential = `bot:${createHash('sha256').update(Redacted.value(config.token)).digest('base64url').slice(0, 12)}`
        const rejectedCalls = new WeakSet<AbortSignal>()

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
            // Only answers Discord actually sent count: @discordjs/rest also throws a rate-limit
            // error before sending when it knows a bucket is empty. Each call's signal names it.
            client.on('response', (request, response) => {
              const signal = request.data.signal
              if (signal && isCountedRejection(response.status)) rejectedCalls.add(signal)
            })
            return client
          }),
          // The client's sweep intervals would otherwise keep it alive after release, and the HTTP
          // relay builds one per request. Clearing the token keeps it out of later heap snapshots.
          (client) =>
            Effect.sync(() => {
              client.clearHashSweeper()
              client.clearHandlerSweeper()
              client.setToken('')
            }),
        )

        const send = (method: DiscordRequest['method'], route: RouteLike, options: RequestData) => {
          switch (method) {
            case 'GET':
              return rest.get(route, options)
            case 'POST':
              return rest.post(route, options)
            case 'PUT':
              return rest.put(route, options)
            case 'PATCH':
              return rest.patch(route, options)
            case 'DELETE':
              return rest.delete(route, options)
          }
        }

        const request = (req: DiscordRequest) =>
          Effect.gen(function* () {
            const scopes = [
              credential,
              ...(config.caller === undefined ? [] : [`human:${config.caller}`]),
            ].map((subject) => rateGuardScope(subject, req.operationFamily))

            // The caller's cancellation signal, when there is a caller. Passing it to
            // @discordjs/rest aborts the in-flight HTTP request rather than abandoning it.
            const signal = yield* requestSignal
            // A signal of this call's own, following the caller's, identifies its responses.
            const tracked = AbortSignal.any(signal === undefined ? [] : [signal])

            const options: RequestData = {
              ...(req.query === undefined ? {} : { query: req.query }),
              ...(req.body === undefined ? {} : { body: req.body }),
              ...(req.auditLogReason === undefined ? {} : { reason: req.auditLogReason }),
              signal: tracked,
            }

            const result = yield* Effect.tryPromise({
              // Admission and sending share one synchronous step, so no interruption falls between
              // them, and the promise settles the slot whether or not anyone still awaits it.
              try: () => {
                const admission = guard.admit(scopes)
                if ('refused' in admission) throw admission.refused
                const sent = send(req.method, req.route, options)
                // A cancelled call may already have reached Discord, so it counts too.
                const settle = () => admission.settle(rejectedCalls.has(tracked) || tracked.aborted)
                sent.then(settle, settle)
                return sent
              },
              catch: (cause) => cause,
            }).pipe(
              Effect.catch((cause) =>
                Effect.gen(function* () {
                  if (
                    cause instanceof RateGuardTrippedError ||
                    cause instanceof DiscordRateLimitError
                  ) {
                    return yield* Effect.fail(cause)
                  }
                  const { status, body, retryAfterMs, global } = readError(cause)
                  yield* countIfAvailable('discord.request.failed')
                  if (retryAfterMs !== undefined) yield* countIfAvailable('discord.rate_limit_wait')
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
