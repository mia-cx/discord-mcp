import { access, mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  SupervisorClient,
  type SupervisorRpcError,
  SupervisorWorkflowBuilder,
} from './supervisor-client.js'

describe('supervisor RPC error protocol', () => {
  const cleanup: Array<() => Promise<void>> = []

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((run) => run()))
  })

  it('preserves tagged remote errors and reports the failed request', async () => {
    const root = await mkdtemp(join(tmpdir(), 'discord-mcp-supervisor-client-'))
    const socketPath = join(root, 'supervisor.sock')
    const server = createServer((socket) => {
      socket.once('data', () => {
        socket.end(
          `${JSON.stringify({
            ok: false,
            error: {
              tag: 'SandboxError',
              message: 'artifact digest rejected',
              retryable: false,
            },
          })}\n`,
        )
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, resolve)
    })
    cleanup.push(
      () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve())
        }),
      () => rm(root, { recursive: true, force: true }),
    )
    const observed: Array<Record<string, unknown>> = []
    const client = new SupervisorClient(socketPath, 's'.repeat(32), {
      requestFinished: (event) => observed.push(event),
    })
    await expect(
      client.request({
        action: 'start',
        workflowId: 'abcdef12-3456-7890',
        revision: 1,
      }),
    ).rejects.toMatchObject({
      _tag: 'SupervisorRpcError',
      remoteTag: 'SandboxError',
      retryable: false,
    } satisfies Partial<SupervisorRpcError>)
    expect(observed).toMatchObject([
      {
        action: 'start',
        workflowId: 'abcdef12-3456-7890',
        revision: 1,
        outcome: 'failure',
        errorTag: 'SandboxError',
      },
    ])
  })

  it('removes partial artifacts after a failed sandbox build', async () => {
    const root = await mkdtemp(join(tmpdir(), 'discord-mcp-failed-artifact-'))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    const builder = new SupervisorWorkflowBuilder(
      {
        request: async () => {
          throw new Error('sandbox build failed')
        },
      } as unknown as SupervisorClient,
      root,
    )

    await expect(
      builder.build({
        workflowId: 'abcdef12-3456-7890',
        revision: 1,
        source: 'export default {}',
        dependencies: {},
        allowNpmInstallScripts: false,
      }),
    ).rejects.toThrow(/sandbox build failed/)
    await expect(access(join(root, 'abcdef12-3456-7890', '1', 'output'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
})
