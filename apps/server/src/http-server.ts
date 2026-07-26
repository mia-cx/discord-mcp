import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  evaluateProxyTrust,
  makeJwks,
  narrowScopes,
  type OidcConfig,
  PrincipalStore,
  type ProxyTrustConfig,
  verifyAccessToken,
} from '@discord-mcp/auth'
import { AuthenticationError, type Principal } from '@discord-mcp/core'
import type { McpServer } from '@modelcontextprotocol/server'
import { createMcpHandler } from '@modelcontextprotocol/server'
import { Effect, type ManagedRuntime } from 'effect'

/**
 * The authenticated Streamable HTTP transport.
 *
 * Three ways in — OIDC bearer, personal access token, trusted proxy identity — all producing the
 * same `Principal`, so nothing downstream can accidentally behave differently depending on how
 * someone authenticated. That equivalence is the point of resolving identity here rather than in
 * each tool.
 */

export interface HttpConfig {
  readonly host: string
  readonly port: number
  readonly allowedHosts: ReadonlyArray<string>
  readonly publicBaseUrl: string | undefined
  readonly proxy: ProxyTrustConfig
  readonly oidc: OidcConfig | undefined
}

/** The OAuth callback is read by a human in a browser, so it answers in HTML rather than JSON. */
const html = (status: number, message: string) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><title>discord-mcp</title><p style="font-family:system-ui;padding:2rem">${message}</p>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8' } },
  )

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })

/**
 * `WWW-Authenticate` with the protected-resource metadata URL, so a client can discover where to
 * get a token rather than guessing.
 */
const unauthorized = (message: string, resourceMetadataUrl: string | undefined) =>
  json(
    401,
    { error: 'invalid_token', error_description: message },
    {
      'www-authenticate': `Bearer error="invalid_token", error_description="${message.replaceAll('"', "'")}"${
        resourceMetadataUrl === undefined ? '' : `, resource_metadata="${resourceMetadataUrl}"`
      }`,
    },
  )

/**
 * Reject an unexpected `Host` before anything else looks at the request.
 *
 * Not authentication — CORS and Host are never the access-control decision — but a Host the
 * operator did not configure means the request did not arrive the way they intended, and DNS
 * rebinding is exactly that shape.
 */
export const hostAllowed = (host: string | null, allowed: ReadonlyArray<string>): boolean =>
  allowed.length === 0 || (host !== null && allowed.includes(host.split(':')[0] as string))

export interface ResolvedIdentity {
  readonly principal: Principal
  readonly method: 'oauth' | 'pat' | 'trusted-proxy'
}

/**
 * Resolve one request to a principal.
 *
 * Ordered by specificity: an explicit `Authorization` header is a deliberate assertion, so it wins
 * over an ambient proxy header. A request carrying both should be judged on the credential its
 * sender chose to present.
 */
export const resolveIdentity = (
  request: Request,
  remoteAddress: string,
  config: HttpConfig,
  verify:
    | ((token: string) => Effect.Effect<{ scopes: ReadonlyArray<string> }, AuthenticationError>)
    | undefined,
): Effect.Effect<ResolvedIdentity, AuthenticationError, PrincipalStore> =>
  Effect.gen(function* () {
    const store = yield* PrincipalStore
    const authorization = request.headers.get('authorization')

    if (authorization !== null) {
      const token = authorization.replace(/^Bearer\s+/i, '')

      // A PAT is recognisable by prefix, so it never reaches the OIDC verifier and produces a
      // confusing "not a JWT" error.
      if (token.startsWith('dcmcp_')) {
        const principal = yield* Effect.mapError(store.authenticateToken(token), (cause) =>
          cause._tag === 'AuthenticationError'
            ? cause
            : new AuthenticationError({ message: 'Token lookup failed.' }),
        )
        return { principal, method: 'pat' as const }
      }

      if (verify === undefined) {
        return yield* Effect.fail(
          new AuthenticationError({
            message:
              'A bearer token was presented but no OIDC issuer is configured. Set OIDC_ISSUER, OIDC_AUDIENCE, and OIDC_JWKS_URI, or use a personal access token.',
          }),
        )
      }

      const verified = yield* verify(token)
      const principal = yield* Effect.mapError(
        store.get('oauth'),
        () => new AuthenticationError({ message: 'Principal lookup failed.' }),
      )
      if (principal === undefined) {
        return yield* Effect.fail(
          new AuthenticationError({
            message:
              'The token verified, but no principal named "oauth" is configured to map it to local scopes. Create one with: discord-mcp principal create oauth "OIDC users" <scopes>',
          }),
        )
      }

      // Intersected, never unioned: an external provider cannot widen what we granted.
      return { principal: narrowScopes(principal, verified.scopes), method: 'oauth' as const }
    }

    const trust = evaluateProxyTrust(config.proxy, {
      remoteAddress,
      host: request.headers.get('host') ?? undefined,
      forwardedProto: request.headers.get('x-forwarded-proto') ?? undefined,
      headers: Object.fromEntries([...request.headers.entries()]),
    })

    if (!trust.trusted) {
      return yield* Effect.fail(
        new AuthenticationError({
          message: `No usable credential. ${trust.reason}`,
        }),
      )
    }

    const principal = yield* Effect.mapError(
      store.resolveProxyIdentity(trust.identity),
      () => new AuthenticationError({ message: 'Proxy identity lookup failed.' }),
    )
    if (principal === undefined) {
      return yield* Effect.fail(
        new AuthenticationError({
          message: `The proxy identified "${trust.identity}", but no principal is bound to that identity. Bind one before it can be used.`,
        }),
      )
    }
    return { principal, method: 'trusted-proxy' as const }
  })

export interface HttpServerHandle {
  readonly port: number
  readonly close: () => Promise<void>
}

/** Where a client learns which authorization server issues tokens for this resource. */
const protectedResourceMetadata = (config: HttpConfig) => ({
  resource: config.publicBaseUrl ?? `http://${config.host}:${config.port}`,
  ...(config.oidc === undefined ? {} : { authorization_servers: [config.oidc.issuer] }),
  bearer_methods_supported: ['header'],
  scopes_supported: [
    'mcp:read',
    'mcp:write',
    'mcp:destructive',
    'bot:admin',
    'server:plan',
    'server:apply',
  ],
})

interface HandlerDeps<R> {
  readonly config: HttpConfig
  /** Handles a signed Discord interaction. Absent when DISCORD_PUBLIC_KEY is unset. */
  readonly handleInteraction:
    | ((input: {
        signature: string | null
        timestamp: string | null
        rawBody: Uint8Array
      }) => Effect.Effect<{ status: number; body: unknown }, unknown, R>)
    | undefined
  /** Completes a Discord OAuth2 flow. Absent when no client credentials are configured. */
  readonly completeOAuth:
    | ((state: string, code: string) => Effect.Effect<{ readonly name: string }, unknown, R>)
    | undefined
  readonly verify:
    | ((token: string) => Effect.Effect<{ scopes: ReadonlyArray<string> }, AuthenticationError>)
    | undefined
  readonly metadataUrl: string | undefined
  readonly mcp: McpHandler
  readonly runtime: ManagedRuntime.ManagedRuntime<R | PrincipalStore, never>
  readonly setIdentity: (identity: ResolvedIdentity) => void
}

interface McpHandler {
  readonly fetch: (request: Request) => Promise<Response>
  readonly close: () => Promise<void>
}

/** Endpoints that answer before authentication, because they have to. */
const unauthenticatedRoute = (pathname: string, config: HttpConfig): Response | undefined => {
  if (pathname === '/health/live' || pathname === '/health/ready') {
    // Deliberately no detail: a health endpoint is unauthenticated, so anything it says is public.
    return json(200, { status: 'ok' })
  }
  if (pathname === '/.well-known/oauth-protected-resource') {
    return json(200, protectedResourceMetadata(config))
  }
  return undefined
}

const readBody = async (req: IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

const toRequest = (req: IncomingMessage, url: URL, body: Buffer): Request =>
  new Request(url, {
    method: req.method ?? 'GET',
    headers: Object.entries(req.headers).flatMap(([k, v]) =>
      v === undefined ? [] : [[k, Array.isArray(v) ? v.join(', ') : v] as [string, string]],
    ),
    // Node's Request accepts a Uint8Array body; @types/node omits BodyInit globally.
    ...(body.length > 0 ? { body: new Uint8Array(body) } : {}),
  })

/**
 * Discord posts here. Authentication is the Ed25519 signature, checked over the raw bytes before
 * anything decodes them — see `routeInteraction`.
 */
const handleInteractionRoute = async <R>(
  req: IncomingMessage,
  deps: HandlerDeps<R>,
): Promise<Response> => {
  if (deps.handleInteraction === undefined) {
    return json(503, {
      error: 'interactions_not_configured',
      error_description:
        'DISCORD_PUBLIC_KEY is not set, so interaction signatures cannot be verified.',
    })
  }

  const raw = await readBody(req)
  const result = await deps.runtime.runPromiseExit(
    deps.handleInteraction({
      signature: (req.headers['x-signature-ed25519'] as string | undefined) ?? null,
      timestamp: (req.headers['x-signature-timestamp'] as string | undefined) ?? null,
      rawBody: new Uint8Array(raw),
    }) as Effect.Effect<{ status: number; body: unknown }, unknown, R>,
  )

  return result._tag === 'Success'
    ? json(result.value.status, result.value.body)
    : json(500, { error: 'internal_error' })
}

/**
 * Discord redirects a browser here after the user approves a profile.
 *
 * Authentication is the state parameter and PKCE, not a bearer token: the user's browser holds no
 * credential for this server and never should.
 */
const handleOAuthCallbackRoute = async <R>(url: URL, deps: HandlerDeps<R>): Promise<Response> => {
  const state = url.searchParams.get('state')
  const code = url.searchParams.get('code')

  if (deps.completeOAuth === undefined) {
    return html(400, 'Discord OAuth2 is not configured on this server.')
  }
  if (state === null || code === null) {
    return html(400, 'Discord did not return a state and code. Start the flow again.')
  }

  const completed = await deps.runtime.runPromiseExit(
    deps.completeOAuth(state, code) as Effect.Effect<{ name: string }, unknown, R>,
  )

  return completed._tag === 'Success'
    ? html(200, `Profile "${completed.value.name}" is authorized. You can close this window.`)
    : // No detail: this page is reachable by anyone with a guessed state, and the failure reasons
      // distinguish unknown from expired, which is not something to publish.
      html(400, 'Authorization failed or expired. Start the flow again from your agent.')
}

const makeRequestHandler =
  <R>(deps: HandlerDeps<R | PrincipalStore>) =>
  async (req: IncomingMessage): Promise<Response> => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)

    const open = unauthenticatedRoute(url.pathname, deps.config)
    if (open !== undefined) return open

    // Both of these carry their own proof — a signature and a state parameter — so neither needs
    // an MCP credential, and requiring one would make them impossible to call.
    if (url.pathname === '/discord/interactions') return handleInteractionRoute(req, deps)
    if (url.pathname === '/oauth/discord/callback') return handleOAuthCallbackRoute(url, deps)

    if (!hostAllowed(req.headers.host ?? null, deps.config.allowedHosts)) {
      return json(421, {
        error: 'misdirected_request',
        error_description: `Host "${req.headers.host ?? ''}" is not in ALLOWED_HOSTS.`,
      })
    }

    if (url.pathname !== '/mcp') return json(404, { error: 'not_found' })

    const request = toRequest(req, url, await readBody(req))

    const identity = await deps.runtime.runPromiseExit(
      resolveIdentity(
        request,
        req.socket.remoteAddress ?? '',
        deps.config,
        deps.verify,
      ) as Effect.Effect<ResolvedIdentity, AuthenticationError, PrincipalStore>,
    )

    // One message for every authentication failure. Distinguishing "unknown token" from "identity
    // not bound" over the wire would tell an attacker which half of the problem to work on.
    if (identity._tag === 'Failure') {
      return unauthorized('Authentication failed.', deps.metadataUrl)
    }

    deps.setIdentity(identity.value)
    return deps.mcp.fetch(request)
  }

export const startHttpServer = <R>(options: {
  readonly config: HttpConfig
  readonly buildServer: (resolve: () => Effect.Effect<Principal, AuthenticationError>) => McpServer
  readonly runtime: ManagedRuntime.ManagedRuntime<R | PrincipalStore, never>
  readonly completeOAuth?:
    | ((
        state: string,
        code: string,
      ) => Effect.Effect<{ readonly name: string }, unknown, R | PrincipalStore>)
    | undefined
  readonly handleInteraction?:
    | ((input: {
        signature: string | null
        timestamp: string | null
        rawBody: Uint8Array
      }) => Effect.Effect<{ status: number; body: unknown }, unknown, R | PrincipalStore>)
    | undefined
}): Effect.Effect<HttpServerHandle> =>
  Effect.promise(
    () =>
      new Promise<HttpServerHandle>((resolve) => {
        const { config } = options
        const jwks = config.oidc === undefined ? undefined : makeJwks(config.oidc)
        const verify =
          config.oidc === undefined || jwks === undefined
            ? undefined
            : verifyAccessToken(config.oidc, jwks)

        // Identity is resolved per request and read by the MCP handler through this slot, because
        // `registerTool`'s callback cannot take extra arguments.
        let current: ResolvedIdentity | undefined

        const mcp = createMcpHandler(
          () =>
            options.buildServer(() =>
              current === undefined
                ? Effect.fail(new AuthenticationError({ message: 'No authenticated principal.' }))
                : Effect.succeed(current.principal),
            ),
          { onerror: () => undefined },
        )

        const handle = makeRequestHandler({
          config,
          completeOAuth: options.completeOAuth,
          handleInteraction: options.handleInteraction,
          verify,
          metadataUrl:
            config.publicBaseUrl === undefined
              ? undefined
              : `${config.publicBaseUrl}/.well-known/oauth-protected-resource`,
          mcp,
          runtime: options.runtime,
          setIdentity: (identity) => {
            current = identity
          },
        })

        const server = createServer((req, res) => {
          void handle(req).then(async (response) => {
            res.writeHead(response.status, Object.fromEntries(response.headers.entries()))
            res.end(await response.text())
          })
        })

        server.listen(config.port, config.host, () => {
          const address = server.address() as AddressInfo
          resolve({
            port: address.port,
            close: () =>
              new Promise<void>((done) => {
                void mcp.close().then(() => server.close(() => done()))
              }),
          })
        })
      }),
  )
