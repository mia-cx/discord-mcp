import {
  type RateLimitData,
  type RawFile,
  REST,
  RESTEvents,
  RequestMethod,
  type RouteLike,
} from '@discordjs/rest'
import { Effect } from 'effect'
import {
  type DiscordFailure,
  discordFailure,
  flattenDiscordErrors,
  isDiscordFailure,
} from './errors.js'
import { RateGuard, RateGuardTrippedError } from './rate-guard.js'

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export interface RestRequest {
  readonly method: HttpMethod
  readonly route: string
  readonly query?: URLSearchParams
  readonly body?: unknown
  readonly reason?: string
  readonly files?: ReadonlyArray<RawFile>
  readonly auth?: boolean
  readonly signal: AbortSignal
}

export interface DiscordTransport {
  request(request: RestRequest): Promise<unknown>
}

export interface DiscordRestObserver {
  readonly requestFinished?: (event: {
    readonly family: string
    readonly method: HttpMethod
    readonly status: string
    readonly durationMs: number
    readonly outcome: 'success' | 'failure'
  }) => void
  readonly retryWait?: (event: {
    readonly family: string
    readonly method: HttpMethod
    readonly durationMs: number
  }) => void
  readonly rateGuardTripped?: (event: { readonly profile: string; readonly family: string }) => void
}

const errorNumber = (value: unknown, key: string): number | undefined => {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = (value as Record<string, unknown>)[key]
  return typeof candidate === 'number' ? candidate : undefined
}

const retryAfter = (cause: unknown, raw: unknown): number | undefined => {
  const milliseconds = errorNumber(cause, 'retryAfter')
  if (milliseconds !== undefined) return milliseconds
  const seconds = errorNumber(raw, 'retry_after')
  return seconds === undefined ? undefined : Math.ceil(seconds * 1_000)
}

const errorBody = (value: unknown): unknown => {
  if (typeof value !== 'object' || value === null) return undefined
  return (value as Record<string, unknown>).rawError
}

const redact = (value: string): string =>
  value
    .replaceAll(/(\/webhooks\/\d{17,21}\/)[^/\s?]+/g, '$1[redacted]')
    .replaceAll(/\b(?:Bot|Bearer)\s+[A-Za-z0-9._~+/-]{12,}/gi, '[redacted]')
    .replaceAll(/\bdcmcp_[A-Za-z0-9_-]+/g, '[redacted]')

const mapError = (cause: unknown): DiscordFailure => {
  if (isDiscordFailure(cause)) return cause
  const status = errorNumber(cause, 'status')
  const raw = errorBody(cause)
  const code = errorNumber(raw, 'code')
  const errors =
    typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>).errors : undefined
  const message = redact(
    typeof raw === 'object' &&
      raw !== null &&
      typeof (raw as Record<string, unknown>).message === 'string'
      ? String((raw as Record<string, unknown>).message)
      : cause instanceof Error
        ? cause.message
        : 'Discord request failed',
  )
  const retryAfterMs = retryAfter(cause, raw)
  return discordFailure({
    message,
    ...(status === undefined ? {} : { status }),
    ...(code === undefined ? {} : { code }),
    fields: flattenDiscordErrors(errors),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    retryable:
      (status !== undefined && (status === 429 || status >= 500)) ||
      (status === undefined && cause instanceof Error && cause.name !== 'AbortError'),
  })
}

export class DiscordRestClient {
  constructor(
    readonly transport: DiscordTransport,
    readonly rateGuard = new RateGuard(),
    readonly authProfile = 'bot',
    readonly readRetries = 2,
    readonly observer: DiscordRestObserver = {},
  ) {}

  request<A>(
    method: HttpMethod,
    route: string,
    options: Omit<RestRequest, 'method' | 'route' | 'signal'> = {},
  ) {
    const family = route.split('/').filter(Boolean)[0] ?? 'unknown'
    return Effect.tryPromise({
      try: async (signal) => {
        const started = performance.now()
        try {
          this.rateGuard.check(this.authProfile, family)
        } catch (cause) {
          if (cause instanceof RateGuardTrippedError) {
            this.observer.rateGuardTripped?.({ profile: this.authProfile, family })
          }
          throw cause
        }
        for (let attempt = 0; ; attempt += 1) {
          try {
            const result = (await this.transport.request({
              method,
              route,
              ...options,
              signal,
            })) as A
            this.observer.requestFinished?.({
              family,
              method,
              status: '2xx',
              durationMs: performance.now() - started,
              outcome: 'success',
            })
            return result
          } catch (cause) {
            if (cause instanceof RateGuardTrippedError) throw cause
            const error = mapError(cause)
            if (error.status !== undefined) {
              this.rateGuard.record(this.authProfile, family, error.status)
            }
            if (
              method !== 'GET' ||
              !error.retryable ||
              signal.aborted ||
              attempt >= this.readRetries
            ) {
              this.observer.requestFinished?.({
                family,
                method,
                status: error.status === undefined ? 'transport' : String(error.status),
                durationMs: performance.now() - started,
                outcome: 'failure',
              })
              throw error
            }
            const retryWaitMs = Math.min(100 * 2 ** attempt, 1_000)
            this.observer.retryWait?.({ family, method, durationMs: retryWaitMs })
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(resolve, retryWaitMs)
              signal.addEventListener(
                'abort',
                () => {
                  clearTimeout(timer)
                  reject(signal.reason)
                },
                { once: true },
              )
            })
          }
        }
      },
      catch: (cause) => (cause instanceof RateGuardTrippedError ? cause : mapError(cause)),
    })
  }
}

export interface DiscordJsRestOptions {
  readonly timeoutMs?: number
  readonly globalRequestsPerSecond?: number
  readonly maxRateLimitWaitMs?: number
  readonly onRateLimited?: (event: RateLimitData) => void
}

export interface DiscordJsTransport extends DiscordTransport {
  readonly rest: REST
}

export const discordJsTransport = (
  token: string,
  authPrefix: 'Bot' | 'Bearer' = 'Bot',
  options: DiscordJsRestOptions = {},
): DiscordJsTransport => {
  const maximumWait = options.maxRateLimitWaitMs ?? 30_000
  const rest = new REST({
    version: '10',
    authPrefix,
    retries: 0,
    timeout: options.timeoutMs ?? 15_000,
    globalRequestsPerSecond: options.globalRequestsPerSecond ?? 50,
    rejectOnRateLimit: ({ timeToReset }) => timeToReset > maximumWait,
  }).setToken(token)
  if (options.onRateLimited) rest.on(RESTEvents.RateLimited, options.onRateLimited)
  const methods = {
    GET: RequestMethod.Get,
    POST: RequestMethod.Post,
    PUT: RequestMethod.Put,
    PATCH: RequestMethod.Patch,
    DELETE: RequestMethod.Delete,
  } as const
  return {
    rest,
    request: async ({ method, route, query, body, reason, files, auth, signal }) =>
      rest.request({
        fullRoute: route as RouteLike,
        method: methods[method],
        ...(query === undefined ? {} : { query }),
        ...(body === undefined ? {} : { body }),
        ...(reason === undefined ? {} : { reason }),
        ...(files === undefined ? {} : { files: [...files] }),
        ...(auth === undefined ? {} : { auth }),
        signal,
      }),
  }
}
