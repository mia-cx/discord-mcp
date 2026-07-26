import {
  AuthProfiles,
  DiscordRest,
  OperationCatalog,
  PreviewTokens,
} from '@discord-mcp/discord-api'
import { Database, PersistenceLayer } from '@discord-mcp/persistence'
import { DEFAULT_GRANT, type WorkflowGrant } from '@discord-mcp/workflow-sdk'
import { Effect, Layer, ManagedRuntime } from 'effect'
import { describe, expect, it } from 'vitest'
import { CapabilityBroker } from '../src/broker.ts'
import type { CapabilityRequest } from '../src/capability-rpc.ts'
import { CapabilityServer } from '../src/capability-server.ts'

/**
 * The broker end to end: a call arrives from a container, is checked, and is either performed with
 * the bot's credential or refused with a reason.
 *
 * The two acceptance cases sit here — a granted workflow acts, an ungranted one cannot — because
 * this is the only place where both the check and the action are in the same path.
 */

const NOW = 1_780_000_000_000
const CHANNEL = '222222222222222222'
const GUILD = '111111111111111111'

const performed: Array<{ method: string; route: string }> = []

const stubRest = Layer.succeed(DiscordRest)({
  request: (req) => {
    performed.push({ method: req.method, route: String(req.route) })
    return Effect.succeed({ id: '999' })
  },
  raw: undefined as never,
})

const stubProfiles = Layer.succeed(AuthProfiles)({
  resolve: (name: string) => Effect.succeed({ name, kind: 'bot' as const }),
})

const layer = CapabilityServer.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      CapabilityBroker.layer,
      OperationCatalog.layer,
      PreviewTokens.layer,
      stubRest,
      stubProfiles,
      Layer.orDie(PersistenceLayer(':memory:')),
    ),
  ),
)

const runtime = ManagedRuntime.make(layer)

const grantFor = (overrides: Partial<WorkflowGrant['discord']> = {}): WorkflowGrant => ({
  ...DEFAULT_GRANT,
  discord: { ...DEFAULT_GRANT.discord, guildIds: [GUILD], channelIds: [CHANNEL], ...overrides },
})

/**
 * Issue a credential for a workflow that actually exists.
 *
 * Storage rows are foreign-keyed to a workflow, which is what scopes one workflow's keys away from
 * another's — so a test that skipped the row would be testing a shape production never has.
 */
const scopeFor = (workflowId: string, grant: WorkflowGrant) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const db = yield* Database
      yield* db.execute(
        `INSERT INTO workflows (id, slug, name, created_by, created_at, updated_at)
         VALUES (?, ?, ?, 'test', ?, ?) ON CONFLICT (id) DO NOTHING`,
        [workflowId, workflowId, workflowId, NOW, NOW],
      )

      const broker = yield* CapabilityBroker
      return yield* broker.issue({
        workflowId,
        revision: 1,
        executionId: 'exec-1',
        grant,
        causalDepth: 0,
        now: NOW,
      })
    }),
  )

const handle = (
  credential: Awaited<ReturnType<typeof scopeFor>>,
  call: CapabilityRequest['call'],
) =>
  runtime.runPromise(
    Effect.flatMap(CapabilityServer, (server) =>
      server.handle({
        request: { id: 'c1', credential: credential.token, call },
        scope: { credential, appendLog: () => Effect.void },
        now: NOW,
      }),
    ),
  )

const messageCall: CapabilityRequest['call'] = {
  kind: 'discord',
  operationId: 'create_message',
  path: { channel_id: CHANNEL },
  body: { content: 'hello' },
}

describe('a granted workflow', () => {
  it('can perform the Discord call its grant names', async () => {
    const credential = await scopeFor(
      'wf-granted',
      grantFor({ operationIds: ['create_message'], maxActionsPerMinute: 10 }),
    )

    const response = await handle(credential, messageCall)

    expect(response).toMatchObject({ ok: true })
    expect(performed.at(-1)).toEqual({ method: 'POST', route: `/channels/${CHANNEL}/messages` })
  })

  it('can read and write its own storage', async () => {
    const credential = await scopeFor('wf-kv', grantFor())

    await handle(credential, { kind: 'kv', op: 'set', key: 'seen', value: { count: 1 } })
    const read = await handle(credential, { kind: 'kv', op: 'get', key: 'seen' })

    expect(read).toMatchObject({ ok: true, result: { count: 1 } })
  })

  it('cannot read a key it never wrote, even one another workflow did', async () => {
    const other = await scopeFor('wf-other', grantFor())
    await handle(other, { kind: 'kv', op: 'set', key: 'secret', value: 'theirs' })

    const mine = await scopeFor('wf-mine', grantFor())
    const read = await handle(mine, { kind: 'kv', op: 'get', key: 'secret' })

    expect(read).toMatchObject({ ok: true, result: undefined })
  })

  it('sees an expired storage key as absent', async () => {
    const credential = await scopeFor('wf-ttl', grantFor())
    await handle(credential, { kind: 'kv', op: 'set', key: 'brief', value: 1, ttlSeconds: 1 })

    const later = await runtime.runPromise(
      Effect.flatMap(CapabilityServer, (server) =>
        server.handle({
          request: {
            id: 'c2',
            credential: credential.token,
            call: { kind: 'kv', op: 'get', key: 'brief' },
          },
          scope: { credential, appendLog: () => Effect.void },
          // The row still exists until cleanup runs; a TTL that only applied at cleanup time would
          // be advisory rather than a TTL.
          now: NOW + 2000,
        }),
      ),
    )

    expect(later).toMatchObject({ ok: true, result: undefined })
  })
})

describe('an ungranted workflow', () => {
  it('cannot perform the call, and no request reaches Discord', async () => {
    const credential = await scopeFor('wf-ungranted', DEFAULT_GRANT)
    const before = performed.length

    const response = await handle(credential, messageCall)

    expect(response).toMatchObject({ ok: false, denied: true })
    // The check happens before the credential is used, so a refused call costs Discord nothing and
    // never appears in a rate-limit bucket.
    expect(performed.length).toBe(before)
  })

  it('is told what to add to its grant', async () => {
    const credential = await scopeFor('wf-explain', DEFAULT_GRANT)
    const response = await handle(credential, messageCall)

    expect(response).toMatchObject({ ok: false })
    expect('message' in response && response.message).toContain('discord.operationIds')
  })

  it('cannot reach an unknown operation by inventing an ID', async () => {
    const credential = await scopeFor(
      'wf-invent',
      grantFor({ operationFamilies: ['messages'], operationIds: [] }),
    )

    const response = await handle(credential, {
      kind: 'discord',
      operationId: 'delete_everything',
      path: { channel_id: CHANNEL },
    })

    // An unknown operation has no family, so no grant can match it — naming a family does not
    // widen the surface to operations the catalog has never heard of.
    expect(response).toMatchObject({ ok: false, denied: true })
  })
})

describe('logging', () => {
  it('is accepted and recorded against the execution', async () => {
    const lines: string[] = []
    const credential = await scopeFor('wf-log', DEFAULT_GRANT)

    const response = await runtime.runPromise(
      Effect.flatMap(CapabilityServer, (server) =>
        server.handle({
          request: {
            id: 'c3',
            credential: credential.token,
            call: { kind: 'log', level: 'info', message: 'started' },
          },
          scope: {
            credential,
            appendLog: (line) =>
              Effect.sync(() => {
                lines.push(line)
              }),
          },
          now: NOW,
        }),
      ),
    )

    expect(response).toMatchObject({ ok: true })
    expect(lines).toEqual(['[info] started'])
  })
})
