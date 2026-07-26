import { createHmac, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SecretStore } from '@discord-mcp/auth'
import {
  AuthProfiles,
  DiscordRest,
  OperationCatalog,
  PreviewTokens,
} from '@discord-mcp/discord-api'
import { Database, PersistenceLayer } from '@discord-mcp/persistence'
import { DEFAULT_GRANT, type WorkflowGrant } from '@discord-mcp/workflow-sdk'
import { Effect, Layer, ManagedRuntime } from 'effect'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CapabilityBroker } from '../src/broker.ts'
import { CapabilityServer } from '../src/capability-server.ts'
import { CapabilitySockets } from '../src/capability-socket.ts'
import { WorkflowRepository } from '../src/repository.ts'
import { type IncomingRouteRequest, WorkflowRoutes } from '../src/route-dispatch.ts'
import { RouteRegistry } from '../src/route-registry.ts'
import { SandboxSupervisor } from '../src/sandbox.ts'

/**
 * A public request, from the wire to the workflow.
 *
 * This is the only path an unauthenticated stranger can take into the system, so the cases below
 * are all refusals except the two that prove the happy path still works.
 */

const NOW = 1_780_000_000_000
const SECRET = 'a-shared-webhook-secret'
const WORKFLOW_ID = 'wf-routes'

let directory: string
let runtime: ManagedRuntime.ManagedRuntime<
  WorkflowRoutes | RouteRegistry | WorkflowRepository,
  never
>

const stubSupervisor = Layer.succeed(SandboxSupervisor)({
  build: () => Effect.die('not used'),
  run: () => Effect.succeed({ exitCode: 0, timedOut: false, logs: '' }),
  stop: () => Effect.void,
  destroy: () => Effect.void,
})

const stubRest = Layer.succeed(DiscordRest)({
  request: () => Effect.succeed({}),
  raw: undefined as never,
})

const stubProfiles = Layer.succeed(AuthProfiles)({
  resolve: (name: string) => Effect.succeed({ name, kind: 'bot' as const }),
})

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'route-dispatch-'))

  const persistence = Layer.orDie(PersistenceLayer(':memory:'))
  const secrets = SecretStore.layer(Buffer.alloc(32)).pipe(Layer.provide(persistence))

  const base = Layer.mergeAll(
    CapabilityBroker.layer,
    CapabilitySockets.layer({ directory }),
    WorkflowRepository.layer,
    RouteRegistry.layer,
    stubSupervisor,
    secrets,
    CapabilityServer.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          CapabilityBroker.layer,
          OperationCatalog.layer,
          PreviewTokens.layer,
          stubRest,
          stubProfiles,
          persistence,
        ),
      ),
    ),
  ).pipe(Layer.provideMerge(persistence))

  runtime = ManagedRuntime.make(
    Layer.mergeAll(WorkflowRoutes.layer.pipe(Layer.provide(base)), base),
  )

  await runtime.runPromise(
    Effect.gen(function* () {
      const db = yield* Database
      yield* db.execute(
        `INSERT INTO workflows (id, slug, name, created_by, created_at, updated_at)
         VALUES (?, 'hooks', 'Hooks', 'test', ?, ?)`,
        [WORKFLOW_ID, NOW, NOW],
      )
      yield* db.execute(
        `INSERT INTO workflow_revisions
           (workflow_id, revision, source, dependencies_json, source_digest, requested_grants_json,
            status, created_by, created_at)
         VALUES (?, 1, '', '{}', 'digest', '{}', 'published', 'test', ?)`,
        [WORKFLOW_ID, NOW],
      )

      const secretStore = yield* SecretStore
      yield* secretStore.put('deploy-hook', SECRET)
    }),
  )
})

afterAll(async () => {
  await runtime.dispose()
  await rm(directory, { recursive: true, force: true })
})

const grantWith = (overrides: Partial<WorkflowGrant['routes']>): WorkflowGrant => ({
  ...DEFAULT_GRANT,
  routes: { ...DEFAULT_GRANT.routes, public: true, ...overrides },
})

const setUp = (input: {
  readonly grant: WorkflowGrant
  readonly auth: Parameters<RouteRegistry['Service']['register']>[0]['routes'][number]['auth']
}) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const repository = yield* WorkflowRepository
      yield* repository.setGrant({
        workflowId: WORKFLOW_ID,
        revision: 1,
        grant: input.grant,
        grantedBy: 'test',
      })

      const registry = yield* RouteRegistry
      yield* Effect.orDie(
        registry.register({
          workflowId: WORKFLOW_ID,
          workflowSlug: 'hooks',
          revision: 1,
          routes: [{ method: 'POST', relativePath: '/deploy', auth: input.auth, triggerIndex: 0 }],
        }),
      )
    }),
  )

const request = (overrides: Partial<IncomingRouteRequest> = {}): IncomingRouteRequest => ({
  method: 'POST',
  path: '/workflows/hooks/deploy',
  host: 'bot.example.com',
  origin: undefined,
  sourceIp: '203.0.113.7',
  headers: {},
  contentLength: 20,
  rawBody: '{"ref":"main"}',
  trustedSourceIp: '203.0.113.7',
  now: NOW,
  ...overrides,
})

const send = (input: IncomingRouteRequest) =>
  runtime.runPromise(Effect.flatMap(WorkflowRoutes, (routes) => routes.handle(input)))

describe('a public workflow route', () => {
  it('serves a request that passes every check', async () => {
    await setUp({ grant: grantWith({}), auth: { type: 'none' } })

    const response = await send(request())
    expect(response?.status).toBe(200)
  })

  it('is not found when the path belongs to no workflow', async () => {
    // Undefined rather than a 404 body: the caller decides how an unmatched path is answered, and
    // the control plane's own 404 should not be forgeable by registering a route.
    expect(await send(request({ path: '/workflows/nobody/anything' }))).toBeUndefined()
    expect(await send(request({ path: '/mcp' }))).toBeUndefined()
  })

  it('is not served at all unless the grant says public', async () => {
    await setUp({
      grant: { ...grantWith({}), routes: { ...DEFAULT_GRANT.routes, public: false } },
      auth: { type: 'none' },
    })

    const response = await send(request())
    expect(response?.status).toBe(404)
  })

  it('refuses an oversized body before reading it', async () => {
    await setUp({ grant: grantWith({ maxBodyBytes: 10 }), auth: { type: 'none' } })

    const response = await send(request({ contentLength: 5000 }))
    expect(response?.status).toBe(413)
  })

  it('refuses a host it does not serve', async () => {
    await setUp({ grant: grantWith({ allowedHosts: ['bot.example.com'] }), auth: { type: 'none' } })

    const response = await send(request({ host: 'attacker.example' }))
    expect(response?.status).toBe(404)
  })

  it('refuses a source address outside the allowed range', async () => {
    await setUp({
      grant: grantWith({ allowedSourceCidrs: ['203.0.113.0/24'] }),
      auth: { type: 'none' },
    })

    expect((await send(request({ trustedSourceIp: '198.51.100.4' })))?.status).toBe(403)
    expect((await send(request()))?.status).toBe(200)
  })
})

describe('route authentication end to end', () => {
  const sign = (timestamp: number, body: string) =>
    createHmac('sha256', SECRET).update(`${timestamp}.${body}`).digest('hex')

  it('accepts a correctly signed request and refuses an unsigned one', async () => {
    await setUp({
      grant: grantWith({}),
      auth: { type: 'hmacSha256', secretRef: 'deploy-hook' },
    })

    const body = '{"ref":"main"}'
    const signed = await send(
      request({
        rawBody: body,
        headers: {
          'x-signature': sign(NOW, body),
          'x-signature-timestamp': String(NOW),
        },
      }),
    )
    expect(signed?.status).toBe(200)

    expect((await send(request({ rawBody: body })))?.status).toBe(401)
  })

  it('refuses a replayed signature', async () => {
    await setUp({ grant: grantWith({}), auth: { type: 'hmacSha256', secretRef: 'deploy-hook' } })

    const body = `{"id":"${randomUUID()}"}`
    const headers = { 'x-signature': sign(NOW, body), 'x-signature-timestamp': String(NOW) }

    expect((await send(request({ rawBody: body, headers })))?.status).toBe(200)
    // The signature is still cryptographically valid; only the replay record stops the second
    // delivery.
    expect((await send(request({ rawBody: body, headers })))?.status).toBe(409)
  })

  it('refuses an API key that does not match', async () => {
    await setUp({ grant: grantWith({}), auth: { type: 'apiKey', secretRef: 'deploy-hook' } })

    expect((await send(request({ headers: { 'x-api-key': 'wrong' } })))?.status).toBe(401)
    expect((await send(request({ headers: { 'x-api-key': SECRET } })))?.status).toBe(200)
  })

  it('refuses a route whose secret is not configured', async () => {
    await setUp({ grant: grantWith({}), auth: { type: 'apiKey', secretRef: 'never-created' } })

    expect((await send(request({ headers: { 'x-api-key': SECRET } })))?.status).toBe(401)
  })
})

describe('CORS', () => {
  it('is added for a configured origin and is never the decision', async () => {
    await setUp({
      grant: grantWith({ allowedOrigins: ['https://app.example.com'] }),
      auth: { type: 'none' },
    })

    const allowed = await send(request({ origin: 'https://app.example.com' }))
    expect(allowed?.headers['access-control-allow-origin']).toBe('https://app.example.com')

    // An unlisted origin still reaches the handler: a non-browser client ignores CORS entirely, so
    // using it for access control would protect nobody.
    const other = await send(request({ origin: 'https://attacker.example' }))
    expect(other?.status).toBe(200)
    expect(other?.headers['access-control-allow-origin']).toBeUndefined()
  })
})

describe('route registration', () => {
  it('replaces a workflow’s routes rather than merging them', async () => {
    await runtime.runPromise(
      Effect.flatMap(RouteRegistry, (registry) =>
        Effect.orDie(
          registry.register({
            workflowId: WORKFLOW_ID,
            workflowSlug: 'hooks',
            revision: 1,
            routes: [
              { method: 'GET', relativePath: '/status', auth: { type: 'none' }, triggerIndex: 0 },
            ],
          }),
        ),
      ),
    )

    // The old route is gone: a route the new revision does not declare must stop being served.
    expect(await send(request())).toBeUndefined()
  })

  it('refuses a revision that declares one route twice', async () => {
    const result = await runtime.runPromiseExit(
      Effect.flatMap(RouteRegistry, (registry) =>
        registry.register({
          workflowId: WORKFLOW_ID,
          workflowSlug: 'hooks',
          revision: 1,
          routes: [
            { method: 'POST', relativePath: '/dup', auth: { type: 'none' }, triggerIndex: 0 },
            { method: 'POST', relativePath: '/dup', auth: { type: 'none' }, triggerIndex: 1 },
          ],
        }),
      ),
    )

    expect(result._tag).toBe('Failure')
  })

  it('refuses a path that would escape the namespace, writing nothing', async () => {
    const result = await runtime.runPromiseExit(
      Effect.flatMap(RouteRegistry, (registry) =>
        registry.register({
          workflowId: WORKFLOW_ID,
          workflowSlug: 'hooks',
          revision: 1,
          routes: [
            { method: 'GET', relativePath: '/fine', auth: { type: 'none' }, triggerIndex: 0 },
            { method: 'GET', relativePath: '/../../mcp', auth: { type: 'none' }, triggerIndex: 1 },
          ],
        }),
      ),
    )

    expect(result._tag).toBe('Failure')

    // Validation happens before any write, so the good route in the same batch did not land either.
    const routes = await runtime.runPromise(Effect.flatMap(RouteRegistry, (r) => r.list()))
    expect(routes.some((route) => route.path === '/workflows/hooks/fine')).toBe(false)
  })

  it('removes every route when a workflow is disabled', async () => {
    await setUp({ grant: grantWith({}), auth: { type: 'none' } })
    expect((await send(request()))?.status).toBe(200)

    await runtime.runPromise(Effect.flatMap(RouteRegistry, (r) => r.unregister(WORKFLOW_ID)))

    // A public URL that outlived the code behind it would answer with someone else's handler at
    // worst and a confusing 503 at best.
    expect(await send(request())).toBeUndefined()
  })
})
