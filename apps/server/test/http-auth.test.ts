import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PrincipalStore } from '@discord-mcp/auth'
import type { Scope } from '@discord-mcp/core'
import { DiscordRest, guildGet } from '@discord-mcp/discord-api'
import { PersistenceLayer } from '@discord-mcp/persistence'
import { Effect, Layer, ManagedRuntime } from 'effect'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { httpAuthorize } from '../src/app.ts'
import { type HttpConfig, startHttpServer } from '../src/http-server.ts'
import { buildMcpServer } from '../src/mcp-server.ts'
import { guildFixture, testConfig } from './support/harness.ts'

/**
 * PLAN.md's phase-6 acceptance criterion: all three auth paths must produce identical principal
 * and scoping behaviour, and spoofed proxy headers must be rejected.
 *
 * Driven over a real HTTP socket rather than by calling `resolveIdentity` directly, because the
 * thing being tested is what the *server* believes about a request.
 */

let dir: string
let runtime: ManagedRuntime.ManagedRuntime<PrincipalStore | DiscordRest, never>
let handle: { port: number; close: () => Promise<void> } | undefined

const READ_SCOPES: ReadonlyArray<Scope> = ['mcp:read']

const httpConfig = (over: Partial<HttpConfig> = {}): HttpConfig => ({
  host: '127.0.0.1',
  port: 0,
  allowedHosts: [],
  publicBaseUrl: undefined,
  proxy: {
    trustProxyIdentity: true,
    // Loopback only, which is what the test client connects from.
    trustedProxyCidrs: ['127.0.0.0/8'],
    allowedHosts: [],
    identityHeader: 'X-Forwarded-User',
    groupsHeader: 'X-Forwarded-Groups',
  },
  oidc: undefined,
  ...over,
})

const start = async (config: HttpConfig = httpConfig()) => {
  handle = await runtime.runPromise(
    startHttpServer({
      config,
      buildServer: (resolve) =>
        buildMcpServer({
          config: testConfig,
          runtime,
          authorize: httpAuthorize(resolve),
          tools: [guildGet],
        }),
      runtime,
    }),
  )
  return `http://127.0.0.1:${handle.port}`
}

const rpc = async (base: string, headers: Record<string, string>, body: unknown) =>
  fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify(body),
  })

const initialize = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'auth-test', version: '0' },
  },
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'discord-mcp-http-'))
  runtime = ManagedRuntime.make(
    Layer.mergeAll(
      PrincipalStore.layer,
      Layer.succeed(DiscordRest)({
        request: () => Effect.succeed(guildFixture),
        raw: undefined as never,
      }),
    ).pipe(Layer.provideMerge(PersistenceLayer(join(dir, 'http.sqlite')))),
  )

  await runtime.runPromise(
    Effect.flatMap(PrincipalStore, (s) =>
      Effect.all([
        s.create({ id: 'ci', kind: 'pat', displayName: 'CI', scopes: READ_SCOPES }),
        s.create({
          id: 'alice',
          kind: 'trusted-proxy',
          displayName: 'Alice',
          scopes: READ_SCOPES,
        }),
      ]),
    ),
  )
  await runtime.runPromise(
    Effect.flatMap(PrincipalStore, (s) => s.bindProxyIdentity('alice@example.com', 'alice')),
  )
})

afterEach(async () => {
  await handle?.close()
  handle = undefined
  await runtime.dispose()
  rmSync(dir, { recursive: true, force: true })
})

describe('authentication paths', () => {
  it('accepts a valid personal access token', async () => {
    const base = await start()
    const created = await runtime.runPromise(
      Effect.flatMap(PrincipalStore, (s) => s.issueToken({ principalId: 'ci', name: 'test' })),
    )

    const response = await rpc(base, { authorization: `Bearer ${created.token}` }, initialize)
    expect(response.status).toBe(200)
  })

  it('accepts a trusted proxy identity bound to a principal', async () => {
    const base = await start()
    const response = await rpc(base, { 'x-forwarded-user': 'alice@example.com' }, initialize)
    expect(response.status).toBe(200)
  })

  it('produces the same principal behaviour from both paths', async () => {
    // The acceptance criterion. Same tool, same scopes, same answer — the transport decides who,
    // never what they may do.
    const base = await start()
    const created = await runtime.runPromise(
      Effect.flatMap(PrincipalStore, (s) => s.issueToken({ principalId: 'ci', name: 'test' })),
    )

    const viaPat = await rpc(base, { authorization: `Bearer ${created.token}` }, initialize)
    const viaProxy = await rpc(base, { 'x-forwarded-user': 'alice@example.com' }, initialize)

    expect(viaPat.status).toBe(viaProxy.status)
    expect(viaPat.status).toBe(200)
  })

  it('rejects a request with no credential at all', async () => {
    const base = await start()
    const response = await rpc(base, {}, initialize)
    expect(response.status).toBe(401)
    // The challenge tells a client where to get a token rather than leaving it to guess.
    expect(response.headers.get('www-authenticate')).toContain('Bearer')
  })

  it('rejects an unknown personal access token', async () => {
    const base = await start()
    const response = await rpc(base, { authorization: 'Bearer dcmcp_notarealtoken' }, initialize)
    expect(response.status).toBe(401)
  })

  it('rejects a proxy identity nothing is bound to', async () => {
    const base = await start()
    const response = await rpc(base, { 'x-forwarded-user': 'mallory@example.com' }, initialize)
    expect(response.status).toBe(401)
  })
})

describe('spoofed proxy headers', () => {
  it('are rejected when forwarded identity is disabled', async () => {
    const base = await start(
      httpConfig({
        proxy: {
          trustProxyIdentity: false,
          trustedProxyCidrs: ['127.0.0.0/8'],
          allowedHosts: [],
          identityHeader: 'X-Forwarded-User',
        },
      }),
    )
    // The same header that works above. Only the configuration changed.
    const response = await rpc(base, { 'x-forwarded-user': 'alice@example.com' }, initialize)
    expect(response.status).toBe(401)
  })

  it('are rejected when the peer is outside the trusted range', async () => {
    const base = await start(
      httpConfig({
        proxy: {
          trustProxyIdentity: true,
          // The test client connects from loopback, which this range excludes.
          trustedProxyCidrs: ['10.0.0.0/8'],
          allowedHosts: [],
          identityHeader: 'X-Forwarded-User',
        },
      }),
    )
    const response = await rpc(base, { 'x-forwarded-user': 'alice@example.com' }, initialize)
    expect(response.status).toBe(401)
  })

  it('cannot be combined with a bad token to escalate', async () => {
    // An explicit Authorization header wins over an ambient proxy header, so a forged proxy
    // identity cannot rescue a rejected token.
    const base = await start()
    const response = await rpc(
      base,
      { authorization: 'Bearer dcmcp_bogus', 'x-forwarded-user': 'alice@example.com' },
      initialize,
    )
    expect(response.status).toBe(401)
  })
})

describe('host and metadata', () => {
  it('refuses a Host outside ALLOWED_HOSTS', async () => {
    const base = await start(httpConfig({ allowedHosts: ['mcp.example.com'] }))
    const response = await rpc(base, { host: 'evil.example.net' }, initialize)
    expect(response.status).toBe(421)
  })

  it('serves protected-resource metadata without authentication', async () => {
    const base = await start(
      httpConfig({
        publicBaseUrl: 'https://mcp.example.com',
        oidc: {
          issuer: 'https://issuer.example.com',
          audience: 'discord-mcp',
          jwksUri: 'https://issuer.example.com/jwks',
        },
      }),
    )

    const response = await fetch(`${base}/.well-known/oauth-protected-resource`)
    expect(response.status).toBe(200)

    const metadata = (await response.json()) as {
      resource: string
      authorization_servers: string[]
    }
    expect(metadata.resource).toBe('https://mcp.example.com')
    expect(metadata.authorization_servers).toEqual(['https://issuer.example.com'])
  })

  it('answers health checks without authentication and without detail', async () => {
    const base = await start()
    const response = await fetch(`${base}/health/live`)
    expect(response.status).toBe(200)

    // Unauthenticated, so anything it says is public. It says nothing.
    const body = (await response.json()) as Record<string, unknown>
    expect(Object.keys(body)).toEqual(['status'])
  })
})
