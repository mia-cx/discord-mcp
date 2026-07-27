import { Database } from '@discord-mcp/persistence'
import { describe, expect, it } from 'vitest'
import { CapabilityBroker } from './broker.js'
import { WorkflowStore } from './store.js'
import { defaultWorkflowGrant, validateCompiledManifest } from './types.js'

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
  const store = new WorkflowStore(database, {
    build: async ({ source }) => ({
      artifactDigest: `artifact:${source}`,
      lockfile: 'lockfileVersion: 9',
      manifest: { triggers: [{ type: 'manual', key: 'run', index: 0 }] },
      diagnostics: [],
    }),
  })
  return { database, store }
}

describe('workflow lifecycle and capability broker', () => {
  it('runs draft → validate → publish → grant → enable and supports rollback', async () => {
    const { database, store } = setup()
    const workflow = store.create({
      ownerPrincipalId: 'owner',
      slug: 'release-bot',
      name: 'Release bot',
      source: 'export default {}',
    })
    await store.validate(workflow.id, 1)
    store.publish(workflow.id, 1)
    const grant = defaultWorkflowGrant()
    store.grant({ workflowId: workflow.id, revision: 1, grant, principalId: 'owner' })
    store.enable(workflow.id, 1)
    expect(
      database.get<{ enabled_revision: number }>(
        'SELECT enabled_revision FROM workflows WHERE id = ?',
        workflow.id,
      )?.enabled_revision,
    ).toBe(1)

    const second = store.createDraft({
      workflowId: workflow.id,
      principalId: 'owner',
      source: 'export default { version: 2 }',
    })
    await store.validate(workflow.id, second)
    store.publish(workflow.id, second)
    store.grant({ workflowId: workflow.id, revision: second, grant, principalId: 'owner' })
    store.enable(workflow.id, second)
    store.rollback(workflow.id, 1)
    expect(
      database.get<{ enabled_revision: number }>(
        'SELECT enabled_revision FROM workflows WHERE id = ?',
        workflow.id,
      )?.enabled_revision,
    ).toBe(1)
    database.close()
  })

  it('enforces credential, enabled revision, operation, target, depth, and rate grants', async () => {
    const { database, store } = setup()
    const workflow = store.create({
      ownerPrincipalId: 'owner',
      slug: 'guarded',
      name: 'Guarded',
      source: 'export default {}',
    })
    await store.validate(workflow.id, 1)
    store.publish(workflow.id, 1)
    const grant = {
      ...defaultWorkflowGrant(),
      discord: {
        ...defaultWorkflowGrant().discord,
        operationIds: ['create_message', 'list_guild_channels'],
        guildIds: ['22345678901234567'],
        channelIds: ['12345678901234567'],
        maxActionsPerMinute: 1,
      },
    }
    store.grant({ workflowId: workflow.id, revision: 1, grant, principalId: 'owner' })
    store.enable(workflow.id, 1)
    const broker = new CapabilityBroker(database)
    broker.register(workflow.id, 1, 'revision-secret')
    expect(() =>
      broker.authorize({
        workflowId: workflow.id,
        revision: 1,
        credential: 'wrong',
        operationId: 'create_message',
        channelId: '12345678901234567',
        causalDepth: 0,
      }),
    ).toThrow(/credential/)
    expect(() =>
      broker.authorize({
        workflowId: workflow.id,
        revision: 2,
        credential: 'revision-secret',
        operationId: 'create_message',
        channelId: '12345678901234567',
        causalDepth: 0,
      }),
    ).toThrow(/credential/)
    expect(() =>
      broker.authorize({
        workflowId: workflow.id,
        revision: 1,
        credential: 'revision-secret',
        operationId: 'list_guild_channels',
        guildId: '32345678901234567',
        causalDepth: 0,
      }),
    ).toThrow(/guild.*not granted/)
    expect(() =>
      broker.authorize({
        workflowId: workflow.id,
        revision: 1,
        credential: 'revision-secret',
        operationId: 'create_message',
        causalDepth: 0,
      }),
    ).toThrow(/target channel/)
    broker.authorize({
      workflowId: workflow.id,
      revision: 1,
      credential: 'revision-secret',
      operationId: 'create_message',
      channelId: '12345678901234567',
      causalDepth: 0,
    })
    expect(() =>
      broker.authorize({
        workflowId: workflow.id,
        revision: 1,
        credential: 'revision-secret',
        operationId: 'create_message',
        channelId: '12345678901234567',
        causalDepth: 0,
      }),
    ).toThrow(/budget/)
    database.run(
      `INSERT INTO workflow_executions
       (id, workflow_id, revision, trigger_type, status, correlation_id, started_at)
       VALUES ('draining-execution', ?, 1, 'manual', 'running', 'draining', ?)`,
      workflow.id,
      new Date().toISOString(),
    )
    database.run(
      `INSERT INTO workflow_executions
       (id, workflow_id, revision, trigger_type, status, correlation_id, started_at)
       VALUES ('queued-execution', ?, 1, 'manual', 'queued', 'queued', ?)`,
      workflow.id,
      new Date().toISOString(),
    )
    store.disable(workflow.id)
    expect(() =>
      broker.authenticate({
        workflowId: workflow.id,
        revision: 1,
        credential: 'revision-secret',
        executionId: 'draining-execution',
        causalDepth: 0,
      }),
    ).not.toThrow()
    expect(() =>
      broker.authenticate({
        workflowId: workflow.id,
        revision: 1,
        credential: 'revision-secret',
        causalDepth: 0,
      }),
    ).toThrow(/not enabled/)
    expect(
      database.get<{ status: string; error_json: string }>(
        "SELECT status, error_json FROM workflow_executions WHERE id = 'queued-execution'",
      ),
    ).toMatchObject({
      status: 'failed',
      error_json: expect.stringContaining('WORKFLOW_DISABLED'),
    })
    database.close()
  })

  it('rejects malformed, unknown, and credential-bearing grants at the store boundary', async () => {
    const { database, store } = setup()
    const workflow = store.create({
      ownerPrincipalId: 'owner',
      slug: 'grant-validation',
      name: 'Grant validation',
      source: 'export default {}',
    })
    await store.validate(workflow.id, 1)
    store.publish(workflow.id, 1)

    expect(() =>
      store.grant({
        workflowId: workflow.id,
        revision: 1,
        grant: {
          ...defaultWorkflowGrant(),
          routes: undefined,
        } as unknown as ReturnType<typeof defaultWorkflowGrant>,
        principalId: 'owner',
      }),
    ).toThrow(/every capability policy/)
    expect(() =>
      store.grant({
        workflowId: workflow.id,
        revision: 1,
        grant: {
          ...defaultWorkflowGrant(),
          discord: {
            ...defaultWorkflowGrant().discord,
            operationIds: ['not_a_discord_operation'],
          },
        },
        principalId: 'owner',
      }),
    ).toThrow(/unknown Discord operation/)
    expect(() =>
      store.grant({
        workflowId: workflow.id,
        revision: 1,
        grant: {
          ...defaultWorkflowGrant(),
          discord: {
            ...defaultWorkflowGrant().discord,
            operationIds: ['partner_sdk_token'],
          },
        },
        principalId: 'owner',
      }),
    ).toThrow(/credential operation/)
    database.close()
  })

  it('allows only one mutable draft and creates the next revision after publication', async () => {
    const { database, store } = setup()
    const workflow = store.create({
      ownerPrincipalId: 'owner',
      slug: 'draft-lifecycle',
      name: 'Draft lifecycle',
      source: 'export default {}',
    })
    expect(() =>
      store.createDraft({
        workflowId: workflow.id,
        principalId: 'owner',
        source: 'export default { version: 2 }',
      }),
    ).toThrow(/already has/)
    await store.validate(workflow.id, 1)
    store.publish(workflow.id, 1)
    expect(
      store.createDraft({
        workflowId: workflow.id,
        principalId: 'owner',
        source: 'export default { version: 2 }',
      }),
    ).toBe(2)
    database.close()
  })

  it('validates trigger metadata and requested grants before publication', () => {
    expect(() =>
      validateCompiledManifest({
        triggers: [
          {
            type: 'http',
            method: 'POST',
            path: '/../escape',
            auth: { type: 'none' },
            index: 0,
          },
        ],
      }),
    ).toThrow(/HTTP path/)
    expect(() =>
      validateCompiledManifest({
        triggers: [
          { type: 'manual', key: 'duplicate', index: 0 },
          { type: 'manual', key: 'duplicate', index: 1 },
        ],
      }),
    ).toThrow(/duplicate/)
    expect(() =>
      validateCompiledManifest({
        triggers: [{ type: 'manual', key: 'valid', index: 0 }],
        requestedGrants: { runtime: { dockerSocket: true } },
      }),
    ).toThrow(/not supported/)
  })

  it('requires an approved grant to cover source-requested capabilities', async () => {
    const database = new Database(':memory:')
    database.migrate()
    database.run(
      'INSERT INTO principals(id, name, kind, created_at) VALUES (?, ?, ?, ?)',
      'owner',
      'Owner',
      'local',
      new Date().toISOString(),
    )
    const store = new WorkflowStore(database, {
      build: async () => ({
        artifactDigest: 'artifact',
        lockfile: 'lockfileVersion: 9',
        manifest: {
          triggers: [{ type: 'manual', key: 'run', index: 0 }],
          requestedGrants: {
            discord: {
              operationIds: ['create_message'],
              channelIds: ['12345678901234567'],
            },
          },
        },
        diagnostics: [],
      }),
    })
    const workflow = store.create({
      ownerPrincipalId: 'owner',
      slug: 'requested-grants',
      name: 'Requested grants',
      source: 'export default {}',
    })
    await store.validate(workflow.id, 1)
    store.publish(workflow.id, 1)
    expect(() =>
      store.grant({
        workflowId: workflow.id,
        revision: 1,
        grant: defaultWorkflowGrant(),
        principalId: 'owner',
      }),
    ).toThrow(/does not cover/)
    const grant = defaultWorkflowGrant()
    store.grant({
      workflowId: workflow.id,
      revision: 1,
      grant: {
        ...grant,
        discord: {
          ...grant.discord,
          operationIds: ['create_message'],
          channelIds: ['12345678901234567'],
        },
      },
      principalId: 'owner',
    })
    database.close()
  })
})
