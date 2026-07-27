import { createHmac } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { AuthenticationError, PersonalAccessTokens } from '@discord-mcp/auth'
import { DiscordRestClient } from '@discord-mcp/discord-api'
import { Database } from '@discord-mcp/persistence'
import { WorkflowRouteRegistry } from '@discord-mcp/workflow-runtime'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { describe, expect, it } from 'vitest'
import { ensureAuthenticatedPrincipal, startHttpServer } from './http.js'
import { AuditLog } from './observability.js'

const httpConfig = {
  host: '127.0.0.1',
  port: 0,
  allowedHosts: [],
  trustedProxyCidrs: [],
  trustProxyIdentity: false,
} as const

const serverOrigin = (server: Awaited<ReturnType<typeof startHttpServer>>): string => {
  const address = server.address() as AddressInfo
  return `http://127.0.0.1:${address.port}`
}

const closeServer = async (server: Awaited<ReturnType<typeof startHttpServer>>): Promise<void> =>
  new Promise((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  )

describe('HTTP authenticated principal persistence', () => {
  it('materializes an OIDC subject before audited requests', () => {
    const database = new Database(':memory:')
    database.migrate()
    ensureAuthenticatedPrincipal(database, {
      id: 'oidc:subject-123',
      name: 'OIDC operator',
      kind: 'oidc',
      scopes: new Set(['mcp:read']),
      expiresAt: Date.now() + 60_000,
    })
    expect(
      database.get('SELECT id, name, kind FROM principals WHERE id = ?', 'oidc:subject-123'),
    ).toEqual({
      id: 'oidc:subject-123',
      name: 'OIDC operator',
      kind: 'oidc',
    })
    database.close()
  })

  it('rejects a disabled OIDC subject and unprovisioned non-OIDC identities', () => {
    const database = new Database(':memory:')
    database.migrate()
    database.run(
      `INSERT INTO principals(id, name, kind, disabled_at, created_at)
       VALUES ('oidc:disabled', 'Disabled', 'oidc', ?, ?)`,
      new Date().toISOString(),
      new Date().toISOString(),
    )
    expect(() =>
      ensureAuthenticatedPrincipal(database, {
        id: 'oidc:disabled',
        name: 'Disabled',
        kind: 'oidc',
        scopes: new Set(['mcp:read']),
      }),
    ).toThrow(AuthenticationError)
    expect(() =>
      ensureAuthenticatedPrincipal(database, {
        id: 'missing-proxy',
        name: 'Missing proxy',
        kind: 'proxy',
        scopes: new Set(['mcp:read']),
      }),
    ).toThrow(/not provisioned/)
    database.close()
  })

  it('signs and delivers the exact workflow body across the real HTTP boundary', async () => {
    const database = new Database(':memory:')
    database.migrate()
    const createdAt = new Date().toISOString()
    database.run(
      'INSERT INTO principals(id, name, kind, created_at) VALUES (?, ?, ?, ?)',
      'owner',
      'Owner',
      'local',
      createdAt,
    )
    database.run(
      `INSERT INTO workflows
       (id, owner_principal_id, slug, name, enabled_revision, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      'workflow-one',
      'owner',
      'deploy-hook',
      'Deploy hook',
      1,
      createdAt,
      createdAt,
    )
    const timestamp = '1800000000'
    const delivered: Array<Buffer> = []
    const routes = new WorkflowRouteRegistry(
      database,
      { resolve: async () => 'route-secret' },
      {
        invoke: async ({ rawBody }) => {
          delivered.push(Buffer.from(rawBody))
          return { status: 202, body: 'accepted' }
        },
      },
      () => Number(timestamp) * 1_000,
    )
    routes.register({
      workflowId: 'workflow-one',
      revision: 1,
      method: 'POST',
      path: '/signed',
      publicRouteGranted: false,
      policy: {
        authentication: { type: 'hmacSha256', secretRef: 'hook-key' },
        allowedHosts: ['127.0.0.1'],
        allowedOrigins: [],
        allowedSourceCidrs: ['127.0.0.0/8'],
        maxBodyBytes: 100,
      },
    })
    const server = await startHttpServer({
      config: httpConfig,
      rest: new DiscordRestClient({ request: async () => ({}) }),
      authentication: { pats: new PersonalAccessTokens(database) },
      workflowRoutes: routes,
    })
    const body = '{"ref":"main","force":false}'
    const signature = createHmac('sha256', 'route-secret')
      .update(timestamp)
      .update('.')
      .update(body)
      .digest('hex')
    try {
      const response = await fetch(`${serverOrigin(server)}/workflows/deploy-hook/signed`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-discord-mcp-timestamp': timestamp,
          'x-discord-mcp-signature': signature,
        },
        body,
      })
      expect(response.status).toBe(202)
      expect(await response.text()).toBe('accepted')
      expect(delivered.map((bytes) => bytes.toString('utf8'))).toEqual([body])

      const tampered = await fetch(`${serverOrigin(server)}/workflows/deploy-hook/signed`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-discord-mcp-timestamp': timestamp,
          'x-discord-mcp-signature': signature,
        },
        body: '{"ref":"tampered"}',
      })
      expect(tampered.status).toBe(403)
      expect(delivered).toHaveLength(1)
    } finally {
      await closeServer(server)
      database.close()
    }
  })

  it('keeps concurrent HTTP MCP principals isolated through asynchronous handlers', async () => {
    const database = new Database(':memory:')
    database.migrate()
    const createdAt = new Date().toISOString()
    for (const [id, name] of [
      ['alice', 'Alice'],
      ['bob', 'Bob'],
    ] as const) {
      database.run(
        'INSERT INTO principals(id, name, kind, created_at) VALUES (?, ?, ?, ?)',
        id,
        name,
        'local',
        createdAt,
      )
      database.run(
        'INSERT INTO principal_scope_bindings(principal_id, scope) VALUES (?, ?)',
        id,
        'mcp:read',
      )
    }
    const pats = new PersonalAccessTokens(database)
    const aliceToken = (await pats.create({ principalId: 'alice', name: 'Alice test' })).token
    const bobToken = (await pats.create({ principalId: 'bob', name: 'Bob test' })).token
    let calls = 0
    let releaseFirst: (() => void) | undefined
    const firstStarted = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let unblockFirst: (() => void) | undefined
    const firstMayFinish = new Promise<void>((resolve) => {
      unblockFirst = resolve
    })
    const server = await startHttpServer({
      config: httpConfig,
      rest: new DiscordRestClient({
        request: async () => {
          calls += 1
          if (calls === 1) {
            releaseFirst?.()
            await firstMayFinish
          }
          return { id: '12345678901234567', name: `Guild ${calls}` }
        },
      }),
      authentication: { pats },
      database,
      audit: new AuditLog(database),
    })
    const origin = serverOrigin(server)
    const alice = new Client({ name: 'alice-client', version: '1.0.0' })
    const bob = new Client({ name: 'bob-client', version: '1.0.0' })
    await alice.connect(
      new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${aliceToken}` } },
      }),
    )
    await bob.connect(
      new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${bobToken}` } },
      }),
    )
    try {
      const aliceCall = alice.callTool({
        name: 'discord_guild_get',
        arguments: { guildId: '12345678901234567' },
      })
      await firstStarted
      const bobResult = await bob.callTool({
        name: 'discord_guild_get',
        arguments: { guildId: '12345678901234567' },
      })
      expect(bobResult.isError).not.toBe(true)
      unblockFirst?.()
      expect((await aliceCall).isError).not.toBe(true)
      expect(
        database
          .all<{ principal_id: string }>(
            `SELECT principal_id FROM audit_log
             WHERE action = 'discord_guild_get' ORDER BY rowid`,
          )
          .map(({ principal_id }) => principal_id),
      ).toEqual(['bob', 'alice'])
    } finally {
      unblockFirst?.()
      await Promise.allSettled([alice.close(), bob.close()])
      await closeServer(server)
      database.close()
    }
  }, 30_000)
})
