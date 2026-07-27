import { createHmac } from 'node:crypto'
import { Database } from '@discord-mcp/persistence'
import { describe, expect, it } from 'vitest'
import { RoutePolicyError, WorkflowRouteRegistry } from './routes.js'

const setup = () => {
  const database = new Database(':memory:')
  database.migrate()
  database.run(
    'INSERT INTO principals(id, name, kind, created_at) VALUES (?, ?, ?, ?)',
    'owner',
    'Owner',
    'local',
    new Date().toISOString(),
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
    new Date().toISOString(),
    new Date().toISOString(),
  )
  let invocations = 0
  const registry = new WorkflowRouteRegistry(
    database,
    { resolve: async () => 'route-secret' },
    {
      invoke: async () => {
        invocations += 1
        return { status: 202, body: 'accepted', headers: { 'content-type': 'text/plain' } }
      },
    },
    () => 1_800_000_000_000,
  )
  return { database, registry, invocations: () => invocations }
}

describe('dynamic workflow routes', () => {
  it('enforces namespace, host, origin, CIDR, API key, and body limits before invocation', async () => {
    const { database, registry, invocations } = setup()
    registry.register({
      workflowId: 'workflow-one',
      revision: 1,
      method: 'POST',
      path: '/deploy',
      publicRouteGranted: false,
      policy: {
        authentication: { type: 'apiKey', secretRef: 'deploy-key' },
        allowedHosts: ['hooks.example.test'],
        allowedOrigins: ['https://admin.example.test'],
        allowedSourceCidrs: ['192.0.2.0/24'],
        maxBodyBytes: 100,
      },
    })
    await expect(
      registry.handle({
        method: 'POST',
        path: '/workflows/deploy-hook/deploy',
        host: 'hooks.example.test',
        origin: 'https://admin.example.test',
        peerAddress: '192.0.2.10',
        headers: { 'x-api-key': 'wrong' },
        rawBody: Buffer.from('{}'),
      }),
    ).rejects.toThrow(/API key/)
    expect(invocations()).toBe(0)
    const result = await registry.handle({
      method: 'POST',
      path: '/workflows/deploy-hook/deploy',
      host: 'hooks.example.test',
      origin: 'https://admin.example.test',
      peerAddress: '192.0.2.10',
      headers: { 'x-api-key': 'route-secret' },
      rawBody: Buffer.from('{}'),
    })
    expect(result).toMatchObject({
      status: 202,
      headers: { 'access-control-allow-origin': 'https://admin.example.test' },
    })
    expect(invocations()).toBe(1)
    database.close()
  })

  it('validates timestamp+raw-body HMAC and rejects replay', async () => {
    const { database, registry } = setup()
    registry.register({
      workflowId: 'workflow-one',
      revision: 1,
      method: 'POST',
      path: '/signed',
      publicRouteGranted: false,
      policy: {
        authentication: { type: 'hmacSha256', secretRef: 'hook-key' },
        allowedHosts: ['hooks.example.test'],
        allowedOrigins: [],
        allowedSourceCidrs: ['127.0.0.0/8'],
        maxBodyBytes: 100,
      },
    })
    const timestamp = '1800000000'
    const rawBody = Buffer.from('{"ref":"main"}')
    const signature = createHmac('sha256', 'route-secret')
      .update(timestamp)
      .update('.')
      .update(rawBody)
      .digest('hex')
    const request = {
      method: 'POST',
      path: '/workflows/deploy-hook/signed',
      host: 'hooks.example.test',
      peerAddress: '127.0.0.1',
      headers: {
        'x-discord-mcp-timestamp': timestamp,
        'x-discord-mcp-signature': signature,
      },
      rawBody,
    }
    expect((await registry.handle(request)).status).toBe(202)
    await expect(registry.handle(request)).rejects.toThrow(/already used/)
    database.close()
  })

  it('treats an empty source-CIDR target list as no access', async () => {
    const { database, registry, invocations } = setup()
    registry.register({
      workflowId: 'workflow-one',
      revision: 1,
      method: 'POST',
      path: '/closed',
      publicRouteGranted: false,
      policy: {
        authentication: { type: 'apiKey', secretRef: 'deploy-key' },
        allowedHosts: ['hooks.example.test'],
        allowedOrigins: [],
        allowedSourceCidrs: [],
        maxBodyBytes: 100,
      },
    })
    await expect(
      registry.handle({
        method: 'POST',
        path: '/workflows/deploy-hook/closed',
        host: 'hooks.example.test',
        peerAddress: '127.0.0.1',
        headers: { 'x-api-key': 'route-secret' },
        rawBody: Buffer.from('{}'),
      }),
    ).rejects.toThrow(/source address/)
    expect(invocations()).toBe(0)
    database.close()
  })

  it('requires an explicit public grant for unauthenticated routes and rejects reserved paths', () => {
    const { database, registry } = setup()
    expect(() =>
      registry.register({
        workflowId: 'workflow-one',
        revision: 1,
        method: 'GET',
        path: '/public',
        publicRouteGranted: false,
        policy: {
          authentication: { type: 'none' },
          allowedHosts: ['example.test'],
          allowedOrigins: [],
          allowedSourceCidrs: [],
          maxBodyBytes: 1,
        },
      }),
    ).toThrow(RoutePolicyError)
    expect(() =>
      registry.register({
        workflowId: 'workflow-one',
        revision: 1,
        method: 'GET',
        path: '/mcp/escape',
        publicRouteGranted: true,
        policy: {
          authentication: { type: 'none' },
          allowedHosts: ['example.test'],
          allowedOrigins: [],
          allowedSourceCidrs: [],
          maxBodyBytes: 1,
        },
      }),
    ).toThrow(/reserved/)
    database.close()
  })
})
