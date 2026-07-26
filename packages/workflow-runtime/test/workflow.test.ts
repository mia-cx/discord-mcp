import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Database, PersistenceLayer } from '@discord-mcp/persistence'
import {
  compileManifest,
  DEFAULT_GRANT,
  isWorkflow,
  Trigger,
  WORKFLOW_LIMITS,
  Workflow,
} from '@discord-mcp/workflow-sdk'
import { Effect, Layer, ManagedRuntime } from 'effect'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  checkCausalDepth,
  checkCommandPublishing,
  checkDiscordCall,
  checkGatewayEvent,
  checkOutboundHttp,
  makeActionBudget,
} from '../src/grants.ts'
import { WorkflowRepository } from '../src/repository.ts'

const GUILD = '123456789012345678'
const CHANNEL = '222222222222222222'

let dir: string
let runtime: ManagedRuntime.ManagedRuntime<WorkflowRepository | Database, never>

const run = <A, E>(effect: Effect.Effect<A, E, WorkflowRepository | Database>) =>
  runtime.runPromise(effect)

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'discord-mcp-workflow-'))
  runtime = ManagedRuntime.make(
    WorkflowRepository.layer.pipe(Layer.provideMerge(PersistenceLayer(join(dir, 'w.sqlite')))),
  )
})

afterEach(async () => {
  await runtime.dispose()
  rmSync(dir, { recursive: true, force: true })
})

describe('the SDK is descriptive, not executable', () => {
  const workflow = Workflow.make({
    triggers: [
      Trigger.schedule({ schedule: '0 9 * * 1', handler: () => Effect.void }),
      Trigger.interactionComponent({ action: 'acknowledge', handler: () => Effect.void }),
      Trigger.interactionCommand({
        name: 'status',
        description: 'Report status',
        handler: () => Effect.void,
      }),
      Trigger.gateway({ events: ['MESSAGE_CREATE'], handler: () => Effect.void }),
      Trigger.http({
        method: 'POST',
        path: '/deploy',
        auth: { type: 'hmacSha256', secretRef: 'deploy-hook' },
        handler: () => Effect.void,
      }),
    ],
  })

  it('marks a workflow so the build sandbox can recognise one', () => {
    expect(isWorkflow(workflow)).toBe(true)
    expect(isWorkflow({ triggers: [] })).toBe(false)
  })

  it('compiles to a manifest containing no functions', () => {
    // The control plane validates the manifest, never the module — so nothing executable crosses
    // the sandbox boundary.
    const manifest = compileManifest(workflow)
    const serialised = JSON.stringify(manifest)

    expect(serialised).not.toContain('function')
    expect(JSON.parse(serialised)).toEqual(manifest)
  })

  it('surfaces exactly what the control plane has to approve', () => {
    const manifest = compileManifest(workflow)

    expect(manifest.actions).toEqual(['acknowledge'])
    expect(manifest.commands).toEqual([{ name: 'status', description: 'Report status' }])
    expect(manifest.schedules).toEqual(['0 9 * * 1'])
    expect(manifest.gatewayEventTypes).toEqual(['MESSAGE_CREATE'])
    expect(manifest.routes).toEqual([
      { method: 'POST', path: '/deploy', auth: { type: 'hmacSha256', secretRef: 'deploy-hook' } },
    ])
  })

  it('never asks an author to construct a custom_id', () => {
    // Authors name a logical action; the control plane compiles it into an opaque handle. Discord
    // round-trips custom_id through the client, so an author-chosen one would come back untrusted.
    const manifest = compileManifest(workflow)
    expect(manifest.actions).toEqual(['acknowledge'])
    expect(JSON.stringify(manifest)).not.toContain('custom_id')
  })
})

describe('grants are default-deny', () => {
  const granted = {
    ...DEFAULT_GRANT,
    discord: {
      ...DEFAULT_GRANT.discord,
      operationFamilies: ['message'],
      guildIds: [GUILD],
    },
    gateway: { eventTypes: ['MESSAGE_CREATE'], includeBotAuthoredEvents: false },
    network: { allowedOutboundHosts: ['api.example.com'] },
  }

  it('refuses an operation nothing granted', () => {
    const decision = checkDiscordCall(DEFAULT_GRANT, {
      operationId: 'create_message',
      operationFamily: 'message',
      risk: 'write',
    })
    expect(decision.allowed).toBe(false)
  })

  it('treats an empty guild list as no guilds, not all of them', () => {
    // The inversion that matters. The usual convention would let a missing field grant everything.
    const decision = checkDiscordCall(
      { ...granted, discord: { ...granted.discord, guildIds: [] } },
      { operationId: 'create_message', operationFamily: 'message', guildId: GUILD, risk: 'write' },
    )
    expect(decision.allowed).toBe(false)
    if (!decision.allowed) expect(decision.reason).toContain('not all of them')
  })

  it('allows a granted call', () => {
    expect(
      checkDiscordCall(granted, {
        operationId: 'create_message',
        operationFamily: 'message',
        guildId: GUILD,
        channelId: CHANNEL,
        risk: 'write',
      }).allowed,
    ).toBe(true)
  })

  it('never allows a credential operation, however generous the grant', () => {
    const everything = {
      ...granted,
      discord: {
        ...granted.discord,
        operationIds: ['partner_sdk_token'],
        operationFamilies: ['oauth'],
        botAdmin: true,
      },
    }
    expect(
      checkDiscordCall(everything, {
        operationId: 'partner_sdk_token',
        operationFamily: 'oauth',
        risk: 'credential',
      }).allowed,
    ).toBe(false)
  })

  it('requires an explicit grant for bot administration', () => {
    const decision = checkDiscordCall(
      { ...granted, discord: { ...granted.discord, operationFamilies: ['application'] } },
      {
        operationId: 'create_application_command',
        operationFamily: 'application',
        risk: 'bot_admin',
      },
    )
    expect(decision.allowed).toBe(false)
    if (!decision.allowed) expect(decision.reason).toContain('every guild')
  })

  it('refuses an OAuth2 profile the revision does not name', () => {
    const decision = checkDiscordCall(granted, {
      operationId: 'create_message',
      operationFamily: 'message',
      guildId: GUILD,
      authProfile: 'someone-elses-profile',
      risk: 'write',
    })
    expect(decision.allowed).toBe(false)
  })
})

describe('loop prevention', () => {
  const granted = {
    ...DEFAULT_GRANT,
    discord: { ...DEFAULT_GRANT.discord, guildIds: [GUILD] },
    gateway: { eventTypes: ['MESSAGE_CREATE'], includeBotAuthoredEvents: false },
  }

  it('excludes self-authored events by default', () => {
    // A workflow that posts a message and reacts to MESSAGE_CREATE triggers itself forever.
    const decision = checkGatewayEvent(granted, {
      type: 'MESSAGE_CREATE',
      botAuthored: true,
      guildId: GUILD,
    })
    expect(decision.allowed).toBe(false)
    if (!decision.allowed) expect(decision.reason).toContain('never stops')
  })

  it('allows self-authored events only when explicitly granted', () => {
    expect(
      checkGatewayEvent(
        { ...granted, gateway: { ...granted.gateway, includeBotAuthoredEvents: true } },
        { type: 'MESSAGE_CREATE', botAuthored: true, guildId: GUILD },
      ).allowed,
    ).toBe(true)
  })

  it('caps causal depth so an indirect cycle still terminates', () => {
    expect(checkCausalDepth(4, WORKFLOW_LIMITS.maxCausalDepth).allowed).toBe(true)
    const stopped = checkCausalDepth(5, WORKFLOW_LIMITS.maxCausalDepth)
    expect(stopped.allowed).toBe(false)
    if (!stopped.allowed) expect(stopped.reason).toContain('not converging')
  })

  it('enforces a per-minute action budget on valid calls too', () => {
    // RateGuard counts rejections; this counts everything. A tight loop of perfectly valid calls
    // still exhausts a rate limit shared with every other user of the token.
    const budget = makeActionBudget({
      ...DEFAULT_GRANT,
      discord: { ...DEFAULT_GRANT.discord, maxActionsPerMinute: 3 },
    })

    const now = 1_700_000_000_000
    expect(budget.consume('w1:1', now).allowed).toBe(true)
    expect(budget.consume('w1:1', now).allowed).toBe(true)
    expect(budget.consume('w1:1', now).allowed).toBe(true)
    expect(budget.consume('w1:1', now).allowed).toBe(false)

    // A minute later the window has rolled.
    expect(budget.consume('w1:1', now + 61_000).allowed).toBe(true)
  })
})

describe('brokered network access', () => {
  const granted = {
    ...DEFAULT_GRANT,
    network: { allowedOutboundHosts: ['api.example.com'] },
  }

  it('allows only granted hosts', () => {
    expect(checkOutboundHttp(granted, 'https://api.example.com/hook').allowed).toBe(true)
    expect(checkOutboundHttp(granted, 'https://evil.example.net/hook').allowed).toBe(false)
  })

  it('refuses non-http protocols', () => {
    expect(checkOutboundHttp(granted, 'file:///etc/passwd').allowed).toBe(false)
    expect(checkOutboundHttp(granted, 'not a url').allowed).toBe(false)
  })

  it('says a workflow has no direct network access', () => {
    const denial = checkOutboundHttp(granted, 'https://evil.example.net')
    if (!denial.allowed) expect(denial.reason).toContain('no direct network access')
  })
})

describe('command publishing', () => {
  it('needs an explicit grant, and global needs its own', () => {
    const guildOnly = {
      ...DEFAULT_GRANT,
      interactions: { guildCommandPublishing: true, globalCommandPublishing: false },
    }
    expect(checkCommandPublishing(guildOnly, 'guild').allowed).toBe(true)

    const global = checkCommandPublishing(guildOnly, 'global')
    expect(global.allowed).toBe(false)
    // A global command appears in every guild the bot is in.
    if (!global.allowed) expect(global.reason).toContain('every guild')
  })
})

describe('the lifecycle keeps capability separate from source', () => {
  const seed = async () => {
    const workflow = await run(
      Effect.flatMap(WorkflowRepository, (r) =>
        r.create({ slug: 'weekly-status', name: 'Weekly status', createdBy: 'p1' }),
      ),
    )
    const draft = await run(
      Effect.flatMap(WorkflowRepository, (r) =>
        r.saveDraft({
          workflowId: workflow.id,
          source: 'export default Workflow.make({ triggers: [] })',
          dependencies: {},
          requestedGrants: DEFAULT_GRANT,
          createdBy: 'p1',
        }),
      ),
    )
    return { workflow, draft }
  }

  it('starts a draft ungranted and unpublished', async () => {
    const { workflow, draft } = await seed()

    expect(draft.status).toBe('draft')
    expect(draft.artifactDigest).toBeNull()
    expect(workflow.enabledRevision).toBeNull()

    // Absent, not DEFAULT_GRANT: an ungranted revision must not run at all, which is a different
    // state from one granted nothing.
    const grant = await run(
      Effect.flatMap(WorkflowRepository, (r) => r.getGrant(workflow.id, draft.revision)),
    )
    expect(grant).toBeUndefined()
  })

  it('refuses to publish a revision that has not built', async () => {
    const { workflow, draft } = await seed()
    await run(Effect.flatMap(WorkflowRepository, (r) => r.publish(workflow.id, draft.revision)))

    const after = await run(
      Effect.flatMap(WorkflowRepository, (r) => r.getRevision(workflow.id, draft.revision)),
    )
    // Publishing requires a successful build artifact; the update matches only `validated`.
    expect(after?.status).toBe('draft')
  })

  it('publishes once a build has been recorded', async () => {
    const { workflow, draft } = await seed()
    await run(
      Effect.flatMap(WorkflowRepository, (r) =>
        r.recordBuild({
          workflowId: workflow.id,
          revision: draft.revision,
          artifactDigest: 'sha256:abc',
          manifest: compileManifest(Workflow.make({ triggers: [] })),
        }),
      ),
    )
    await run(Effect.flatMap(WorkflowRepository, (r) => r.publish(workflow.id, draft.revision)))

    const after = await run(
      Effect.flatMap(WorkflowRepository, (r) => r.getRevision(workflow.id, draft.revision)),
    )
    expect(after?.status).toBe('published')
    expect(after?.artifactDigest).toBe('sha256:abc')
  })

  it('records build diagnostics rather than discarding them', async () => {
    const { workflow, draft } = await seed()
    await run(
      Effect.flatMap(WorkflowRepository, (r) =>
        r.recordBuildFailure({
          workflowId: workflow.id,
          revision: draft.revision,
          diagnostics: ["src/index.ts(3,1): Cannot find name 'fetch'."],
        }),
      ),
    )

    const after = await run(
      Effect.flatMap(WorkflowRepository, (r) => r.getRevision(workflow.id, draft.revision)),
    )
    expect(after?.status).toBe('failed')
    expect(after?.diagnostics[0]).toContain('Cannot find name')
  })

  it('grants and enables as separate steps', async () => {
    const { workflow, draft } = await seed()

    await run(
      Effect.flatMap(WorkflowRepository, (r) =>
        r.setGrant({
          workflowId: workflow.id,
          revision: draft.revision,
          grant: { ...DEFAULT_GRANT, discord: { ...DEFAULT_GRANT.discord, guildIds: [GUILD] } },
          grantedBy: 'admin',
        }),
      ),
    )

    // Granting alone does not enable: approving what a workflow may do is a different decision
    // from turning it on.
    const stillDisabled = await run(
      Effect.flatMap(WorkflowRepository, (r) => r.get('weekly-status')),
    )
    expect(stillDisabled?.enabledRevision).toBeNull()

    await run(Effect.flatMap(WorkflowRepository, (r) => r.enable(workflow.id, draft.revision)))
    const enabled = await run(Effect.flatMap(WorkflowRepository, (r) => r.get('weekly-status')))
    expect(enabled?.enabledRevision).toBe(draft.revision)
  })

  it('rolls back by enabling an earlier revision without rebuilding', async () => {
    const { workflow, draft } = await seed()
    const second = await run(
      Effect.flatMap(WorkflowRepository, (r) =>
        r.saveDraft({
          workflowId: workflow.id,
          source: 'export default Workflow.make({ triggers: [] }) // v2',
          dependencies: {},
          requestedGrants: DEFAULT_GRANT,
          createdBy: 'p1',
        }),
      ),
    )

    expect(second.revision).toBe(draft.revision + 1)
    await run(Effect.flatMap(WorkflowRepository, (r) => r.enable(workflow.id, second.revision)))
    await run(Effect.flatMap(WorkflowRepository, (r) => r.enable(workflow.id, draft.revision)))

    const rolled = await run(Effect.flatMap(WorkflowRepository, (r) => r.get('weekly-status')))
    expect(rolled?.enabledRevision).toBe(draft.revision)
  })

  it('records executions with their causal chain', async () => {
    const { workflow, draft } = await seed()
    const executionId = await run(
      Effect.flatMap(WorkflowRepository, (r) =>
        r.recordExecution({
          workflowId: workflow.id,
          revision: draft.revision,
          triggerKind: 'schedule',
          correlationId: 'c1',
          causalDepth: 2,
        }),
      ),
    )
    await run(
      Effect.flatMap(WorkflowRepository, (r) =>
        r.finishExecution({ executionId, status: 'succeeded', logs: 'done' }),
      ),
    )

    const listed = await run(
      Effect.flatMap(WorkflowRepository, (r) =>
        r.executions({ workflowId: workflow.id, limit: 10 }),
      ),
    )
    expect(listed).toHaveLength(1)
    expect(listed[0]?.status).toBe('succeeded')
    // Depth travels with the execution, so the next one it causes knows how deep it already is.
    expect(listed[0]?.causal_depth).toBe(2)
  })
})
