import type { BotRuntimes } from '@discord-mcp/bot-host'
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
import { createDiscordLogin, type LoginConfig } from './login.ts'

export interface RelayConfig {
  readonly allowedHosts: ReadonlyArray<string>
  readonly allowedOrigins: ReadonlyArray<string>
  readonly rest: Omit<RestConfig, 'token'>
  readonly login: LoginConfig
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

const invalidBot = () =>
  json(403, {
    error: 'invalid_bot_token',
    error_description: 'Supply a valid bot token in X-Discord-Bot-Token.',
  })

const isBot = (value: unknown): value is { bot: true; id: string } =>
  typeof value === 'object' &&
  value !== null &&
  'bot' in value &&
  value.bot === true &&
  'id' in value &&
  typeof value.id === 'string'

const allowedOrigin = (request: Request, origins: ReadonlyArray<string>) => {
  const origin = request.headers.get('origin')
  return origin === null || origin === new URL(request.url).origin || origins.includes(origin)
}

const discordFailure = (error: ReturnType<typeof renderCause>) => {
  if (error.httpStatus === 401) return invalidBot()
  if (error.code === 'DiscordRateLimitError') {
    return json(
      429,
      { error: 'discord_rate_limited' },
      {
        'retry-after': String(Math.ceil((error.retryAfterMs ?? 1000) / 1000)),
      },
    )
  }
  return json(502, { error: 'discord_unavailable' })
}

/**
 * MCP HTTP relay. Discord validates both login and bot credentials on every request.
 * Without `bots`, bot credentials, identities, and Discord responses never survive the request.
 * With `bots`, each verified call keeps its bot online and stores its token encrypted.
 * `restLayer` is the Discord network seam used by offline integration tests.
 */
export const createRelay = (
  config: RelayConfig,
  restLayer: (token: Redacted.Redacted<string>) => Layer.Layer<DiscordRest> = (token) =>
    DiscordRest.layer({ ...config.rest, token }).pipe(Layer.provide(RateGuard.layer())),
  discordFetch: typeof fetch = fetch,
  bots?: Pick<BotRuntimes, 'use'>,
) => {
  const login = createDiscordLogin(config.login, discordFetch)
  const handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    if (config.allowedHosts.length > 0 && !config.allowedHosts.includes(url.hostname)) {
      return json(421, { error: 'misdirected_request' })
    }
    if (url.pathname === '/health/live' || url.pathname === '/health/ready') {
      return json(200, { ok: true })
    }
    const oauth = await login.fetch(request)
    if (oauth !== undefined) return oauth
    if (!allowedOrigin(request, config.allowedOrigins)) {
      return json(403, { error: 'invalid_origin' })
    }
    if (url.pathname !== '/mcp') return json(404, { error: 'not_found' })
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'access-control-allow-methods': 'POST, GET, DELETE, OPTIONS',
          'access-control-allow-headers':
            'Authorization, X-Discord-Bot-Token, Content-Type, Accept, MCP-Method, MCP-Protocol-Version, MCP-Name, MCP-Session-Id, Last-Event-Id',
          'cache-control': 'no-store',
        },
      })
    }

    const authenticated = await login.authorize(request)
    if (authenticated instanceof Response) {
      authenticated.headers.set('cache-control', 'no-store')
      return authenticated
    }
    const credential = request.headers.get('x-discord-bot-token')
    if (credential === null || !/^\S+$/.test(credential)) return invalidBot()

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
        return discordFailure(renderCause(verified.cause))
      }
      if (!isBot(verified.value)) return invalidBot()
      await bots?.use(verified.value.id, credential)

      const response = await mcp.fetch(request, { authInfo: authenticated })
      // Complete the bounded response before releasing the runtime. The SDK's legacy fallback
      // can return an SSE body before its tool finishes.
      const body = await response.arrayBuffer()
      const headers = new Headers(response.headers)
      headers.set('cache-control', 'no-store')
      return new Response(body.byteLength === 0 ? null : body, {
        status: response.status,
        headers,
      })
    } catch {
      return json(502, { error: 'request_failed' })
    } finally {
      await mcp.close()
      await runtime.dispose()
    }
  }
  return {
    fetch: async (request: Request): Promise<Response> => {
      const response = await handle(request)
      const origin = request.headers.get('origin')
      if (
        new URL(request.url).pathname === '/mcp' &&
        origin !== null &&
        allowedOrigin(request, config.allowedOrigins)
      ) {
        response.headers.set('access-control-allow-origin', origin)
        response.headers.set(
          'access-control-expose-headers',
          'WWW-Authenticate, MCP-Protocol-Version, MCP-Session-Id, Retry-After',
        )
        response.headers.append('vary', 'Origin')
      }
      return response
    },
  }
}
