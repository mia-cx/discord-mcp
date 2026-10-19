import {
  authorizeWithPrincipal,
  type Principal,
  registerTools,
  renderCause,
} from '@discord-mcp/core'
import {
  DiscordRest,
  OperationCatalog,
  RateGuard,
  type RestConfig,
  relayTools,
} from '@discord-mcp/discord-api/relay'
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server'
import { Effect, Layer, ManagedRuntime, Redacted } from 'effect'

export interface RelayConfig {
  readonly allowedHosts: ReadonlyArray<string>
  readonly allowedOrigins: ReadonlyArray<string>
  readonly rest: Omit<RestConfig, 'token'>
}

/** The token lives only in this runtime, which the HTTP handler disposes after one response. */
export const relayRuntime = (rest: Layer.Layer<DiscordRest>) =>
  ManagedRuntime.make(Layer.merge(rest, OperationCatalog.layer))

/** Register the same fixed bot-only tools for HTTP requests and local stdio. */
export const buildRelayServer = (runtime: ReturnType<typeof relayRuntime>) => {
  const principal: Principal = {
    id: 'request-bot',
    kind: 'discord-bot',
    scopes: new Set(['mcp:read', 'mcp:write', 'mcp:destructive', 'bot:admin']),
  }
  const server = new McpServer(
    { name: 'discord-mcp', version: '0.1.0' },
    {
      instructions:
        'Discord API relay. Search with discord_api_search, inspect with discord_api_describe, then use the dispatcher matching the operation risk. Every call acts as the bot whose token accompanies this request. Discord permissions determine access.',
    },
  )
  registerTools({
    server,
    tools: relayTools,
    selection: { toolsets: new Set(['operator', 'api']), enabledGates: new Set(['always']) },
    runtime,
    authorize: authorizeWithPrincipal(() => Effect.succeed(principal)),
    authProfile: 'bot',
  })
  return server
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  })

const unauthorized = () =>
  json(
    401,
    {
      error: 'invalid_token',
      error_description: 'Supply a valid Discord bot token as Bearer auth.',
    },
    { 'www-authenticate': 'Bearer realm="discord-mcp", error="invalid_token"' },
  )

const isBot = (value: unknown) =>
  typeof value === 'object' && value !== null && 'bot' in value && value.bot === true

/**
 * Stateless MCP HTTP relay. Discord validates every supplied token, including discovery requests.
 * No credential, identity, session, or Discord response survives the request.
 * `restLayer` is the Discord network seam used by offline integration tests.
 */
export const createRelay = (
  config: RelayConfig,
  restLayer: (token: Redacted.Redacted<string>) => Layer.Layer<DiscordRest> = (token) =>
    DiscordRest.layer({ ...config.rest, token }).pipe(Layer.provide(RateGuard.layer())),
) => ({
  fetch: async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    if (config.allowedHosts.length > 0 && !config.allowedHosts.includes(url.hostname)) {
      return json(421, { error: 'misdirected_request' })
    }
    const origin = request.headers.get('origin')
    if (origin !== null && origin !== url.origin && !config.allowedOrigins.includes(origin)) {
      return json(403, { error: 'invalid_origin' })
    }
    if (url.pathname === '/health/live' || url.pathname === '/health/ready') {
      return json(200, { ok: true })
    }
    if (url.pathname !== '/mcp') return json(404, { error: 'not_found' })

    const credential = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') ?? '')?.[1]
    if (credential === undefined) return unauthorized()

    const runtime = relayRuntime(restLayer(Redacted.make(credential)))
    const mcp = createMcpHandler(() => buildRelayServer(runtime), {
      legacy: 'stateless',
      maxSubscriptions: 0,
    })
    try {
      const verified = await runtime.runPromiseExit(
        Effect.flatMap(DiscordRest, (rest) =>
          rest.request({ method: 'GET', route: '/users/@me', operationFamily: 'authentication' }),
        ),
        { signal: request.signal },
      )
      if (verified._tag === 'Failure') {
        const error = renderCause(verified.cause)
        if (error.httpStatus === 401) return unauthorized()
        if (error.code === 'DiscordRateLimitError') {
          return json(
            429,
            { error: 'discord_rate_limited' },
            { 'retry-after': String(Math.ceil((error.retryAfterMs ?? 1000) / 1000)) },
          )
        }
        return json(502, { error: 'discord_unavailable' })
      }
      if (!isBot(verified.value)) return unauthorized()

      const response = await mcp.fetch(request)
      // Complete the bounded response before releasing the runtime. The SDK's legacy fallback
      // can return an SSE body before its tool finishes.
      const body = await response.arrayBuffer()
      const headers = new Headers(response.headers)
      headers.set('cache-control', 'no-store')
      return new Response(body.byteLength === 0 ? null : body, { status: response.status, headers })
    } catch {
      return json(502, { error: 'request_failed' })
    } finally {
      await mcp.close()
      await runtime.dispose()
    }
  },
})
