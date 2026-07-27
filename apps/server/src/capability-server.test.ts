import { DiscordDispatcher, DiscordRestClient, type RestRequest } from '@discord-mcp/discord-api'
import { Database } from '@discord-mcp/persistence'
import {
  CapabilityBroker,
  defaultWorkflowGrant,
  type WorkflowGrant,
} from '@discord-mcp/workflow-runtime'
import { afterEach, describe, expect, it } from 'vitest'
import { CapabilityRpcServer } from './capability-server.js'

describe('workflow capability RPC', () => {
  const databases: Array<Database> = []
  afterEach(() => {
    for (const database of databases.splice(0)) database.close()
  })

  it('enforces broad-mention grants and transports inline attachments', async () => {
    const database = new Database(':memory:')
    database.migrate()
    databases.push(database)
    const workflowId = '12345678-1234-1234-1234-123456789abc'
    const channelId = '12345678901234567'
    const grant: WorkflowGrant = {
      ...defaultWorkflowGrant(),
      discord: {
        ...defaultWorkflowGrant().discord,
        operationIds: ['create_message'],
        channelIds: [channelId],
      },
    }
    database.run(
      `INSERT INTO workflows
       (id, owner_principal_id, slug, name, enabled_revision, created_at, updated_at)
       VALUES (?, 'local-administrator', 'fixture', 'Fixture', 1, ?, ?)`,
      workflowId,
      new Date().toISOString(),
      new Date().toISOString(),
    )
    database.run(
      `INSERT INTO workflow_revisions
       (workflow_id, revision, source, dependencies_json, source_digest, artifact_digest,
        requested_grants_json, manifest_json, status, diagnostics_json, created_by, created_at)
       VALUES (?, 1, '', '{}', 'digest', 'artifact', '{}', '{"triggers":[]}',
        'published', '[]', 'local-administrator', ?)`,
      workflowId,
      new Date().toISOString(),
    )
    database.run(
      `INSERT INTO workflow_grants(workflow_id, revision, grants_json, granted_by, granted_at)
       VALUES (?, 1, ?, 'local-administrator', ?)`,
      workflowId,
      JSON.stringify(grant),
      new Date().toISOString(),
    )
    const requests: Array<RestRequest> = []
    const dispatcher = new DiscordDispatcher(
      new DiscordRestClient({
        request: async (request) => {
          requests.push(request)
          return { id: '12345678901234568' }
        },
      }),
    )
    const broker = new CapabilityBroker(database)
    broker.register(workflowId, 1, 'revision-credential')
    const rpc = new CapabilityRpcServer(database, broker, dispatcher)
    database.run(
      `INSERT INTO workflow_executions
       (id, workflow_id, revision, trigger_type, status, correlation_id, started_at)
       VALUES ('capability-test', ?, 1, 'manual', 'running', 'capability-test', ?)`,
      workflowId,
      new Date().toISOString(),
    )
    const presentation = {
      type: 'legacy',
      content: '@everyone report',
      allowedMentions: { parse: ['everyone'] },
      attachments: [
        {
          source: 'inline',
          filename: 'report.txt',
          mimeType: 'text/plain',
          data: Buffer.from('safe attachment').toString('base64'),
        },
      ],
    } as const
    const request = {
      id: 1,
      credential: 'revision-credential',
      workflowId,
      revision: 1,
      executionId: 'capability-test',
      method: 'discord.sendMessage',
      params: { channelId, presentation },
    }
    await expect(
      rpc.handle({
        ...request,
        method: 'discord.request',
        params: {
          operationId: 'create_message',
          input: {
            path: { channel_id: channelId },
            body: {
              content: '@everyone report',
              allowed_mentions: { parse: ['everyone'] },
            },
          },
        },
      }),
    ).rejects.toThrow(/mentions:broad|workflow grant/)
    await expect(
      rpc.handle({
        ...request,
        method: 'discord.request',
        params: {
          operationId: 'create_message',
          input: {
            path: { channel_id: channelId },
            body: { content: '@everyone is inert without allowed mentions' },
          },
        },
      }),
    ).resolves.toMatchObject({ id: '12345678901234568' })
    expect(requests[0]?.body).toMatchObject({
      allowed_mentions: { parse: [], replied_user: false },
    })
    await expect(rpc.handle(request)).rejects.toThrow(/broadMentions/)
    database.run(
      'UPDATE workflow_grants SET grants_json = ? WHERE workflow_id = ? AND revision = 1',
      JSON.stringify({
        ...grant,
        discord: { ...grant.discord, broadMentions: true },
      }),
      workflowId,
    )
    await expect(rpc.handle(request)).resolves.toMatchObject({ id: '12345678901234568' })
    expect(requests).toHaveLength(2)
    expect(requests[1]?.files?.[0]).toMatchObject({
      name: 'report.txt',
      contentType: 'text/plain',
    })
    expect(
      Buffer.from(requests[1]?.files?.[0]?.data as Uint8Array<ArrayBufferLike>).toString(),
    ).toBe('safe attachment')
    expect(
      database.get<{
        execution_id: string
        correlation_id: string
        causal_depth: number
      }>(
        `SELECT execution_id, correlation_id, causal_depth
         FROM workflow_action_causality WHERE discord_entity_id = '12345678901234568'`,
      ),
    ).toEqual({
      execution_id: 'capability-test',
      correlation_id: 'capability-test',
      causal_depth: 1,
    })

    await rpc.handle({
      ...request,
      method: 'log.info',
      params: {
        message: `${'🙂'.repeat(40_000)} Bot ${'a'.repeat(40)}`,
        fields: {
          authorization: `Bearer ${'b'.repeat(40)}`,
          nested: { credential: 'revision-credential' },
        },
      },
    })
    const logs = database.get<{ logs: string }>(
      "SELECT logs FROM workflow_executions WHERE id = 'capability-test'",
    )?.logs
    expect(Buffer.byteLength(logs ?? '')).toBeLessThanOrEqual(64 * 1024)
    expect(logs).not.toContain('revision-credential')
    expect(logs).not.toContain('Bearer')

    database.run(
      `INSERT INTO workflow_executions
       (id, workflow_id, revision, trigger_type, status, correlation_id, causal_depth, started_at)
       VALUES ('deep-execution', ?, 1, 'gateway', 'running', 'deep-execution', 6, ?)`,
      workflowId,
      new Date().toISOString(),
    )
    await expect(
      rpc.handle({
        ...request,
        executionId: 'deep-execution',
        method: 'discord.request',
        params: {
          operationId: 'create_message',
          input: {
            path: { channel_id: channelId },
            body: { content: 'attempted depth reset' },
            causalDepth: 0,
          },
        },
      }),
    ).rejects.toThrow(/causal workflow depth/)
  })
})
