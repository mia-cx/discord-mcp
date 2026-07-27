import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from '@discord-mcp/persistence'
import { afterEach, describe, expect, it } from 'vitest'
import { CapabilityBroker } from './broker.js'
import { invokeRunner, WorkflowExecutionError, WorkflowRuntimeManager } from './manager.js'
import { WorkflowStore } from './store.js'
import type { SupervisorClient } from './supervisor-client.js'
import { defaultWorkflowGrant } from './types.js'

describe('workflow runner RPC limits', () => {
  const servers: Array<Server> = []
  const roots: Array<string> = []

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve())
          }),
      ),
    )
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  const listen = async (onConnection: (connection: Socket) => void): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), 'discord-mcp-runner-rpc-'))
    roots.push(root)
    const socket = join(root, 'runner.sock')
    const server = createServer(onConnection)
    servers.push(server)
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socket, resolve)
    })
    return socket
  }

  it('rejects an oversized runner response before parsing it', async () => {
    const socket = await listen((connection) => {
      connection.once('data', () => connection.write('x'.repeat(2 * 1024 * 1024 + 1)))
    })
    await expect(invokeRunner(socket, { input: true }, 1_000)).rejects.toBeInstanceOf(
      WorkflowExecutionError,
    )
  })

  it('interrupts a runner that does not respond before its deadline', async () => {
    const socket = await listen((connection) => {
      connection.once('data', () => undefined)
    })
    await expect(invokeRunner(socket, { input: true }, 20)).rejects.toMatchObject({
      _tag: 'WorkflowExecutionError',
      timedOut: true,
      retryable: true,
    })
  })

  it('preserves a tagged non-retryable handler failure from the runner', async () => {
    const socket = await listen((connection) => {
      connection.once('data', () =>
        connection.end(
          `${JSON.stringify({
            ok: false,
            error: {
              tag: 'CapabilityDenied',
              message: 'operation is outside the workflow grant',
              retryable: false,
            },
          })}\n`,
        ),
      )
    })
    await expect(invokeRunner(socket, { input: true }, 1_000)).rejects.toMatchObject({
      _tag: 'WorkflowExecutionError',
      failureTag: 'CapabilityDenied',
      message: 'operation is outside the workflow grant',
      retryable: false,
    })
  })

  it('destroys a non-responsive runner and durably records a timed-out execution', async () => {
    const database = new Database(':memory:')
    database.migrate()
    const store = new WorkflowStore(database, {
      build: async () => ({
        artifactDigest: 'artifact',
        lockfile: 'lockfileVersion: 9',
        manifest: { triggers: [{ type: 'manual', key: 'hang', index: 0 }] },
        diagnostics: [],
      }),
    })
    const workflow = store.create({
      ownerPrincipalId: 'local-administrator',
      slug: 'deadline-proof',
      name: 'Deadline proof',
      source: 'export default {}',
    })
    await store.validate(workflow.id, 1)
    store.publish(workflow.id, 1)
    const grant = defaultWorkflowGrant()
    store.grant({
      workflowId: workflow.id,
      revision: 1,
      grant: {
        ...grant,
        runtime: { ...grant.runtime, timeoutSeconds: 1 },
      },
      principalId: 'local-administrator',
    })
    store.enable(workflow.id, 1)
    const runnerRoot = await mkdtemp(join(tmpdir(), 'discord-mcp-deadline-'))
    roots.push(runnerRoot)
    const socketDirectory = join(runnerRoot, workflow.id, '1')
    await mkdir(socketDirectory, { recursive: true })
    const socketPath = join(socketDirectory, 'runner.sock')
    const runner = createServer((connection) => {
      connection.once('data', () => undefined)
    })
    servers.push(runner)
    await new Promise<void>((resolve, reject) => {
      runner.once('error', reject)
      runner.listen(socketPath, resolve)
    })

    const actions: Array<string> = []
    const supervisor = {
      request: async (request: Readonly<Record<string, unknown>>) => {
        actions.push(String(request.action))
        return {}
      },
    } as unknown as SupervisorClient
    const kills: Array<string> = []
    const manager = new WorkflowRuntimeManager(
      database,
      supervisor,
      new CapabilityBroker(database),
      runnerRoot,
      undefined,
      undefined,
      {
        runnerKilled: ({ reason }) => kills.push(reason),
      },
    )
    let executionId = ''
    try {
      await manager.invoke({
        workflowId: workflow.id,
        triggerType: 'manual',
        triggerKey: 'hang',
        input: {},
      })
      throw new Error('hanging execution unexpectedly succeeded')
    } catch (cause) {
      expect(cause).toMatchObject({ _tag: 'WorkflowExecutionError', timedOut: true })
      executionId = (cause as WorkflowExecutionError).executionId ?? ''
    }
    expect(actions).toContain('destroy')
    expect(kills).toContain('timeout')
    expect(
      database.get<{ status: string }>(
        'SELECT status FROM workflow_executions WHERE id = ?',
        executionId,
      )?.status,
    ).toBe('timed_out')
    database.close()
  })

  it('replaces a crashed runner without ambiguously retrying its handler', async () => {
    const database = new Database(':memory:')
    database.migrate()
    const store = new WorkflowStore(database, {
      build: async () => ({
        artifactDigest: 'artifact',
        lockfile: 'lockfileVersion: 9',
        manifest: { triggers: [{ type: 'manual', key: 'crash', index: 0 }] },
        diagnostics: [],
      }),
    })
    const workflow = store.create({
      ownerPrincipalId: 'local-administrator',
      slug: 'crash-proof',
      name: 'Crash proof',
      source: 'export default {}',
    })
    await store.validate(workflow.id, 1)
    store.publish(workflow.id, 1)
    store.grant({
      workflowId: workflow.id,
      revision: 1,
      grant: defaultWorkflowGrant(),
      principalId: 'local-administrator',
    })
    store.enable(workflow.id, 1)

    const runnerRoot = await mkdtemp(join(tmpdir(), 'discord-mcp-crash-'))
    roots.push(runnerRoot)
    const socketDirectory = join(runnerRoot, workflow.id, '1')
    await mkdir(socketDirectory, { recursive: true })
    const socketPath = join(socketDirectory, 'runner.sock')
    let invocations = 0
    const runner = createServer((connection) => {
      connection.once('data', () => {
        invocations += 1
        connection.destroy()
      })
    })
    await new Promise<void>((resolve, reject) => {
      runner.once('error', reject)
      runner.listen(socketPath, resolve)
    })
    servers.push(runner)
    const actions: Array<string> = []
    const manager = new WorkflowRuntimeManager(
      database,
      {
        request: async ({ action }: Readonly<Record<string, unknown>>) => {
          actions.push(String(action))
          return {}
        },
      } as unknown as SupervisorClient,
      new CapabilityBroker(database),
      runnerRoot,
    )
    let executionId = ''
    try {
      await manager.invoke({
        workflowId: workflow.id,
        triggerType: 'manual',
        triggerKey: 'crash',
        input: {},
      })
      throw new Error('crashed execution unexpectedly succeeded')
    } catch (cause) {
      expect(cause).toMatchObject({
        _tag: 'WorkflowExecutionError',
        retryable: false,
        message: expect.stringMatching(/not retried.*ambiguous/),
      })
      executionId = (cause as WorkflowExecutionError).executionId ?? ''
    }
    expect(invocations).toBe(1)
    expect(actions).toContain('destroy')
    expect(
      database.get<{ status: string; error_json: string }>(
        'SELECT status, error_json FROM workflow_executions WHERE id = ?',
        executionId,
      ),
    ).toMatchObject({
      status: 'failed',
      error_json: expect.stringContaining('"retryable":false'),
    })
    database.close()
  })

  it('restarts every enabled workflow runner and registration after control-plane startup', async () => {
    const database = new Database(':memory:')
    database.migrate()
    const store = new WorkflowStore(database, {
      build: async () => ({
        artifactDigest: 'artifact',
        lockfile: 'lockfileVersion: 9',
        manifest: { triggers: [{ type: 'manual', key: 'run', index: 0 }] },
        diagnostics: [],
      }),
    })
    const workflow = store.create({
      ownerPrincipalId: 'local-administrator',
      slug: 'restart-proof',
      name: 'Restart proof',
      source: 'export default {}',
    })
    await store.validate(workflow.id, 1)
    store.publish(workflow.id, 1)
    store.grant({
      workflowId: workflow.id,
      revision: 1,
      grant: defaultWorkflowGrant(),
      principalId: 'local-administrator',
    })
    store.enable(workflow.id, 1)
    database.run(
      `INSERT INTO workflow_executions
       (id, workflow_id, revision, trigger_type, status, correlation_id, started_at)
       VALUES ('orphaned-running', ?, 1, 'manual', 'running', 'orphaned', ?)`,
      workflow.id,
      new Date().toISOString(),
    )
    database.run(
      `INSERT INTO workflow_commands
       (workflow_id, revision, command_key, command_type, discord_command_id, guild_id)
       VALUES (?, 0, 'stale', 1, '12345678901234567', 'global')`,
      workflow.id,
    )

    let running = false
    const actions: Array<string> = []
    const supervisor = {
      request: async (request: Readonly<Record<string, unknown>>) => {
        const action = String(request.action)
        actions.push(action)
        if (action === 'inspect' && !running) throw new Error('container missing')
        if (action === 'start') running = true
        if (action === 'stop' || action === 'destroy') running = false
        return {}
      },
    } as unknown as SupervisorClient
    const lifecycle: Array<string> = []
    const manager = new WorkflowRuntimeManager(
      database,
      supervisor,
      new CapabilityBroker(database),
      '/tmp/unused-runner-root',
      ({ id }) => {
        lifecycle.push(`enabled:${id}`)
      },
      (id, revision) => {
        lifecycle.push(`disabled:${id}:${revision}`)
        database.run(
          'DELETE FROM workflow_commands WHERE workflow_id = ? AND revision = ?',
          id,
          revision,
        )
      },
    )
    await manager.start()
    expect(actions).toContain('start')
    expect(lifecycle.slice(0, 2)).toEqual([`disabled:${workflow.id}:0`, `enabled:${workflow.id}`])
    expect(
      database.get<{ status: string; error_json: string }>(
        "SELECT status, error_json FROM workflow_executions WHERE id = 'orphaned-running'",
      ),
    ).toMatchObject({
      status: 'failed',
      error_json: expect.stringContaining('CONTROL_PLANE_RESTARTED'),
    })
    await manager.close()
    expect(actions).toContain('stop')
    database.close()
  })
})
