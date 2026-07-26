import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AuthProfiles,
  DiscordRest,
  OperationCatalog,
  PreviewTokens,
} from '@discord-mcp/discord-api'
import { Database, PersistenceLayer } from '@discord-mcp/persistence'
import { type CompiledManifest, DEFAULT_GRANT, type WorkflowGrant } from '@discord-mcp/workflow-sdk'
import { Effect, Layer, ManagedRuntime } from 'effect'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CapabilityBroker } from '../src/broker.ts'
import { CapabilityServer } from '../src/capability-server.ts'
import { CapabilitySockets } from '../src/capability-socket.ts'
import { WorkflowDispatcher } from '../src/dispatcher.ts'
import { WorkflowQueues } from '../src/queue.ts'
import { WorkflowRepository } from '../src/repository.ts'
import { SandboxSupervisor } from '../src/sandbox.ts'

/**
 * The dispatcher, which is what makes an enabled workflow a running one.
 *
 * Everything else decides whether something may happen; these check that it does — and, just as
 * importantly, that a restart brings back what an operator turned on.
 */

const NOW = Date.UTC(2026, 6, 27, 9, 0, 0)
const WORKFLOW_ID = 'wf-dispatch'

interface Run {
  readonly workflowId: string
  readonly executionId: string
  readonly payload: unknown
}

let directory: string
let runs: Run[]
let runtime: ManagedRuntime.ManagedRuntime<
  WorkflowDispatcher | WorkflowRepository | WorkflowQueues | Database,
  never
>

const manifest = (overrides: Partial<CompiledManifest> = {}): CompiledManifest => ({
  triggers: [],
  actions: [],
  routes: [],
  commands: [],
  schedules: [],
  gatewayEventTypes: [],
  ...overrides,
})

const grantWith = (overrides: Partial<WorkflowGrant['gateway']> = {}): WorkflowGrant => ({
  ...DEFAULT_GRANT,
  discord: { ...DEFAULT_GRANT.discord, guildIds: ['111111111111111111'] },
  gateway: { ...DEFAULT_GRANT.gateway, ...overrides },
})

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dispatcher-'))
  runs = []

  const persistence = Layer.orDie(PersistenceLayer(':memory:'))

  const stubSupervisor = Layer.succeed(SandboxSupervisor)({
    build: () => Effect.die('not used'),
    run: (input) =>
      Effect.sync(() => {
        runs.push({
          workflowId: input.workflowId,
          executionId: input.executionId,
          payload: input.payload,
        })
        return { exitCode: 0, timedOut: false, logs: '' }
      }),
    stop: () => Effect.void,
    destroy: () => Effect.void,
  })

  const base = Layer.mergeAll(
    CapabilityBroker.layer,
    CapabilitySockets.layer({ directory }),
    WorkflowRepository.layer,
    WorkflowQueues.layer,
    stubSupervisor,
    CapabilityServer.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          CapabilityBroker.layer,
          OperationCatalog.layer,
          PreviewTokens.layer,
          Layer.succeed(DiscordRest)({
            request: () => Effect.succeed({}),
            raw: undefined as never,
          }),
          Layer.succeed(AuthProfiles)({
            resolve: (name: string) => Effect.succeed({ name, kind: 'bot' as const }),
          }),
          persistence,
        ),
      ),
    ),
  ).pipe(Layer.provideMerge(persistence))

  runtime = ManagedRuntime.make(
    Layer.mergeAll(WorkflowDispatcher.layer.pipe(Layer.provide(base)), base),
  )
})

afterEach(async () => {
  await runtime.dispose()
  await rm(directory, { recursive: true, force: true })
})

/** Put an enabled workflow in the database, the way the lifecycle tools would have. */
const seed = (input: {
  readonly manifest: CompiledManifest
  readonly grant: WorkflowGrant
  readonly enabled?: boolean
}) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const db = yield* Database
      yield* db.execute(
        `INSERT INTO workflows (id, slug, name, created_by, created_at, updated_at, enabled_revision)
         VALUES (?, 'dispatch', 'Dispatch', 'test', ?, ?, ?)`,
        [WORKFLOW_ID, NOW, NOW, input.enabled === false ? null : 1],
      )
      yield* db.execute(
        `INSERT INTO workflow_revisions
           (workflow_id, revision, source, dependencies_json, source_digest, requested_grants_json,
            compiled_manifest_json, artifact_digest, status, created_by, created_at)
         VALUES (?, 1, '', '{}', 'd', '{}', ?, 'sha256:a', 'published', 'test', ?)`,
        [WORKFLOW_ID, JSON.stringify(input.manifest), NOW],
      )

      const repository = yield* WorkflowRepository
      yield* repository.setGrant({
        workflowId: WORKFLOW_ID,
        revision: 1,
        grant: input.grant,
        grantedBy: 'test',
      })
    }),
  )

const dispatcher = <A>(f: (d: WorkflowDispatcher['Service']) => Effect.Effect<A>) =>
  runtime.runPromise(Effect.flatMap(WorkflowDispatcher, f))

/** Let the forked handler finish; the pump detaches it deliberately. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50))

describe('restart recovery', () => {
  it('brings back every workflow an operator had enabled', async () => {
    await seed({ manifest: manifest(), grant: grantWith() })

    const restored = await dispatcher((d) => d.restore())

    // Without this, a control-plane restart silently stops every automation, and nothing says so.
    expect(restored).toHaveLength(1)
    expect(restored[0]?.slug).toBe('dispatch')
  })

  it('leaves a disabled workflow disabled', async () => {
    await seed({ manifest: manifest(), grant: grantWith(), enabled: false })
    expect(await dispatcher((d) => d.restore())).toEqual([])
  })

  it('refuses to restore a revision whose grant is gone', async () => {
    await seed({ manifest: manifest(), grant: grantWith() })
    await runtime.runPromise(
      Effect.flatMap(Database, (db) =>
        db.execute('DELETE FROM workflow_grants WHERE workflow_id = ?', [WORKFLOW_ID]),
      ),
    )

    // An ungranted revision was never approved. Coming back after a restart would be approval by
    // accident.
    expect(await dispatcher((d) => d.restore())).toEqual([])
  })
})

describe('gateway dispatch', () => {
  const gatewayManifest = manifest({
    triggers: [{ kind: 'gateway', identifier: 'MESSAGE_CREATE' }],
    gatewayEventTypes: ['MESSAGE_CREATE'],
  })

  const event = (overrides: Record<string, unknown> = {}) => ({
    type: 'MESSAGE_CREATE',
    botAuthored: false,
    correlationId: 'corr-1',
    guildId: '111111111111111111',
    payload: { content: 'hello' },
    ...overrides,
  })

  it('runs a granted workflow when its event arrives', async () => {
    await seed({
      manifest: gatewayManifest,
      grant: grantWith({ eventTypes: ['MESSAGE_CREATE'] }),
    })
    await dispatcher((d) => d.restore())

    const offered = await dispatcher((d) => d.onGatewayEvent(event()))
    expect(offered).toEqual([{ slug: 'dispatch', accepted: true }])

    await dispatcher((d) => d.pump())
    await settle()

    expect(runs).toHaveLength(1)
    expect(runs[0]?.payload).toEqual({ index: 0, input: { content: 'hello' } })
  })

  it('does not run a workflow whose grant omits the event type', async () => {
    await seed({ manifest: gatewayManifest, grant: grantWith({ eventTypes: [] }) })
    await dispatcher((d) => d.restore())

    const offered = await dispatcher((d) => d.onGatewayEvent(event()))
    expect(offered).toEqual([{ slug: 'dispatch', accepted: false }])

    await dispatcher((d) => d.pump())
    await settle()
    expect(runs).toEqual([])
  })

  it('ignores the bot’s own events by default', async () => {
    await seed({ manifest: gatewayManifest, grant: grantWith({ eventTypes: ['MESSAGE_CREATE'] }) })
    await dispatcher((d) => d.restore())

    // The loop hazard: a workflow that posts a message and reacts to MESSAGE_CREATE triggers
    // itself forever unless self-authored events are excluded by default.
    const offered = await dispatcher((d) => d.onGatewayEvent(event({ botAuthored: true })))
    expect(offered).toEqual([{ slug: 'dispatch', accepted: false }])
  })

  it('runs on the bot’s own events when the grant asks for them', async () => {
    await seed({
      manifest: gatewayManifest,
      grant: grantWith({ eventTypes: ['MESSAGE_CREATE'], includeBotAuthoredEvents: true }),
    })
    await dispatcher((d) => d.restore())

    const offered = await dispatcher((d) => d.onGatewayEvent(event({ botAuthored: true })))
    expect(offered).toEqual([{ slug: 'dispatch', accepted: true }])
  })

  it('does not run for a guild the grant omits', async () => {
    await seed({ manifest: gatewayManifest, grant: grantWith({ eventTypes: ['MESSAGE_CREATE'] }) })
    await dispatcher((d) => d.restore())

    const offered = await dispatcher((d) =>
      d.onGatewayEvent(event({ guildId: '999999999999999999' })),
    )
    expect(offered).toEqual([{ slug: 'dispatch', accepted: false }])
  })

  it('ignores an event type the workflow never subscribed to', async () => {
    await seed({ manifest: gatewayManifest, grant: grantWith({ eventTypes: ['MESSAGE_CREATE'] }) })
    await dispatcher((d) => d.restore())

    expect(await dispatcher((d) => d.onGatewayEvent(event({ type: 'GUILD_DELETE' })))).toEqual([])
  })
})

describe('schedules', () => {
  const scheduled = manifest({
    triggers: [{ kind: 'schedule', identifier: '0 9 * * *' }],
    schedules: [{ expression: '0 9 * * *', triggerIndex: 0 }],
  })

  it('runs a workflow when its schedule is due', async () => {
    await seed({ manifest: scheduled, grant: grantWith() })
    await dispatcher((d) => d.restore())

    expect(await dispatcher((d) => d.tick(new Date(NOW)))).toBe(1)

    await dispatcher((d) => d.pump())
    await settle()
    expect(runs).toHaveLength(1)
  })

  it('does nothing at a minute the schedule does not name', async () => {
    await seed({ manifest: scheduled, grant: grantWith() })
    await dispatcher((d) => d.restore())

    expect(await dispatcher((d) => d.tick(new Date(NOW + 60_000)))).toBe(0)
  })

  it('runs once per minute however often it is ticked', async () => {
    await seed({ manifest: scheduled, grant: grantWith() })
    await dispatcher((d) => d.restore())

    // The loop ticks more often than once a minute, and a clock adjustment can repeat one. Neither
    // should produce a second execution.
    expect(await dispatcher((d) => d.tick(new Date(NOW)))).toBe(1)
    expect(await dispatcher((d) => d.tick(new Date(NOW + 5_000)))).toBe(0)
    expect(await dispatcher((d) => d.tick(new Date(NOW + 30_000)))).toBe(0)
  })
})

describe('the pump', () => {
  const gatewayManifest = manifest({
    triggers: [{ kind: 'gateway', identifier: 'MESSAGE_CREATE' }],
    gatewayEventTypes: ['MESSAGE_CREATE'],
  })

  it('honours the granted concurrency', async () => {
    await seed({
      manifest: gatewayManifest,
      grant: {
        ...grantWith({ eventTypes: ['MESSAGE_CREATE'] }),
        runtime: { ...DEFAULT_GRANT.runtime, concurrency: 1 },
      },
    })
    await dispatcher((d) => d.restore())

    for (let index = 0; index < 3; index += 1) {
      await dispatcher((d) =>
        d.onGatewayEvent({
          type: 'MESSAGE_CREATE',
          botAuthored: false,
          correlationId: `corr-${index}`,
          guildId: '111111111111111111',
          payload: { n: index },
        }),
      )
    }

    // One slot, so one start per pump — the rest stay queued rather than all starting at once.
    expect(await dispatcher((d) => d.pump())).toBe(1)
    await settle()
    expect(await dispatcher((d) => d.pump())).toBe(1)
    await settle()
    expect(runs).toHaveLength(2)
  })

  it('records every execution it starts', async () => {
    await seed({ manifest: gatewayManifest, grant: grantWith({ eventTypes: ['MESSAGE_CREATE'] }) })
    await dispatcher((d) => d.restore())

    await dispatcher((d) =>
      d.onGatewayEvent({
        type: 'MESSAGE_CREATE',
        botAuthored: false,
        correlationId: 'corr-1',
        guildId: '111111111111111111',
        payload: {},
      }),
    )
    await dispatcher((d) => d.pump())
    await settle()

    const executions = await runtime.runPromise(
      Effect.flatMap(WorkflowRepository, (repository) => repository.executions({ limit: 10 })),
    )

    expect(executions).toHaveLength(1)
    expect(executions[0]).toMatchObject({ trigger_kind: 'gateway', status: 'succeeded' })
  })

  it('does nothing when there is nothing queued', async () => {
    await seed({ manifest: gatewayManifest, grant: grantWith() })
    await dispatcher((d) => d.restore())

    expect(await dispatcher((d) => d.pump())).toBe(0)
  })
})
