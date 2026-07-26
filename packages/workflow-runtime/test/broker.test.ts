import { DEFAULT_GRANT, type WorkflowGrant } from '@discord-mcp/workflow-sdk'
import { Effect, ManagedRuntime } from 'effect'
import { beforeEach, describe, expect, it } from 'vitest'
import { CapabilityBroker } from '../src/broker.ts'

/**
 * The hostile-fixture suite, broker half.
 *
 * A workflow reaches the outside world only through these checks, so each case is one way a
 * workflow could try to act beyond its grant.
 */

const NOW = 1_780_000_000_000

const grant = (overrides: Partial<WorkflowGrant['discord']> = {}): WorkflowGrant => ({
  ...DEFAULT_GRANT,
  discord: {
    ...DEFAULT_GRANT.discord,
    operationIds: ['create_message'],
    operationFamilies: [],
    guildIds: ['111111111111111111'],
    channelIds: [],
    ...overrides,
  },
  network: { allowedOutboundHosts: ['api.example.com'] },
})

// One runtime for the whole suite: a fresh `Effect.provide` per call would give each its own broker
// state, and every credential would look unknown.
const runtime = ManagedRuntime.make(CapabilityBroker.layer)
const run = <A>(effect: Effect.Effect<A, never, CapabilityBroker>) => runtime.runPromise(effect)

const issue = (input: {
  readonly workflowId?: string
  readonly revision?: number
  readonly grant?: WorkflowGrant
  readonly causalDepth?: number
}) =>
  run(
    Effect.flatMap(CapabilityBroker, (broker) =>
      broker.issue({
        workflowId: input.workflowId ?? 'wf-a',
        revision: input.revision ?? 1,
        executionId: 'exec-1',
        grant: input.grant ?? grant(),
        causalDepth: input.causalDepth ?? 0,
        now: NOW,
      }),
    ),
  )

const authorize = (request: Parameters<CapabilityBroker['Service']['authorize']>[0]) =>
  run(Effect.flatMap(CapabilityBroker, (broker) => broker.authorize(request)))

const discordCall = (token: string, overrides: Record<string, unknown> = {}) =>
  authorize({
    token,
    kind: 'discord',
    operationId: 'create_message',
    operationFamily: 'messages',
    risk: 'write',
    guildId: '111111111111111111',
    now: NOW,
    ...overrides,
  })

describe('a granted workflow', () => {
  it('can make the call its grant names', async () => {
    const credential = await issue({})
    expect(await discordCall(credential.token)).toEqual({ allowed: true })
  })
})

describe('a workflow acting beyond its grant', () => {
  let token: string

  beforeEach(async () => {
    token = (await issue({ workflowId: `wf-${Math.random()}` })).token
  })

  it('cannot call an operation it was not granted', async () => {
    const decision = await discordCall(token, {
      operationId: 'delete_guild',
      operationFamily: 'guilds',
      risk: 'destructive',
    })
    expect(decision).toMatchObject({ allowed: false })
    expect('reason' in decision && decision.reason).toContain('is not granted')
  })

  it('cannot target a guild it was not granted', async () => {
    const decision = await discordCall(token, { guildId: '999999999999999999' })
    expect('reason' in decision && decision.reason).toContain('empty guild list grants no guilds')
  })

  it('cannot change bot-wide configuration without an explicit grant', async () => {
    const decision = await discordCall(token, {
      operationId: 'update_my_application',
      operationFamily: 'applications',
      risk: 'bot_admin',
      guildId: undefined,
    })
    expect('reason' in decision && decision.reason).toContain('botAdmin')
  })

  it('can never reach a credential operation, granted or not', async () => {
    const permissive = await issue({
      workflowId: 'wf-permissive',
      grant: {
        ...grant({ operationIds: ['exchange_oauth2_token'], botAdmin: true }),
      },
    })
    const decision = await discordCall(permissive.token, {
      operationId: 'exchange_oauth2_token',
      operationFamily: 'oauth2',
      risk: 'credential',
      guildId: undefined,
    })
    expect('reason' in decision && decision.reason).toContain('never callable from a workflow')
  })

  it('cannot use an OAuth profile it was not granted', async () => {
    const decision = await discordCall(token, { authProfile: 'someone-elses-account' })
    expect('reason' in decision && decision.reason).toContain('is not granted to this revision')
  })

  it('cannot reach an outbound host it was not granted', async () => {
    const decision = await authorize({
      token,
      kind: 'http',
      url: 'https://attacker.example/exfiltrate',
      now: NOW,
    })
    expect('reason' in decision && decision.reason).toContain('not in this revision')
  })

  it('cannot reach a cloud metadata service through the broker', async () => {
    const decision = await authorize({
      token,
      kind: 'http',
      url: 'http://169.254.169.254/latest/meta-data/',
      now: NOW,
    })
    expect(decision).toMatchObject({ allowed: false })
  })
})

describe('capability credentials', () => {
  it('are rejected when unknown', async () => {
    const decision = await discordCall('not-a-real-token')
    expect('reason' in decision && decision.reason).toContain('unknown, expired, or revoked')
  })

  it('are scoped to one revision, so a narrowed revision cannot borrow the old one’s reach', async () => {
    // Revision 1 could post; revision 2 had its grant narrowed to nothing. A credential is bound to
    // the revision it was minted for, so revision 2's credential gets revision 2's grant — the
    // narrowing is not something a workflow can undo by presenting a different token.
    const wide = await issue({ workflowId: 'wf-reuse', revision: 1 })
    const narrowed = await issue({ workflowId: 'wf-reuse', revision: 2, grant: DEFAULT_GRANT })

    expect(await discordCall(wide.token)).toEqual({ allowed: true })

    const decision = await discordCall(narrowed.token)
    expect('reason' in decision && decision.reason).toContain('is not granted')
  })

  it('stop working when the revision is disabled mid-execution', async () => {
    const credential = await issue({ workflowId: 'wf-disable' })
    expect(await discordCall(credential.token)).toEqual({ allowed: true })

    await run(
      Effect.flatMap(CapabilityBroker, (broker) => broker.setEnabled('wf-disable', 1, false)),
    )

    const decision = await discordCall(credential.token)
    expect('reason' in decision && decision.reason).toContain('no longer enabled')
  })

  it('expire with their execution', async () => {
    const credential = await issue({ workflowId: 'wf-expiry' })
    const decision = await discordCall(credential.token, { now: credential.expiresAt + 1 })
    expect('reason' in decision && decision.reason).toContain('expired')
  })

  it('stop working once revoked', async () => {
    const credential = await issue({ workflowId: 'wf-revoke' })
    await run(Effect.flatMap(CapabilityBroker, (broker) => broker.revoke(credential.token)))
    expect(await discordCall(credential.token)).toMatchObject({ allowed: false })
  })
})

describe('runaway workflows', () => {
  it('cannot exceed the action budget', async () => {
    const credential = await issue({
      workflowId: 'wf-budget',
      grant: {
        ...grant(),
        discord: { ...grant().discord, maxActionsPerMinute: 2 },
      },
    })

    expect(await discordCall(credential.token)).toEqual({ allowed: true })
    expect(await discordCall(credential.token)).toEqual({ allowed: true })

    const third = await discordCall(credential.token)
    expect('reason' in third && third.reason).toContain('granted budget')
  })

  it('do not consume budget on a call the broker refused', async () => {
    const credential = await issue({
      workflowId: 'wf-probe',
      grant: { ...grant(), discord: { ...grant().discord, maxActionsPerMinute: 1 } },
    })

    // A refused call must be free, or a workflow could burn its own budget probing.
    await discordCall(credential.token, { operationId: 'delete_guild', risk: 'destructive' })
    expect(await discordCall(credential.token)).toEqual({ allowed: true })
  })

  it('cannot recurse past the causal-depth limit', async () => {
    const credential = await issue({ workflowId: 'wf-depth', causalDepth: 5 })
    const decision = await discordCall(credential.token)
    expect('reason' in decision && decision.reason).toContain('Causal depth')
  })
})

describe('storage and logging', () => {
  it('need no target grant, because they are scoped to the workflow by construction', async () => {
    const credential = await issue({ workflowId: 'wf-kv', grant: DEFAULT_GRANT })
    expect(await authorize({ token: credential.token, kind: 'kv', now: NOW })).toEqual({
      allowed: true,
    })
    expect(await authorize({ token: credential.token, kind: 'log', now: NOW })).toEqual({
      allowed: true,
    })
  })
})
