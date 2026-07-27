import { generateKeyPairSync, sign } from 'node:crypto'
import { Database } from '@discord-mcp/persistence'
import { describe, expect, it } from 'vitest'
import { type InteractionCallback, InteractionHandler, presentationCallback } from './handler.js'

const keyFixture = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const der = publicKey.export({ format: 'der', type: 'spki' })
  return { privateKey, publicHex: der.subarray(-32).toString('hex') }
}

const signedRequest = (
  privateKey: ReturnType<typeof keyFixture>['privateKey'],
  body: unknown,
  timestamp: string,
) => {
  const rawBody = Buffer.from(JSON.stringify(body))
  return {
    rawBody,
    timestamp,
    signature: sign(null, Buffer.concat([Buffer.from(timestamp), rawBody]), privateKey).toString(
      'hex',
    ),
  }
}

describe('signed Discord interactions', () => {
  it('rejects signatures before JSON decoding and answers PING', async () => {
    const keys = keyFixture()
    const database = new Database(':memory:')
    database.migrate()
    const now = 1_800_000_000_000
    const handler = new InteractionHandler(
      database,
      keys.publicHex,
      { dispatch: async () => ({ type: 4 }) },
      () => now,
    )
    const timestamp = String(now / 1_000)
    expect(
      (
        await handler.handle({
          rawBody: Buffer.from('not-json'),
          timestamp,
          signature: '00'.repeat(64),
        })
      ).status,
    ).toBe(401)
    expect(
      JSON.parse(
        (await handler.handle(signedRequest(keys.privateKey, { type: 1 }, timestamp))).body,
      ),
    ).toEqual({ type: 1 })
    database.close()
  })

  it('resolves opaque handles, redacts tokens, and deduplicates', async () => {
    const keys = keyFixture()
    const database = new Database(':memory:')
    database.migrate()
    database.run(
      "INSERT INTO principals(id, name, kind, created_at) VALUES ('owner', 'Owner', 'local', ?)",
      new Date().toISOString(),
    )
    database.run(
      `INSERT INTO workflows
       (id, owner_principal_id, slug, name, enabled_revision, created_at, updated_at)
       VALUES ('workflow-one', 'owner', 'workflow-one', 'Workflow one', 2, ?, ?)`,
      new Date().toISOString(),
      new Date().toISOString(),
    )
    database.run(
      `INSERT INTO component_bindings
       (handle, owner_type, owner_id, owner_revision, action_type, action_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      'opaque-handle',
      'workflow',
      'workflow-one',
      2,
      'workflow',
      'approve',
      new Date().toISOString(),
    )
    let calls = 0
    const handler = new InteractionHandler(database, keys.publicHex, {
      dispatch: async (interaction, binding) => {
        calls += 1
        expect(interaction).not.toHaveProperty('token')
        expect(binding).toMatchObject({ ownerId: 'workflow-one', actionKey: 'approve' })
        return { type: 4, data: { content: 'done' } }
      },
    })
    const timestamp = String(Math.floor(Date.now() / 1_000))
    const body = {
      id: '12345678901234567',
      application_id: '12345678901234568',
      type: 3,
      token: 'must-not-persist',
      data: { custom_id: 'opaque-handle' },
    }
    const request = signedRequest(keys.privateKey, body, timestamp)
    expect(JSON.parse((await handler.handle(request)).body)).toMatchObject({ type: 4 })
    expect(JSON.parse((await handler.handle(request)).body)).toMatchObject({ type: 4 })
    expect(calls).toBe(1)
    expect(
      database.get<{ response_state_json: string }>(
        'SELECT response_state_json FROM interaction_deduplication WHERE interaction_id = ?',
        body.id,
      )?.response_state_json,
    ).not.toContain('must-not-persist')
    database.close()
  })

  it('defers slow handlers before the internal deadline', async () => {
    const keys = keyFixture()
    const database = new Database(':memory:')
    database.migrate()
    let release: ((value: InteractionCallback) => void) | undefined
    const completed: Array<InteractionCallback> = []
    const handler = new InteractionHandler(
      database,
      keys.publicHex,
      {
        dispatch: () =>
          new Promise((resolve) => {
            release = resolve
          }),
      },
      () => Date.now(),
      5,
      {
        complete: async (_interaction, callback) => {
          completed.push(callback)
        },
      },
    )
    const timestamp = String(Math.floor(Date.now() / 1_000))
    const request = signedRequest(
      keys.privateKey,
      {
        id: '12345678901234569',
        application_id: '12345678901234568',
        type: 2,
        data: { name: 'slow' },
      },
      timestamp,
    )
    expect(JSON.parse((await handler.handle(request)).body)).toEqual({ type: 5 })
    release?.({ type: 4, data: { content: 'later' } })
    await expect.poll(() => completed).toEqual([{ type: 4, data: { content: 'later' } }])
    expect(JSON.parse((await handler.handle(request)).body)).toEqual({ type: 5 })
    database.close()
  })

  it('returns and deduplicates a safe ephemeral response for an immediate handler failure', async () => {
    const keys = keyFixture()
    const database = new Database(':memory:')
    database.migrate()
    let calls = 0
    const handler = new InteractionHandler(database, keys.publicHex, {
      dispatch: async () => {
        calls += 1
        throw new Error('secret internal detail')
      },
    })
    const timestamp = String(Math.floor(Date.now() / 1_000))
    const request = signedRequest(
      keys.privateKey,
      {
        id: '12345678901234575',
        application_id: '12345678901234568',
        type: 2,
        data: { name: 'fails' },
      },
      timestamp,
    )
    const expected = {
      type: 4,
      data: { content: 'This interaction could not be completed.', flags: 64 },
    }
    expect(JSON.parse((await handler.handle(request)).body)).toEqual(expected)
    expect(JSON.parse((await handler.handle(request)).body)).toEqual(expected)
    expect(calls).toBe(1)
    database.close()
  })

  it('completes a deferred handler failure with a safe ephemeral original response', async () => {
    const keys = keyFixture()
    const database = new Database(':memory:')
    database.migrate()
    let rejectWork: ((cause: Error) => void) | undefined
    const completed: Array<InteractionCallback> = []
    const handler = new InteractionHandler(
      database,
      keys.publicHex,
      {
        dispatch: () =>
          new Promise((_resolve, reject) => {
            rejectWork = reject
          }),
      },
      () => Date.now(),
      1,
      {
        complete: async (_interaction, callback) => {
          completed.push(callback)
        },
      },
    )
    const timestamp = String(Math.floor(Date.now() / 1_000))
    const request = signedRequest(
      keys.privateKey,
      {
        id: '12345678901234576',
        application_id: '12345678901234568',
        type: 2,
        token: 'follow-up-token',
        data: { name: 'slow-failure' },
      },
      timestamp,
    )
    expect(JSON.parse((await handler.handle(request)).body)).toEqual({ type: 5 })
    rejectWork?.(new Error('late private failure'))
    await expect
      .poll(() => completed)
      .toEqual([
        {
          type: 4,
          data: { content: 'This interaction could not be completed.' },
        },
      ])
    database.close()
  })

  it('returns and deduplicates an empty result when autocomplete misses its deadline', async () => {
    const keys = keyFixture()
    const database = new Database(':memory:')
    database.migrate()
    let calls = 0
    const handler = new InteractionHandler(
      database,
      keys.publicHex,
      {
        dispatch: async () => {
          calls += 1
          await new Promise((resolve) => setTimeout(resolve, 20))
          throw new Error('late autocomplete failure')
        },
      },
      () => Date.now(),
      1,
    )
    const timestamp = String(Math.floor(Date.now() / 1_000))
    const request = signedRequest(
      keys.privateKey,
      {
        id: '12345678901234573',
        application_id: '12345678901234568',
        type: 4,
        data: { id: '12345678901234574', name: 'search' },
      },
      timestamp,
    )
    const expected = { type: 8, data: { choices: [] } }
    expect(JSON.parse((await handler.handle(request)).body)).toEqual(expected)
    expect(JSON.parse((await handler.handle(request)).body)).toEqual(expected)
    expect(calls).toBe(1)
    await new Promise((resolve) => setTimeout(resolve, 25))
    database.close()
  })

  it('rejects tampered, expired, and disabled-revision component handles', async () => {
    const keys = keyFixture()
    const database = new Database(':memory:')
    database.migrate()
    const now = 1_800_000_000_000
    database.run(
      "INSERT INTO principals(id, name, kind, created_at) VALUES ('owner', 'Owner', 'local', ?)",
      new Date(now).toISOString(),
    )
    database.run(
      `INSERT INTO workflows
       (id, owner_principal_id, slug, name, enabled_revision, created_at, updated_at)
       VALUES ('workflow-one', 'owner', 'workflow-one', 'Workflow one', 3, ?, ?)`,
      new Date(now).toISOString(),
      new Date(now).toISOString(),
    )
    database.run(
      `INSERT INTO component_bindings
       (handle, owner_type, owner_id, owner_revision, action_type, action_key, expires_at, created_at)
       VALUES
       ('expired-handle', 'workflow', 'workflow-one', 3, 'workflow', 'expired', ?, ?),
       ('old-revision-handle', 'workflow', 'workflow-one', 2, 'workflow', 'old', NULL, ?)`,
      new Date(now - 1).toISOString(),
      new Date(now - 60_000).toISOString(),
      new Date(now - 60_000).toISOString(),
    )
    let calls = 0
    const handler = new InteractionHandler(
      database,
      keys.publicHex,
      {
        dispatch: async () => {
          calls += 1
          return { type: 4 }
        },
      },
      () => now,
    )
    const timestamp = String(now / 1_000)
    for (const [id, customId, error] of [
      ['12345678901234570', 'tampered-handle', 'unknown or expired'],
      ['12345678901234571', 'expired-handle', 'unknown or expired'],
      ['12345678901234572', 'old-revision-handle', 'no longer enabled'],
    ] as const) {
      const result = await handler.handle(
        signedRequest(
          keys.privateKey,
          {
            id,
            application_id: '12345678901234568',
            type: 3,
            data: { custom_id: customId },
          },
          timestamp,
        ),
      )
      expect(result.status).toBe(400)
      expect(result.body).toContain(error)
    }
    expect(calls).toBe(0)
    database.close()
  })

  it('encodes validated Components V2 callback data', () => {
    expect(
      presentationCallback({
        type: 'components_v2',
        components: [{ type: 'text', content: 'Hello' }],
      }),
    ).toMatchObject({ type: 4, data: { flags: 32768 } })
  })
})
