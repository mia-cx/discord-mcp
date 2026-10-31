import { createHash } from 'node:crypto'
import type { BotRuntimes } from '@discord-mcp/bot-host'
import {
  authorizeWithPrincipal,
  type Principal,
  registerTools,
  renderCause,
} from '@discord-mcp/core'
import {
  createRateLimiter,
  DEFAULT_WINDOW_MS,
  DiscordRest,
  OperationCatalog,
  type RateLimiter,
  type RestConfig,
  relayTools,
} from '@discord-mcp/discord-api/relay'
import { type IsolateHost, makeIsolateHost, ScriptRunner, scriptRun } from '@discord-mcp/isolate'
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server'
import { Effect, Layer, ManagedRuntime, Redacted } from 'effect'
import { createDiscordLogin, type LoginConfig } from './login.ts'
import { botIdFromToken } from './router.ts'

export interface RelayConfig {
  readonly allowedHosts: ReadonlyArray<string>
  readonly allowedOrigins: ReadonlyArray<string>
  readonly login: LoginConfig
}

/**
 * The token lives only in this runtime, which the HTTP handler disposes after one response.
 * The isolate host is process-wide, so one bot's scripts queue behind each other across requests.
 */
export const relayRuntime = (rest: Layer.Layer<DiscordRest>, isolates: IsolateHost) =>
  ManagedRuntime.make(
    Layer.mergeAll(rest, OperationCatalog.layer, Layer.succeed(ScriptRunner)(isolates)),
  )

/**
 * Register the same fixed bot-only tools for HTTP requests and local stdio. `scripts` adds
 * `discord_script_run`, which runs agent code on this host.
 */
export const buildRelayServer = (runtime: ReturnType<typeof relayRuntime>, scripts: boolean) => {
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
    tools: scripts ? [...relayTools, scriptRun] : relayTools,
    selection: { toolsets: new Set(['operator', 'api']), enabledGates: new Set(['always']) },
    runtime,
    authorize: authorizeWithPrincipal(() => Effect.succeed(principal)),
    authProfile: 'bot',
  })
  return server
}

export const json = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response =>
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
 * Runs one authenticated MCP request as the bot whose token it carries. `botId` is the ID that
 * token names, which routing used; whoever runs the request still checks the token with Discord.
 */
export type Execute = (request: Request, credential: string, botId: string) => Promise<Response>

/** An idle bot's limiter lasts as long as its guard remembers rejections, so neither resets early. */
const LIMITER_IDLE_MS = DEFAULT_WINDOW_MS

export interface ExecutorOptions {
  readonly rest: Omit<RestConfig, 'token'>
  /** Discord's network, for REST. */
  readonly discordFetch?: typeof fetch
  /** With `bots`, each verified call keeps its bot online and stores its token encrypted. */
  readonly bots?: Pick<BotRuntimes, 'use'> | undefined
  /**
   * Offer `discord_script_run`, which runs agent code on this host. Running agent code is a
   * platform feature, which an unrestricted relay never offers.
   */
  readonly scripts?: boolean
  /** The Discord REST seam used by offline integration tests. */
  readonly restLayer?: (
    token: Redacted.Redacted<string>,
    limiter: RateLimiter,
  ) => Layer.Layer<DiscordRest>
}

/**
 * Runs requests the way a bot host does: Discord checks the bot token on every request, and every
 * request it accepts for one bot queues in that bot's one rate limiter. Limiters keep only a hash of
 * the token Discord last accepted, so without `bots`, bot credentials, identities, and Discord
 * responses never outlive the request.
 */
export const createExecutor = ({
  rest,
  discordFetch = fetch,
  bots,
  scripts = false,
  restLayer = DiscordRest.shared,
}: ExecutorOptions): Execute => {
  const isolates = makeIsolateHost()
  /** Each bot's limiter, with the fingerprint of the token Discord last accepted for it. */
  const limiters = new Map<
    string,
    { limiter: RateLimiter; accepted?: string; active: number; idleSince: number }
  >()
  const acquire = (botId: string) => {
    const now = Date.now()
    for (const [id, entry] of limiters) {
      if (entry.active > 0 || now - entry.idleSince < LIMITER_IDLE_MS) continue
      limiters.delete(id)
      entry.limiter.close()
    }
    const entry = limiters.get(botId) ?? {
      limiter: createRateLimiter(rest, discordFetch),
      active: 0,
      idleSince: now,
    }
    limiters.set(botId, entry)
    entry.active += 1
    return entry
  }
  const release = (entry: { active: number; idleSince: number }) => {
    entry.active -= 1
    entry.idleSince = Date.now()
  }

  /**
   * Check the token with Discord, queueing in `shared`'s buckets when given and otherwise on a
   * client of its own. A rejected token is not yet known to be the bot's, so its rejections always
   * go to a guard of their own, never the one the bot's accepted requests share.
   */
  const verify = async (
    token: Redacted.Redacted<string>,
    signal: AbortSignal,
    shared?: RateLimiter,
  ) => {
    const own = createRateLimiter(rest, discordFetch)
    try {
      return await Effect.runPromiseExit(
        Effect.flatMap(DiscordRest, (rest) =>
          rest.request({ method: 'GET', route: '/users/@me', operationFamily: 'authentication' }),
        ).pipe(Effect.provide(restLayer(token, { ...(shared ?? own), guard: own.guard }))),
        { signal },
      )
    } finally {
      own.close()
    }
  }

  const run = async (request: Request, runtime: ReturnType<typeof relayRuntime>) => {
    const mcp = createMcpHandler(() => buildRelayServer(runtime, scripts), {
      legacy: 'stateless',
      maxSubscriptions: 0,
    })
    try {
      const response = await mcp.fetch(request)
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

  return async (request, credential, botId) => {
    const token = Redacted.make(credential)
    const fingerprint = createHash('sha256').update(credential).digest('base64url')
    // Anyone can name a bot's public ID, so only the token Discord last accepted for this bot
    // checks in through the bot's buckets. Any other token, forged or freshly reset, gets a client
    // of its own and so never queues ahead of the bot's requests.
    let lane = limiters.get(botId)?.accepted === fingerprint ? acquire(botId) : undefined
    try {
      const verified = await verify(token, request.signal, lane?.limiter)
      if (verified._tag === 'Failure') {
        const error = renderCause(verified.cause)
        // Discord now rejects the token it last accepted, so it was reset: its retries must not
        // keep queueing in the buckets the bot's new token will share.
        if (error.httpStatus === 401 && lane?.accepted === fingerprint) delete lane.accepted
        return discordFailure(error)
      }
      // A token whose first segment names another bot was routed by a lie.
      if (!isBot(verified.value) || verified.value.id !== botId) return invalidBot()
      // Hosting never delays or fails the agent's call; `use` logs its own failures.
      void bots?.use(botId, credential)
      lane ??= acquire(botId)
      lane.accepted = fingerprint
      return await run(request, relayRuntime(restLayer(token, lane.limiter), isolates))
    } finally {
      if (lane !== undefined) release(lane)
    }
  }
}

/**
 * The MCP HTTP front: OAuth, the allowlist, origins, and the bot token's shape. `execute` runs each
 * request, in this process or on the bot host that owns its bot.
 */
export const createRelay = (
  config: RelayConfig,
  execute: Execute,
  discordFetch: typeof fetch = fetch,
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
    const botId = botIdFromToken(credential)
    if (botId === undefined) return invalidBot()
    return execute(request, credential, botId)
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
