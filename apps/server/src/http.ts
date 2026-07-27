import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Principal } from '@discord-mcp/auth'
import {
  AuthenticationError,
  type DiscordOAuthProfiles,
  isAddressInCidrs,
  type OidcVerifier,
  type PersonalAccessTokens,
  requireScopes,
  resolveForwardedClientAddress,
  scopes,
  type TokenEncryption,
  type TrustedProxyAuthentication,
} from '@discord-mcp/auth'
import type { DiscordRestClient } from '@discord-mcp/discord-api'
import type { GatewayEventStore, GatewayLifecycle } from '@discord-mcp/discord-gateway'
import type { BlobStore, Database } from '@discord-mcp/persistence'
import type { WorkflowRuntimeManager, WorkflowStore } from '@discord-mcp/workflow-runtime'
import { RoutePolicyError, type WorkflowRouteRegistry } from '@discord-mcp/workflow-runtime'
import { toNodeHandler } from '@modelcontextprotocol/node'
import { type AuthInfo, createMcpHandler } from '@modelcontextprotocol/server'
import type { HttpConfig } from './config.js'
import { validateHttpConfig } from './config.js'
import type { InteractionHandler } from './interactions/handler.js'
import { type AuditLog, type MetricsRegistry, writeStructuredLog } from './observability.js'
import { buildToolServer } from './tool-surface.js'

export interface HttpAuthentication {
  readonly pats: PersonalAccessTokens
  readonly oidc?: OidcVerifier
  readonly proxy?: TrustedProxyAuthentication
}

export interface HttpServerServices {
  readonly config: HttpConfig
  readonly rest: DiscordRestClient
  readonly authentication: HttpAuthentication
  readonly gatewayEvents?: GatewayEventStore
  readonly gateway?: GatewayLifecycle
  readonly interactions?: InteractionHandler
  readonly workflowRoutes?: WorkflowRouteRegistry
  readonly database?: Database
  readonly blobs?: BlobStore
  readonly workflows?: WorkflowStore
  readonly oauthProfiles?: DiscordOAuthProfiles
  readonly blueprintPreviewKey?: Buffer
  readonly secretEncryption?: TokenEncryption
  readonly audit?: AuditLog
  readonly metrics?: MetricsRegistry
  readonly toolsets?: ReadonlySet<'operator' | 'automation' | 'admin' | 'api'>
  readonly workflowRuntime?: WorkflowRuntimeManager
  readonly maximumResponseBytes?: number
}

const readBody = async (request: IncomingMessage, maximum: number): Promise<Buffer> => {
  const chunks: Array<Buffer> = []
  let size = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > maximum) throw new Error('request body too large')
    chunks.push(bytes)
  }
  return Buffer.concat(chunks)
}

const json = (response: ServerResponse, status: number, value: unknown): void => {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(value))
}

const authInfo = (principal: Principal): AuthInfo => ({
  token: '[redacted]',
  clientId: principal.id,
  scopes: [...principal.scopes],
  expiresAt: Math.floor((principal.expiresAt ?? Date.now() + 5 * 60_000) / 1_000),
  extra: { name: principal.name, kind: principal.kind },
})

const principalFromInfo = (info: AuthInfo | undefined): Principal | undefined => {
  if (!info) return undefined
  const kind = info.extra?.kind
  return {
    id: info.clientId,
    name: typeof info.extra?.name === 'string' ? info.extra.name : info.clientId,
    kind:
      kind === 'pat' || kind === 'oidc' || kind === 'proxy' || kind === 'workflow' ? kind : 'pat',
    scopes: new Set(
      info.scopes as Array<Principal['scopes'] extends ReadonlySet<infer S> ? S : never>,
    ),
    ...(info.expiresAt === undefined ? {} : { expiresAt: info.expiresAt * 1_000 }),
  }
}

const authenticate = async (
  request: IncomingMessage,
  authentication: HttpAuthentication,
  allowedHosts: ReadonlyArray<string>,
): Promise<Principal> => {
  const header = request.headers.authorization
  if (header !== undefined) {
    if (!header.startsWith('Bearer ') || header.length <= 7) {
      throw new AuthenticationError('missing or invalid bearer credential')
    }
    const token = header.slice(7)
    if (token.startsWith('dcmcp_')) return authentication.pats.authenticate(token)
    if (authentication.oidc) return authentication.oidc.verify(token)
    throw new AuthenticationError('missing or invalid bearer credential')
  }
  if (authentication.proxy) {
    const forwardedProto = request.headers['x-forwarded-proto']
    const forwardedHost = request.headers['x-forwarded-host']
    const protocol = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto
    const host = parseHost(Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost)
    if (protocol !== 'https' || !host || !allowedHosts.includes(host)) {
      throw new AuthenticationError('trusted proxy request has unsafe forwarded protocol or host')
    }
    return authentication.proxy.authenticate({
      peerAddress: request.socket.remoteAddress ?? '',
      headers: normalizedHeaders(request.headers),
    })
  }
  throw new AuthenticationError('missing or invalid bearer credential')
}

const parseHost = (value: string | undefined): string | undefined => {
  if (!value || /[/@,\s]/.test(value)) return undefined
  try {
    return new URL(`http://${value}`).hostname
  } catch {
    return undefined
  }
}

const normalizedHeaders = (
  headers: IncomingMessage['headers'],
): Readonly<Record<string, string | undefined>> =>
  Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name.toLowerCase(),
      Array.isArray(value) ? value[0] : value,
    ]),
  )

export const ensureAuthenticatedPrincipal = (database: Database, principal: Principal): void => {
  const existing = database.get<{
    kind: Principal['kind']
    disabled_at: string | null
  }>('SELECT kind, disabled_at FROM principals WHERE id = ?', principal.id)
  if (existing !== undefined && existing.disabled_at !== null) {
    throw new AuthenticationError('principal disabled')
  }
  if (existing !== undefined) return
  if (principal.kind !== 'oidc') {
    throw new AuthenticationError('authenticated principal is not provisioned')
  }
  database.run(
    `INSERT INTO principals(id, name, kind, created_at)
     VALUES (?, ?, 'oidc', ?)`,
    principal.id,
    principal.name,
    new Date().toISOString(),
  )
}

export const startHttpServer = async (services: HttpServerServices) => {
  const config = validateHttpConfig(services.config)
  const allowedHosts =
    config.allowedHosts.length > 0 ? config.allowedHosts : ['localhost', '127.0.0.1', '[::1]']
  const mcp = createMcpHandler((context) => {
    const principal = principalFromInfo(context.authInfo)
    return buildToolServer({
      rest: services.rest,
      ...(services.gatewayEvents === undefined ? {} : { gatewayEvents: services.gatewayEvents }),
      ...(services.gateway === undefined ? {} : { gateway: services.gateway }),
      ...(services.database === undefined ? {} : { database: services.database }),
      ...(services.blobs === undefined ? {} : { blobs: services.blobs }),
      ...(services.workflows === undefined ? {} : { workflows: services.workflows }),
      ...(services.oauthProfiles === undefined ? {} : { oauthProfiles: services.oauthProfiles }),
      ...(services.blueprintPreviewKey === undefined
        ? {}
        : { blueprintPreviewKey: services.blueprintPreviewKey }),
      ...(services.secretEncryption === undefined
        ? {}
        : { secretEncryption: services.secretEncryption }),
      ...(services.audit === undefined ? {} : { audit: services.audit }),
      ...(services.metrics === undefined ? {} : { metrics: services.metrics }),
      ...(services.toolsets === undefined ? {} : { toolsets: services.toolsets }),
      ...(services.workflowRuntime === undefined
        ? {}
        : { workflowRuntime: services.workflowRuntime }),
      ...(services.maximumResponseBytes === undefined
        ? {}
        : { maximumResponseBytes: services.maximumResponseBytes }),
      ...(principal === undefined ? {} : { principal }),
    })
  })
  const nodeMcp = toNodeHandler(mcp, {
    onerror: (error) =>
      writeStructuredLog({
        level: 'error',
        event: 'mcp.http.transport.error',
        outcome: 'failure',
        detail: { error: error.message, errorType: error.name },
      }),
  })
  const authenticateRequest = async (request: IncomingMessage): Promise<Principal> => {
    const requestId = randomUUID()
    try {
      const principal = await authenticate(request, services.authentication, allowedHosts)
      if (services.database) ensureAuthenticatedPrincipal(services.database, principal)
      services.audit?.record({
        principalId: principal.id,
        action: 'authentication',
        targetType: 'principal',
        targetId: principal.id,
        requestId,
        detail: { kind: principal.kind },
        outcome: 'success',
      })
      return principal
    } catch (cause) {
      services.audit?.record({
        action: 'authentication',
        targetType: 'http_request',
        requestId,
        detail: { reason: cause instanceof Error ? cause.message : String(cause) },
        outcome: 'failure',
      })
      throw cause
    }
  }
  const server = createServer(async (request, response) => {
    const rawUrl = request.url ?? '/'
    if (!rawUrl.startsWith('/')) {
      json(response, 400, { error: 'request target must use origin form' })
      return
    }
    let url: URL
    try {
      url = new URL(rawUrl, 'http://localhost')
    } catch {
      json(response, 400, { error: 'invalid request target' })
      return
    }
    const host = parseHost(request.headers.host)
    if (!host) {
      json(response, 400, { error: 'valid host header required' })
      return
    }
    if (!allowedHosts.includes(host)) {
      json(response, 403, { error: 'host not allowed' })
      return
    }
    if (url.pathname === '/health/live' || url.pathname === '/health/ready') {
      json(response, 200, { ok: true })
      return
    }
    const peerAddress = request.socket.remoteAddress ?? ''
    const forwardedFor = Array.isArray(request.headers['x-forwarded-for'])
      ? request.headers['x-forwarded-for'][0]
      : request.headers['x-forwarded-for']
    const forwardedProto = Array.isArray(request.headers['x-forwarded-proto'])
      ? request.headers['x-forwarded-proto'][0]
      : request.headers['x-forwarded-proto']
    const forwardedHostValue = Array.isArray(request.headers['x-forwarded-host'])
      ? request.headers['x-forwarded-host'][0]
      : request.headers['x-forwarded-host']
    const hasForwardingHeaders =
      forwardedFor !== undefined ||
      forwardedProto !== undefined ||
      request.headers['x-forwarded-host'] !== undefined ||
      request.headers[services.authentication.proxy?.identityHeader ?? 'x-forwarded-user'] !==
        undefined ||
      request.headers[services.authentication.proxy?.groupsHeader ?? 'x-forwarded-groups'] !==
        undefined
    let sourceAddress = peerAddress
    try {
      if (hasForwardingHeaders && !isAddressInCidrs(peerAddress, config.trustedProxyCidrs)) {
        json(response, 400, { error: 'forwarded headers came from an untrusted peer' })
        return
      }
      if (hasForwardingHeaders && forwardedProto !== 'https') {
        json(response, 400, { error: 'trusted proxy must forward HTTPS requests' })
        return
      }
      if (
        hasForwardingHeaders &&
        (!parseHost(forwardedHostValue) ||
          !allowedHosts.includes(parseHost(forwardedHostValue) as string))
      ) {
        json(response, 400, { error: 'trusted proxy forwarded an invalid or disallowed host' })
        return
      }
      sourceAddress = resolveForwardedClientAddress(
        peerAddress,
        forwardedFor,
        config.trustedProxyCidrs,
      )
    } catch (cause) {
      json(response, 400, { error: cause instanceof Error ? cause.message : String(cause) })
      return
    }
    if (url.pathname === '/metrics' && request.method === 'GET') {
      if (!services.metrics) {
        json(response, 404, { error: 'metrics unavailable' })
        return
      }
      try {
        requireScopes(await authenticateRequest(request), ['audit:read'])
        response.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' })
        response.end(services.metrics.render())
      } catch {
        json(response, 401, { error: 'invalid_token' })
      }
      return
    }
    if (url.pathname === '/discord/interactions' && request.method === 'POST') {
      if (!services.interactions) {
        json(response, 503, { error: 'interactions unavailable' })
        return
      }
      try {
        const result = await services.interactions.handle({
          rawBody: await readBody(request, 1_048_576),
          signature: request.headers['x-signature-ed25519'] as string | undefined,
          timestamp: request.headers['x-signature-timestamp'] as string | undefined,
        })
        response.writeHead(result.status, result.headers)
        response.end(result.body)
      } catch (cause) {
        json(response, 400, { error: cause instanceof Error ? cause.message : String(cause) })
      }
      return
    }
    if (url.pathname === '/oauth/discord/callback' && request.method === 'GET') {
      if (!services.oauthProfiles) {
        json(response, 503, { error: 'Discord OAuth is unavailable' })
        return
      }
      const state = url.searchParams.get('state')
      const code = url.searchParams.get('code')
      if (!state || !code) {
        json(response, 400, { error: 'state and code are required' })
        return
      }
      try {
        const profile = await services.oauthProfiles.callback({ state, code })
        services.audit?.record({
          principalId: profile.ownerPrincipalId,
          action: 'oauth_profile.callback',
          targetType: 'oauth_profile',
          targetId: profile.id,
          outcome: 'success',
        })
        json(response, 200, { ok: true, profile })
      } catch (cause) {
        services.audit?.record({
          action: 'oauth_profile.callback',
          targetType: 'oauth_profile',
          detail: { reason: cause instanceof Error ? cause.message : String(cause) },
          outcome: 'failure',
        })
        json(response, 400, { error: cause instanceof Error ? cause.message : String(cause) })
      }
      return
    }
    const discordAuthorizeMatch = /^\/oauth\/discord\/authorize\/([^/]+)$/.exec(url.pathname)
    if (discordAuthorizeMatch && request.method === 'GET') {
      if (!services.oauthProfiles) {
        json(response, 503, { error: 'Discord OAuth is unavailable' })
        return
      }
      try {
        const principal = await authenticateRequest(request)
        requireScopes(principal, ['oauth:manage'])
        const location = services.oauthProfiles.authorizationUrl(
          decodeURIComponent(discordAuthorizeMatch[1] as string),
          principal.id,
        )
        response.writeHead(302, {
          location,
          'cache-control': 'no-store',
          'referrer-policy': 'no-referrer',
        })
        response.end()
      } catch (cause) {
        json(response, 401, { error: cause instanceof Error ? cause.message : String(cause) })
      }
      return
    }
    if (
      url.pathname === '/.well-known/oauth-protected-resource' ||
      url.pathname === '/.well-known/oauth-protected-resource/mcp'
    ) {
      json(response, 200, {
        resource: `${config.publicBaseUrl ?? `http://${config.host}:${config.port}`}/mcp`,
        ...(services.authentication.oidc === undefined
          ? {}
          : { authorization_servers: [services.authentication.oidc.issuer] }),
        bearer_methods_supported: ['header'],
        scopes_supported: scopes,
      })
      return
    }
    if (url.pathname === '/blobs' && request.method === 'POST') {
      if (!services.blobs) {
        json(response, 503, { error: 'blob storage unavailable' })
        return
      }
      try {
        const principal = await authenticateRequest(request)
        requireScopes(principal, ['blob:write'])
        const maximum = Number(process.env.DISCORD_MCP_MAX_BLOB_BYTES ?? 25 * 1024 * 1024)
        const declaredLength = Number(request.headers['content-length'] ?? 0)
        if (Number.isFinite(declaredLength) && declaredLength > maximum) {
          json(response, 413, { error: 'blob exceeds configured size limit' })
          return
        }
        const filename = request.headers['x-discord-mcp-filename']
        if (typeof filename !== 'string' || filename.length === 0) {
          json(response, 400, { error: 'x-discord-mcp-filename is required' })
          return
        }
        const mimeType = String(request.headers['content-type'] ?? 'application/octet-stream')
          .split(';', 1)[0]
          ?.trim()
        const metadata = await services.blobs.putBytes({
          ownerPrincipalId: principal.id,
          filename,
          mimeType: mimeType || 'application/octet-stream',
          bytes: await readBody(request, maximum),
        })
        services.audit?.record({
          principalId: principal.id,
          action: 'blob.create',
          targetType: 'blob',
          targetId: metadata.id,
          outcome: 'success',
        })
        json(response, 201, metadata)
      } catch (cause) {
        json(response, 400, { error: cause instanceof Error ? cause.message : String(cause) })
      }
      return
    }
    const blobMatch = /^\/blobs\/([a-f0-9]{64})\/metadata$/.exec(url.pathname)
    const blobDeleteMatch = /^\/blobs\/([a-f0-9]{64})$/.exec(url.pathname)
    if (
      (blobMatch && request.method === 'GET') ||
      (blobDeleteMatch && request.method === 'DELETE')
    ) {
      if (!services.blobs) {
        json(response, 503, { error: 'blob storage unavailable' })
        return
      }
      try {
        const principal = await authenticateRequest(request)
        const id = (blobMatch?.[1] ?? blobDeleteMatch?.[1]) as string
        const administrator = principal.scopes.has('auth:admin')
        if (blobMatch) {
          requireScopes(principal, ['mcp:read'])
          json(response, 200, services.blobs.getMetadata(id, principal.id, administrator))
        } else {
          requireScopes(principal, ['blob:write'])
          await services.blobs.delete(id, principal.id, administrator)
          services.audit?.record({
            principalId: principal.id,
            action: 'blob.delete',
            targetType: 'blob',
            targetId: id,
            outcome: 'success',
          })
          response.writeHead(204)
          response.end()
        }
      } catch (cause) {
        json(response, 403, { error: cause instanceof Error ? cause.message : String(cause) })
      }
      return
    }
    if (url.pathname.startsWith('/workflows/')) {
      if (!services.workflowRoutes || !request.method) {
        json(response, 404, { error: 'workflow route not found' })
        return
      }
      try {
        if (request.method === 'OPTIONS') {
          const origin = request.headers.origin
          const requestedMethod = request.headers['access-control-request-method']
          if (typeof origin !== 'string' || typeof requestedMethod !== 'string') {
            throw new RoutePolicyError('invalid workflow route preflight')
          }
          const result = services.workflowRoutes.preflight({
            path: url.pathname,
            requestedMethod,
            host,
            origin,
            peerAddress: sourceAddress,
          })
          response.writeHead(result.status, result.headers)
          response.end()
          return
        }
        const maximum = services.workflowRoutes.getBodyLimit(request.method, url.pathname)
        const declaredLength = Number(request.headers['content-length'] ?? 0)
        if (Number.isFinite(declaredLength) && declaredLength > maximum) {
          json(response, 413, { error: 'workflow route body exceeds its limit' })
          return
        }
        const result = await services.workflowRoutes.handle({
          method: request.method,
          path: url.pathname,
          host,
          ...(typeof request.headers.origin === 'string' ? { origin: request.headers.origin } : {}),
          peerAddress: sourceAddress,
          headers: normalizedHeaders(request.headers),
          rawBody: await readBody(request, maximum),
        })
        response.writeHead(result.status, result.headers)
        response.end(result.body)
      } catch (cause) {
        const status =
          cause instanceof RoutePolicyError && /does not exist|not a workflow/.test(cause.message)
            ? 404
            : cause instanceof RoutePolicyError && /body exceeds/.test(cause.message)
              ? 413
              : 403
        json(response, status, { error: cause instanceof Error ? cause.message : String(cause) })
      }
      return
    }
    if (url.pathname !== '/mcp') {
      json(response, 404, { error: 'not found' })
      return
    }
    try {
      const principal = await authenticateRequest(request)
      ;(request as IncomingMessage & { auth?: AuthInfo }).auth = authInfo(principal)
      await nodeMcp(
        request as unknown as Parameters<typeof nodeMcp>[0],
        response as unknown as Parameters<typeof nodeMcp>[1],
      )
    } catch {
      response.writeHead(401, {
        'content-type': 'application/json',
        'www-authenticate': `Bearer realm="discord-mcp", resource_metadata="${
          config.publicBaseUrl ?? `http://${config.host}:${config.port}`
        }/.well-known/oauth-protected-resource/mcp"`,
      })
      response.end(JSON.stringify({ error: 'invalid_token' }))
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port, config.host, resolve)
  })
  return server
}
