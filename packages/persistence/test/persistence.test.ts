import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect, ManagedRuntime } from 'effect'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Database } from '../src/database.ts'
import { MIGRATIONS } from '../src/migrations.ts'
import {
  AuditRepository,
  BlueprintRepository,
  ComponentBindingRepository,
  cleanupExpired,
  PersistenceLayer,
  RevisionRepository,
} from '../src/repositories.ts'

/**
 * Against a real SQLite file, not a mock. The things most likely to be wrong here — foreign keys
 * being off by default, a migration recorded without applying, an upsert that fails on conflict —
 * are all invisible to a fake.
 */

type Services =
  | Database
  | BlueprintRepository
  | RevisionRepository
  | ComponentBindingRepository
  | AuditRepository

let dir: string
let runtime: ManagedRuntime.ManagedRuntime<Services, never>

const run = <A, E>(effect: Effect.Effect<A, E, Services>) => runtime.runPromise(effect)

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'discord-mcp-test-'))
  runtime = ManagedRuntime.make(PersistenceLayer(join(dir, 'test.sqlite')))
})

afterEach(async () => {
  await runtime.dispose()
  rmSync(dir, { recursive: true, force: true })
})

describe('migrations', () => {
  it('applies every migration and records it', async () => {
    const rows = await run(
      Effect.flatMap(Database, (db) =>
        db.query<{ id: number; name: string }>(
          'SELECT id, name FROM schema_migrations ORDER BY id',
        ),
      ),
    )
    expect(rows.map((r) => r.id)).toEqual(MIGRATIONS.map((m) => m.id))
  })

  it('is idempotent across restarts', async () => {
    await runtime.dispose()
    // Same file, fresh runtime: the second startup must not try to re-apply anything.
    const second = ManagedRuntime.make(PersistenceLayer(join(dir, 'test.sqlite')))
    const rows = await second.runPromise(
      Effect.flatMap(Database, (db) =>
        db.query<{ id: number }>('SELECT id FROM schema_migrations'),
      ),
    )
    expect(rows).toHaveLength(MIGRATIONS.length)
    await second.dispose()
    runtime = ManagedRuntime.make(PersistenceLayer(join(dir, 'test.sqlite')))
  })

  it('enforces foreign keys, which SQLite disables by default', async () => {
    const exit = await runtime.runPromiseExit(
      Effect.flatMap(Database, (db) =>
        db.execute(
          `INSERT INTO personal_access_tokens (id, principal_id, name, token_hash, created_at, expires_at)
           VALUES ('t1', 'nonexistent-principal', 'n', 'h', 0, 0)`,
        ),
      ),
    )
    expect(exit._tag).toBe('Failure')
  })
})

/** Bindings and executions are foreign-keyed to their blueprint, so the parent must exist. */
const createBlueprint = (id: string) =>
  run(
    Effect.flatMap(RevisionRepository, (r) =>
      r.saveDraft('server_blueprints', { id, name: id, draft: {} }),
    ),
  )

describe('blueprint bindings', () => {
  const BP = 'bp1'
  const GUILD = '123456789012345678'

  beforeEach(async () => {
    await createBlueprint(BP)
  })

  it('maps logical keys to snowflakes and survives rebinding', async () => {
    await run(
      Effect.flatMap(BlueprintRepository, (r) =>
        r.bind(BP, GUILD, {
          logicalKey: 'general',
          discordId: '900000000000000001',
          objectKind: 'channel',
        }),
      ),
    )
    expect(await run(Effect.flatMap(BlueprintRepository, (r) => r.bindings(BP, GUILD)))).toEqual(
      new Map([['general', '900000000000000001']]),
    )

    // Rebinding after a manual delete-and-recreate must update, not fail on conflict.
    await run(
      Effect.flatMap(BlueprintRepository, (r) =>
        r.bind(BP, GUILD, {
          logicalKey: 'general',
          discordId: '900000000000000002',
          objectKind: 'channel',
        }),
      ),
    )
    expect(await run(Effect.flatMap(BlueprintRepository, (r) => r.bindings(BP, GUILD)))).toEqual(
      new Map([['general', '900000000000000002']]),
    )
  })

  it('scopes bindings per guild, so one blueprint can manage several', async () => {
    await run(
      Effect.flatMap(BlueprintRepository, (r) =>
        Effect.all([
          r.bind(BP, GUILD, { logicalKey: 'general', discordId: '1', objectKind: 'channel' }),
          r.bind(BP, '999999999999999999', {
            logicalKey: 'general',
            discordId: '2',
            objectKind: 'channel',
          }),
        ]),
      ),
    )
    expect(
      (await run(Effect.flatMap(BlueprintRepository, (r) => r.bindings(BP, GUILD)))).get('general'),
    ).toBe('1')
  })
})

describe('the apply journal', () => {
  it('records the whole plan up front and resumes from what is still pending', async () => {
    await createBlueprint('bp1')
    const executionId = await run(
      Effect.flatMap(BlueprintRepository, (r) =>
        r.startExecution({
          blueprintId: 'bp1',
          revision: 1,
          guildId: '123456789012345678',
          snapshotDigest: 'abc',
          startedBy: 'p1',
          actions: [
            { kind: 'createRole', logicalKey: 'mods', summary: 'Create role', payload: {} },
            {
              kind: 'createChannel',
              logicalKey: 'general',
              summary: 'Create channel',
              payload: {},
            },
            {
              kind: 'setOverwrites',
              logicalKey: 'general',
              summary: 'Set overwrites',
              payload: {},
            },
          ],
        }),
      ),
    )

    // Discord has no transactions, so partial failure must leave a resumable record.
    await run(
      Effect.flatMap(BlueprintRepository, (r) =>
        r.completeAction(executionId, 0, { status: 'completed', discordId: '900000000000000001' }),
      ),
    )

    const pending = await run(
      Effect.flatMap(BlueprintRepository, (r) => r.pendingActions(executionId)),
    )
    expect(pending.map((a) => a.sequence)).toEqual([1, 2])
    expect(pending[0]?.kind).toBe('createChannel')

    const resumable = await run(
      Effect.flatMap(BlueprintRepository, (r) => r.resumableExecutions('123456789012345678')),
    )
    expect(resumable.map((e) => e.id)).toEqual([executionId])

    await run(Effect.flatMap(BlueprintRepository, (r) => r.finishExecution(executionId, 'partial')))
    expect(
      await run(
        Effect.flatMap(BlueprintRepository, (r) => r.resumableExecutions('123456789012345678')),
      ),
    ).toEqual([])
  })
})

describe('revisions', () => {
  it('freezes a published revision and increments', async () => {
    const publish = (body: unknown) =>
      run(
        Effect.flatMap(RevisionRepository, (r) =>
          r.publish('server_blueprints', { id: 'bp1', name: 'bp', body, publishedBy: 'p1' }),
        ),
      )

    await run(
      Effect.flatMap(RevisionRepository, (r) =>
        r.saveDraft('server_blueprints', { id: 'bp1', name: 'bp', draft: { roles: [] } }),
      ),
    )

    const first = await publish({ roles: [{ key: 'a', name: 'A' }] })
    const second = await publish({ roles: [{ key: 'b', name: 'B' }] })

    expect(first.revision).toBe(1)
    expect(second.revision).toBe(2)
    expect(first.digest).not.toBe(second.digest)

    // Revision 1 must still read back exactly as published: an apply pinned to it cannot drift.
    const stored = await run(
      Effect.flatMap(RevisionRepository, (r) => r.getRevision('server_blueprints', 'bp1', 1)),
    )
    expect(stored?.body).toEqual({ roles: [{ key: 'a', name: 'A' }] })
    expect(stored?.digest).toBe(first.digest)
  })

  it('refuses to publish without a draft, naming what to do', async () => {
    const exit = await runtime.runPromiseExit(
      Effect.flatMap(RevisionRepository, (r) =>
        r.publish('server_blueprints', {
          id: 'never-drafted',
          name: 'x',
          body: {},
          publishedBy: 'p',
        }),
      ),
    )
    expect(exit._tag).toBe('Failure')
    expect(JSON.stringify(exit)).toContain('Create a draft before publishing')
  })

  it('digests identical bodies identically, so a no-op republish is detectable', async () => {
    const body = { roles: [{ key: 'a', name: 'A' }] }
    await run(
      Effect.flatMap(RevisionRepository, (r) =>
        r.saveDraft('message_templates', { id: 't1', name: 't', draft: body }),
      ),
    )
    const a = await run(
      Effect.flatMap(RevisionRepository, (r) =>
        r.publish('message_templates', { id: 't1', name: 't', body, publishedBy: 'p' }),
      ),
    )
    const b = await run(
      Effect.flatMap(RevisionRepository, (r) =>
        r.publish('message_templates', { id: 't1', name: 't', body, publishedBy: 'p' }),
      ),
    )
    expect(a.digest).toBe(b.digest)
  })
})

describe('component bindings', () => {
  it('mints an opaque handle that carries no meaning and fits Discord’s limit', async () => {
    const handle = await run(
      Effect.flatMap(ComponentBindingRepository, (r) =>
        r.create({
          kind: 'workflow',
          actionKey: 'acknowledge',
          ownerKind: 'workflow',
          ownerId: 'w1',
          ownerRevision: 3,
        }),
      ),
    )

    expect(handle.length).toBeLessThanOrEqual(100)
    // Nothing about the action is recoverable from the handle itself: Discord round-trips it
    // through the client, so anything encoded in it would come back as untrusted input.
    expect(handle).not.toContain('acknowledge')
    expect(handle).not.toContain('w1')

    const resolved = await run(Effect.flatMap(ComponentBindingRepository, (r) => r.resolve(handle)))
    expect(resolved).toMatchObject({
      kind: 'workflow',
      actionKey: 'acknowledge',
      ownerId: 'w1',
      ownerRevision: 3,
    })
  })

  it('returns undefined for a tampered handle rather than guessing', async () => {
    const handle = await run(
      Effect.flatMap(ComponentBindingRepository, (r) =>
        r.create({ kind: 'inbox', actionKey: 'k', ownerKind: 'message', ownerId: 'm1' }),
      ),
    )
    expect(
      await run(Effect.flatMap(ComponentBindingRepository, (r) => r.resolve(`${handle}x`))),
    ).toBeUndefined()
  })
})

describe('audit and retention', () => {
  it('records and reads back audit entries newest first', async () => {
    await run(
      Effect.flatMap(AuditRepository, (r) =>
        Effect.all([
          r.record({ principalId: 'p1', action: 'blueprint.apply', outcome: 'allowed' }),
          r.record({ principalId: 'p1', action: 'workflow.enable', outcome: 'denied' }),
        ]),
      ),
    )
    const rows = await run(Effect.flatMap(AuditRepository, (r) => r.list({ limit: 10 })))
    expect(rows).toHaveLength(2)
  })

  it('deletes what has aged out and leaves what has not', async () => {
    const db = await run(Database.pipe(Effect.map((d) => d)))
    const old = Date.now() - 40 * 24 * 60 * 60 * 1000

    await run(
      db.execute(
        'INSERT INTO interaction_deduplication (interaction_id, received_at) VALUES (?, ?)',
        ['old', old],
      ),
    )
    await run(
      db.execute(
        'INSERT INTO interaction_deduplication (interaction_id, received_at) VALUES (?, ?)',
        ['fresh', Date.now()],
      ),
    )

    await run(cleanupExpired(db))

    const remaining = await run(
      db.query<{ interaction_id: string }>('SELECT interaction_id FROM interaction_deduplication'),
    )
    expect(remaining.map((r) => r.interaction_id)).toEqual(['fresh'])
  })
})
