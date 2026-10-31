import { createHash, randomBytes } from 'node:crypto'
import { type RejectionLog, rejectionLog } from '@discord-mcp/discord-api/relay'
import {
  type AuthInfo,
  bearerAuthChallengeResponse,
  OAuthError,
  OAuthErrorCode,
  oauthMetadataResponse,
  verifyBearerToken,
} from '@modelcontextprotocol/server'
import { Redacted, Schema } from 'effect'
import { EncryptJWT, type JWTPayload, jwtDecrypt } from 'jose'

const FLOW_SECONDS = 600
const CODE_SECONDS = 60
const ACCESS_SECONDS = 7 * 24 * 3600
const CLIENT_SECONDS = 30 * 24 * 3600
// Each refresh issues a new envelope, so active logins never lapse; an idle one dies after this.
const REFRESH_SECONDS = 30 * 24 * 3600
const MAX_CODES = 10_000
const BODY_LIMIT = 16_384
const DISCORD_TIMEOUT_MS = 15_000
const REFUSAL_RETRY_SECONDS = '60'
const CONSENT_STYLES =
  'body{font:1rem/1.5 system-ui;max-width:60ch;margin:2rem auto;padding:0 1rem;color:#111;background:#fff}form{display:flex;flex-wrap:wrap;gap:.75rem}button{font:inherit;min-height:44px;padding:.5rem 1rem}'
const CONSENT_STYLE_HASH = createHash('sha256').update(CONSENT_STYLES).digest('base64')
const random = () => randomBytes(32).toString('base64url')
const challenge = (value: string) => createHash('sha256').update(value).digest('base64url')
const now = () => Math.floor(Date.now() / 1000)
const text = (value: unknown) => {
  if (typeof value !== 'string' || value.length === 0) throw new Error('Missing value')
  return value
}

const TokenResponse = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.String,
  expires_in: Schema.Number,
  scope: Schema.String,
  token_type: Schema.Literal('Bearer'),
})
const Authorization = Schema.Struct({
  application: Schema.Struct({ id: Schema.String }),
  user: Schema.Struct({ id: Schema.String, bot: Schema.optional(Schema.Boolean) }),
  scopes: Schema.Array(Schema.String),
  expires: Schema.String,
})
const Registration = Schema.Struct({
  redirect_uris: Schema.Array(Schema.String),
  client_name: Schema.optional(Schema.String),
  token_endpoint_auth_method: Schema.optional(Schema.Literal('none')),
  grant_types: Schema.optional(
    Schema.Array(Schema.Literals(['authorization_code', 'refresh_token'])),
  ),
  response_types: Schema.optional(Schema.Array(Schema.Literal('code'))),
})

export interface LoginConfig {
  readonly publicBaseUrl: string
  readonly clientId: string
  readonly clientSecret: Redacted.Redacted<string>
  /** A stable, random 32-byte base64 key. Rotation invalidates all issued credentials. */
  readonly encryptionKey: Redacted.Redacted<string>
  /** Undefined allows any human; an empty list denies everyone. Checked on every request. */
  readonly allowedUserIds?: ReadonlyArray<string>
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
      ...headers,
    },
  })

class DiscordUnavailable extends Error {
  constructor(
    readonly status: number,
    readonly retryAfter: string,
  ) {
    super('Discord unavailable')
  }
}
class DiscordAccessDenied extends Error {}
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const safeRedirect = (value: string) => {
  const url = new URL(value)
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
  if (
    (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) ||
    url.username ||
    url.password ||
    url.hash ||
    value.length > 2048
  )
    throw new Error('Invalid redirect URI')
  return value
}

/** Read untrusted OAuth bodies with a byte limit, including chunked requests. */
const readBody = async (request: Request) => {
  const reader = request.body?.getReader()
  if (reader === undefined) throw new Error('Missing body')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) return Buffer.concat(chunks).toString('utf8')
      size += chunk.value.byteLength
      if (size > BODY_LIMIT) throw new Error('Body too large')
      chunks.push(chunk.value)
    }
  } finally {
    await reader.cancel()
    reader.releaseLock()
  }
}

/**
 * Discord-backed OAuth issuer and resource gate. Bot credentials never enter this module.
 * Login state and Discord grants travel in purpose-bound AES-GCM envelopes, not a database.
 * Only spent authorization-code hashes live in memory, until their one-minute expiry.
 * Refresh envelopes enclose Discord's rotating refresh token, so Discord rejects any replay.
 * `discordFetch` is the external network seam, shared by login and per-request revocation checks.
 * `rejections` is the process's shared count of Discord's 401/403/429 responses.
 */
export const createDiscordLogin = (
  config: LoginConfig,
  discordFetch: typeof fetch = fetch,
  rejections: RejectionLog = rejectionLog(),
): {
  authorize: (request: Request) => Promise<AuthInfo | Response>
  fetch: (request: Request) => Promise<Response | undefined>
} => {
  if (config.allowedUserIds?.some((id) => !/^\d{17,21}$/.test(id))) {
    throw new Error('DISCORD_OAUTH_ALLOWED_USER_IDS must contain Discord user IDs.')
  }
  const allowedUsers =
    config.allowedUserIds === undefined ? undefined : new Set(config.allowedUserIds)
  const base = new URL(config.publicBaseUrl)
  if (base.pathname !== '/' || base.search || base.hash || base.username || base.password) {
    throw new Error('PUBLIC_BASE_URL must be an origin, without a path or credentials.')
  }
  if (
    base.protocol !== 'https:' &&
    !(base.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname))
  ) {
    throw new Error('PUBLIC_BASE_URL must use HTTPS outside loopback.')
  }
  const issuer = base.origin
  const resource = `${issuer}/mcp`
  const callback = `${issuer}/auth/discord/callback`
  const metadataUrl = `${issuer}/.well-known/oauth-protected-resource/mcp`
  const key = Buffer.from(Redacted.value(config.encryptionKey), 'base64')
  if (key.length !== 32) throw new Error('OAUTH_ENCRYPTION_KEY must encode 32 random bytes.')
  const cookieName = base.protocol === 'https:' ? '__Host-discord-mcp-login' : 'discord-mcp-login'
  const cookie = (nonce: string, age = FLOW_SECONDS) =>
    `${cookieName}=${nonce}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${base.protocol === 'https:' ? '; Secure' : ''}`
  // Login codes cannot be replayed after a process restart discards the spent-code set.
  const epoch = random()
  const seal = (kind: string, claims: JWTPayload, lifetime: number) =>
    new EncryptJWT({ ...claims, ...(['code', 'flow'].includes(kind) ? { epoch } : {}) })
      .setProtectedHeader({ alg: 'dir', enc: 'A256GCM', typ: `discord-mcp-${kind}+jwt` })
      .setIssuer(issuer)
      .setAudience(kind === 'access' ? resource : `${issuer}/${kind}`)
      .setIssuedAt()
      .setExpirationTime(now() + lifetime)
      .setJti(random())
      .encrypt(key)
  const open = async (kind: string, token: string) => {
    const { payload } = await jwtDecrypt(token, key, {
      issuer,
      audience: kind === 'access' ? resource : `${issuer}/${kind}`,
      typ: `discord-mcp-${kind}+jwt`,
      keyManagementAlgorithms: ['dir'],
      contentEncryptionAlgorithms: ['A256GCM'],
      requiredClaims: ['exp', 'iat', 'jti'],
    })
    if (['code', 'flow'].includes(kind) && payload.epoch !== epoch)
      throw new Error('Restarted login')
    return payload
  }
  const spent = new Map<string, number>()
  const consumeCode = (claims: JWTPayload) => {
    for (const [id, expiry] of spent) if (expiry <= now()) spent.delete(id)
    const id = challenge(text(claims.jti))
    if (spent.has(id) || spent.size >= MAX_CODES) throw new Error('Code already used or busy')
    spent.set(id, claims.exp ?? now() + CODE_SECONDS)
  }
  const checkBrowser = (request: Request, claims: JWTPayload) => {
    const nonce = request.headers
      .get('cookie')
      ?.split(';')
      .map((v) => v.trim())
      .find((v) => v.startsWith(`${cookieName}=`))
      ?.slice(cookieName.length + 1)
    if (nonce === undefined || nonce !== claims.nonce) throw new Error('Wrong browser state')
  }
  /** `scope` groups Discord's rejections, which this process stops sending after a threshold. */
  const discordJson = async (path: string, scope: string, init: RequestInit = {}) => {
    const admission = rejections.admit([scope], Date.now())
    if (!('settle' in admission)) throw new DiscordUnavailable(429, REFUSAL_RETRY_SECONDS)
    let response: Response
    try {
      response = await discordFetch(`https://discord.com/api/v10${path}`, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(DISCORD_TIMEOUT_MS),
      })
      admission.settle(response.status, Date.now())
    } finally {
      // A request that never got an answer counts as rejected, since Discord may have seen it.
      admission.settle(0, Date.now())
    }
    if (response.status === 401 || response.status === 400) {
      throw new OAuthError(
        OAuthErrorCode.InvalidToken,
        'Discord authorization expired or was revoked.',
      )
    }
    if (!response.ok)
      throw new DiscordUnavailable(
        response.status === 429 ? 429 : 502,
        /^\d+$/.test(response.headers.get('retry-after') ?? '')
          ? (response.headers.get('retry-after') ?? '1')
          : '1',
      )
    return response.json() as Promise<unknown>
  }
  const identity = async (token: string, subject?: string) => {
    const auth = Schema.decodeUnknownSync(Authorization)(
      await discordJson('/oauth2/@me', `login/${subject ?? 'new'}`, {
        headers: { authorization: `Bearer ${token}` },
      }),
    )
    if (
      auth.application.id !== config.clientId ||
      !auth.scopes.includes('identify') ||
      auth.user.bot === true ||
      !/^\d+$/.test(auth.user.id) ||
      !Number.isFinite(Date.parse(auth.expires)) ||
      Date.parse(auth.expires) <= Date.now() ||
      (subject !== undefined && auth.user.id !== subject)
    )
      throw new OAuthError(OAuthErrorCode.InvalidToken, 'Invalid Discord authorization.')
    if (allowedUsers !== undefined && !allowedUsers.has(auth.user.id)) {
      throw new DiscordAccessDenied(
        'Your Discord account is not on this relay’s allowlist. Ask the operator for access.',
      )
    }
    return auth.user.id
  }
  /** `subject` keeps a refresh out of the scope that anonymous sign-ins share. */
  const exchange = async (parameters: Record<string, string>, subject = 'new') => {
    const tokens = Schema.decodeUnknownSync(TokenResponse)(
      await discordJson('/oauth2/token', `login/token/${subject}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          ...parameters,
          client_id: config.clientId,
          client_secret: Redacted.value(config.clientSecret),
        }),
      }),
    )
    if (!tokens.scope.split(' ').includes('identify') || tokens.expires_in <= 0) {
      throw new Error('Missing identify scope')
    }
    return tokens
  }
  const issue = async (tokens: typeof TokenResponse.Type, clientId: string, subject: string) => {
    const expiresIn = Math.min(ACCESS_SECONDS, Math.floor(tokens.expires_in))
    return json(200, {
      access_token: await seal(
        'access',
        { sub: subject, clientId, discordToken: tokens.access_token },
        expiresIn,
      ),
      refresh_token: await seal(
        'refresh',
        { sub: subject, clientId, discordRefresh: tokens.refresh_token },
        REFRESH_SECONDS,
      ),
      token_type: 'Bearer',
      expires_in: expiresIn,
      scope: 'mcp',
    })
  }
  const bearerOptions = {
    expectedResource: new URL(resource),
    requiredScopes: ['mcp'],
    resourceMetadataUrl: metadataUrl,
    verifier: {
      verifyAccessToken: async (token: string) => {
        let claims: JWTPayload
        try {
          claims = await open('access', token)
        } catch {
          throw new OAuthError(OAuthErrorCode.InvalidToken, 'Log in with Discord again.')
        }
        const subject = await identity(text(claims.discordToken), text(claims.sub))
        return {
          token,
          clientId: text(claims.clientId),
          scopes: ['mcp'],
          expiresAt: claims.exp ?? 0,
          resource: new URL(resource),
          extra: { discordUserId: subject },
        }
      },
    },
  }
  const metadata = {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    registration_endpoint: `${issuer}/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: ['mcp'],
    authorization_response_iss_parameter_supported: true,
  }
  const register = async (request: Request) => {
    const client = Schema.decodeUnknownSync(Registration)(JSON.parse(await readBody(request)))
    if (
      client.redirect_uris.length < 1 ||
      client.redirect_uris.length > 10 ||
      (client.client_name?.length ?? 0) > 100
    )
      throw new Error('Invalid client metadata')
    const redirects = client.redirect_uris.map(safeRedirect)
    if (JSON.stringify(redirects).length > 2048) throw new Error('Client redirects too large')
    return json(201, {
      ...client,
      client_id: await seal(
        'client',
        { redirects, name: client.client_name ?? 'MCP client' },
        CLIENT_SECONDS,
      ),
      client_id_issued_at: now(),
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    })
  }

  const authorizeStart = async (request: Request) => {
    const url = new URL(request.url)
    const params = url.searchParams
    const clientId = text(params.get('client_id'))
    const client = await open('client', clientId)
    const redirect = text(params.get('redirect_uri'))
    if (
      !Array.isArray(client.redirects) ||
      !client.redirects.includes(redirect) ||
      params.get('response_type') !== 'code' ||
      params.get('code_challenge_method') !== 'S256' ||
      !/^[A-Za-z0-9_-]{43}$/.test(params.get('code_challenge') ?? '') ||
      params.get('resource') !== resource ||
      !['mcp', null].includes(params.get('scope')) ||
      (params.get('state')?.length ?? 0) > 1024
    )
      throw new Error('Invalid authorization request')
    const nonce = random()
    const flow = await seal(
      'flow',
      {
        clientId,
        redirect,
        state: params.get('state') ?? '',
        challenge: params.get('code_challenge'),
        nonce,
        discordVerifier: random(),
      },
      FLOW_SECONDS,
    )
    // Explicit client consent prevents the OAuth proxy becoming a confused deputy.
    return new Response(
      `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect to discord-mcp</title><style>${CONSENT_STYLES}</style><body><main><h1>Connect to discord-mcp</h1><p>Allow ${escapeHtml(text(client.name))} (${escapeHtml(new URL(redirect).origin)}) to use the relay with a bot token you supply?</p><form method="post" action="/authorize"><input type="hidden" name="flow" value="${escapeHtml(flow)}"><button name="decision" value="allow">Continue with Discord</button> <button name="decision" value="deny">Cancel</button></form></main></body></html>`,
      {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          // no-referrer also strips Origin from a browser's form POST, breaking the CSRF check.
          'referrer-policy': 'same-origin',
          'x-frame-options': 'DENY',
          'content-security-policy': `default-src 'none'; style-src 'sha256-${CONSENT_STYLE_HASH}'; form-action 'self' https://discord.com ${new URL(redirect).origin}; frame-ancestors 'none'; base-uri 'none'`,
          'set-cookie': cookie(nonce),
        },
      },
    )
  }

  const authorizeConsent = async (request: Request) => {
    if (request.headers.get('origin') !== issuer) {
      throw new Error('Invalid origin')
    }
    const params = new URLSearchParams(await readBody(request))
    const encoded = text(params.get('flow'))
    const flow = await open('flow', encoded)
    checkBrowser(request, flow)
    if (params.get('decision') !== 'allow') {
      const destination = new URL(text(flow.redirect))
      destination.searchParams.set('error', 'access_denied')
      destination.searchParams.set('state', String(flow.state))
      destination.searchParams.set('iss', issuer)
      return new Response(null, {
        status: 302,
        headers: {
          location: destination.href,
          'set-cookie': cookie('', 0),
          'cache-control': 'no-store',
        },
      })
    }
    const destination = new URL('https://discord.com/oauth2/authorize')
    destination.search = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: callback,
      response_type: 'code',
      scope: 'identify',
      state: encoded,
      prompt: 'consent',
      code_challenge: challenge(text(flow.discordVerifier)),
      code_challenge_method: 'S256',
    }).toString()
    return new Response(null, {
      status: 302,
      headers: {
        location: destination.href,
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
      },
    })
  }

  const discordCallback = async (request: Request) => {
    const url = new URL(request.url)
    const flow = await open('flow', text(url.searchParams.get('state')))
    checkBrowser(request, flow)
    if (url.searchParams.get('iss') !== 'https://discord.com') throw new Error('Wrong issuer')
    const destination = new URL(text(flow.redirect))
    if (url.searchParams.has('error')) {
      destination.searchParams.set('error', 'access_denied')
    } else {
      try {
        const tokens = await exchange({
          grant_type: 'authorization_code',
          code: text(url.searchParams.get('code')),
          redirect_uri: callback,
          code_verifier: text(flow.discordVerifier),
        })
        const subject = await identity(tokens.access_token)
        destination.searchParams.set(
          'code',
          await seal(
            'code',
            {
              clientId: flow.clientId,
              redirect: flow.redirect,
              challenge: flow.challenge,
              sub: subject,
              tokens,
            },
            CODE_SECONDS,
          ),
        )
      } catch (error) {
        if (!(error instanceof DiscordAccessDenied)) throw error
        destination.searchParams.set('error', 'access_denied')
        destination.searchParams.set('error_description', error.message)
      }
    }
    destination.searchParams.set('state', String(flow.state))
    destination.searchParams.set('iss', issuer)
    return new Response(null, {
      status: 302,
      headers: {
        location: destination.href,
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        'set-cookie': cookie('', 0),
      },
    })
  }

  const token = async (request: Request) => {
    const params = new URLSearchParams(await readBody(request))
    const clientId = text(params.get('client_id'))
    if (params.get('resource') !== resource) throw new Error('Wrong resource')
    if (params.get('grant_type') === 'authorization_code') {
      await open('client', clientId)
      const code = await open('code', text(params.get('code')))
      const verifier = text(params.get('code_verifier'))
      if (
        code.clientId !== clientId ||
        code.redirect !== params.get('redirect_uri') ||
        !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) ||
        code.challenge !== challenge(verifier)
      )
        throw new Error('Wrong code binding')
      consumeCode(code)
      return issue(Schema.decodeUnknownSync(TokenResponse)(code.tokens), clientId, text(code.sub))
    }
    if (params.get('grant_type') === 'refresh_token') {
      // The sealed client ID was a live registration at sign-in, so a chain outlives its expiry.
      // Bindings are checked before Discord rotates, so a misdirected request spends nothing.
      const grant = await open('refresh', text(params.get('refresh_token')))
      if (grant.clientId !== clientId || !['mcp', null].includes(params.get('scope')))
        throw new Error('Wrong refresh binding')
      const tokens = await exchange(
        { grant_type: 'refresh_token', refresh_token: text(grant.discordRefresh) },
        text(grant.sub),
      )
      // Discord has revoked the old refresh token, so nothing may fail between here and the reply.
      // Discord issued these to the sealed subject; every MCP request rechecks it and the allowlist.
      return issue(tokens, clientId, text(grant.sub))
    }

    return json(400, { error: 'unsupported_grant_type' })
  }

  const preflight = async () =>
    new Response(null, {
      status: 204,
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'POST, OPTIONS',
        'access-control-allow-headers': 'content-type',
        'cache-control': 'no-store',
      },
    })
  const routes: Record<string, (request: Request) => Promise<Response>> = {
    'POST /register': register,
    'GET /authorize': authorizeStart,
    'POST /authorize': authorizeConsent,
    'GET /auth/discord/callback': discordCallback,
    'POST /token': token,
    'OPTIONS /register': preflight,
    'OPTIONS /token': preflight,
  }

  return {
    /** Checks the relay credential and rechecks the enclosed Discord grant on every MCP request. */
    authorize: async (request: Request) => {
      try {
        return await verifyBearerToken(request.headers.get('authorization'), bearerOptions)
      } catch (error) {
        if (error instanceof DiscordAccessDenied) {
          return json(403, { error: 'access_denied', error_description: error.message })
        }
        if (error instanceof DiscordUnavailable)
          return json(
            error.status,
            { error: 'discord_login_unavailable' },
            error.status === 429 ? { 'retry-after': error.retryAfter } : {},
          )
        return error instanceof OAuthError
          ? bearerAuthChallengeResponse(error, bearerOptions)
          : json(502, { error: 'discord_login_unavailable' })
      }
    },
    /** Handle OAuth routes before the MCP origin gate; token requests do not rely on cookies. */
    fetch: async (request: Request): Promise<Response | undefined> => {
      const url = new URL(request.url)
      const discovery = oauthMetadataResponse(request, {
        oauthMetadata: metadata,
        resourceServerUrl: new URL(resource),
        scopesSupported: ['mcp'],
      })
      if (discovery !== undefined) {
        discovery.headers.set('cache-control', 'no-store')
        return discovery
      }
      if (!['/register', '/authorize', '/auth/discord/callback', '/token'].includes(url.pathname))
        return undefined
      const route = routes[`${request.method} ${url.pathname}`]
      if (route === undefined) return json(405, { error: 'invalid_request' })
      try {
        return await route(request)
      } catch (error) {
        if (error instanceof DiscordUnavailable)
          return json(
            error.status,
            { error: 'temporarily_unavailable' },
            error.status === 429 ? { 'retry-after': error.retryAfter } : {},
          )
        // OAuth error bodies must never include Discord responses, codes, or credentials.
        return json(400, {
          error: url.pathname === '/token' ? 'invalid_grant' : 'invalid_request',
          error_description: 'Authorization failed. Start Discord login again.',
        })
      }
    },
  }
}
