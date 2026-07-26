import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SandboxError } from '@discord-mcp/core'
import { AuthProfiles, OperationCatalog, PreviewTokens } from '@discord-mcp/discord-api'
import {
  CapabilityBroker,
  CapabilityServer,
  CapabilitySockets,
  SandboxSupervisor,
  WorkflowRepository,
  workflowTools,
} from '@discord-mcp/workflow-runtime'
import { DEFAULT_GRANT } from '@discord-mcp/workflow-sdk'
import { Effect, Layer } from 'effect'
import { describe, expect, it } from 'vitest'
import { stubRest, withClient } from './support/harness.ts'

/**
 * The workflow lifecycle over real MCP.
 *
 * The point of these is the *ordering*: a workflow cannot be enabled before it is granted, granted
 * before it is published, or published before it built. Each step exists to be refused.
 */

const SOURCE = `import { Workflow, Trigger } from '@discord-mcp/workflow-sdk'
export default Workflow.make({ name: 'greeter', triggers: [] })`

const MANIFEST = { name: 'greeter', triggers: [], routes: [], commands: [] }

/** A supervisor that builds successfully without a container in sight. */
const stubSupervisor = (options: { readonly buildFails?: boolean } = {}) =>
  Layer.succeed(SandboxSupervisor)({
    build: () =>
      options.buildFails === true
        ? Effect.fail(
            new SandboxError({
              message: 'The build failed at the "compile" stage.',
              phase: 'build',
              diagnostics: ["src/index.ts(2,1): error TS2304: Cannot find name 'Workflw'."],
            }),
          )
        : Effect.succeed({ artifactDigest: 'sha256:abc', manifest: MANIFEST, logs: '' }),
    run: () => Effect.succeed({ exitCode: 0, timedOut: false, logs: 'ran' }),
    stop: () => Effect.void,
    destroy: () => Effect.void,
  })

/** Real sockets, in a directory that goes away with the test run. */
const capabilityDirectory = mkdtempSync(join(tmpdir(), 'discord-mcp-lifecycle-'))

const stubProfiles = Layer.succeed(AuthProfiles)({
  resolve: (name: string) => Effect.succeed({ name, kind: 'bot' as const }),
})

const layers = (options: { readonly buildFails?: boolean } = {}) =>
  Layer.mergeAll(
    stubSupervisor(options),
    CapabilityBroker.layer,
    WorkflowRepository.layer,
    CapabilitySockets.layer({ directory: capabilityDirectory }),
    CapabilityServer.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          CapabilityBroker.layer,
          OperationCatalog.layer,
          PreviewTokens.layer,
          stubProfiles,
        ),
      ),
    ),
  )

const call = async (
  client: Parameters<Parameters<typeof withClient>[2]>[0],
  name: string,
  args: Record<string, unknown>,
) => (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: unknown }

const text = (result: { content: unknown }) =>
  JSON.stringify((result.content as ReadonlyArray<{ text?: string }>).map((c) => c.text ?? ''))

describe('the workflow lifecycle', () => {
  it('goes draft → validate → publish → grant → enable, and refuses every shortcut', async () => {
    await withClient(
      stubRest(() => Effect.succeed({})),
      workflowTools,
      async (client) => {
        await call(client, 'workflow_create', { slug: 'greeter', name: 'Greeter' })
        const draft = await call(client, 'workflow_update_draft', {
          slug: 'greeter',
          source: SOURCE,
        })
        expect(draft.isError).toBeFalsy()

        // Publishing a revision that never built has nothing to pin.
        const early = await call(client, 'workflow_publish', { slug: 'greeter', revision: 1 })
        expect(early.isError).toBe(true)
        expect(text(early)).toContain('not validated')

        const validated = await call(client, 'workflow_validate', { slug: 'greeter', revision: 1 })
        expect(validated.isError).toBeFalsy()
        expect(text(validated)).toContain('sha256:abc')

        const published = await call(client, 'workflow_publish', { slug: 'greeter', revision: 1 })
        expect(published.isError).toBeFalsy()

        // Published but ungranted. An ungranted revision is unreviewed, not granted-nothing.
        const ungranted = await call(client, 'workflow_enable', { slug: 'greeter', revision: 1 })
        expect(ungranted.isError).toBe(true)
        expect(text(ungranted)).toContain('no grant')

        const granted = await call(client, 'workflow_grant', {
          slug: 'greeter',
          revision: 1,
          grant: DEFAULT_GRANT,
        })
        expect(granted.isError).toBeFalsy()

        const enabled = await call(client, 'workflow_enable', { slug: 'greeter', revision: 1 })
        expect(enabled.isError).toBeFalsy()
        expect(text(enabled)).toContain('enabled')
      },
      layers(),
    )
  })

  it('reports build diagnostics and refuses to publish a failed revision', async () => {
    await withClient(
      stubRest(() => Effect.succeed({})),
      workflowTools,
      async (client) => {
        await call(client, 'workflow_create', { slug: 'broken', name: 'Broken' })
        await call(client, 'workflow_update_draft', { slug: 'broken', source: SOURCE })

        const validated = await call(client, 'workflow_validate', { slug: 'broken', revision: 1 })
        expect(text(validated)).toContain('Cannot find name')

        const published = await call(client, 'workflow_publish', { slug: 'broken', revision: 1 })
        expect(published.isError).toBe(true)
        expect(text(published)).toContain('failed to build')
      },
      layers({ buildFails: true }),
    )
  })

  it('rolls back to a published revision without rebuilding', async () => {
    await withClient(
      stubRest(() => Effect.succeed({})),
      workflowTools,
      async (client) => {
        await call(client, 'workflow_create', { slug: 'rollback', name: 'Rollback' })

        for (const revision of [1, 2]) {
          await call(client, 'workflow_update_draft', { slug: 'rollback', source: SOURCE })
          await call(client, 'workflow_validate', { slug: 'rollback', revision })
          await call(client, 'workflow_publish', { slug: 'rollback', revision })
          await call(client, 'workflow_grant', {
            slug: 'rollback',
            revision,
            grant: DEFAULT_GRANT,
          })
          await call(client, 'workflow_enable', { slug: 'rollback', revision })
        }

        const back = await call(client, 'workflow_rollback', { slug: 'rollback', revision: 1 })
        expect(back.isError).toBeFalsy()
        expect(text(back)).toContain('sha256:abc')

        const state = await call(client, 'workflow_get', { slug: 'rollback' })
        expect(text(state)).toContain('\\"enabledRevision\\": 1')
      },
      layers(),
    )
  })

  it('refuses to delete a workflow that is still enabled', async () => {
    await withClient(
      stubRest(() => Effect.succeed({})),
      workflowTools,
      async (client) => {
        await call(client, 'workflow_create', { slug: 'live', name: 'Live' })
        await call(client, 'workflow_update_draft', { slug: 'live', source: SOURCE })
        await call(client, 'workflow_validate', { slug: 'live', revision: 1 })
        await call(client, 'workflow_publish', { slug: 'live', revision: 1 })
        await call(client, 'workflow_grant', { slug: 'live', revision: 1, grant: DEFAULT_GRANT })
        await call(client, 'workflow_enable', { slug: 'live', revision: 1 })

        const deleted = await call(client, 'workflow_delete', { slug: 'live' })
        expect(deleted.isError).toBe(true)
        expect(text(deleted)).toContain('workflow_disable')

        await call(client, 'workflow_disable', { slug: 'live' })
        expect((await call(client, 'workflow_delete', { slug: 'live' })).isError).toBeFalsy()

        // Soft, so the audit trail survives: it is gone from the list, not gone from the database.
        const listed = await call(client, 'workflow_list', {})
        expect(text(listed)).not.toContain('"slug":"live"')
      },
      layers(),
    )
  })

  it('runs a manual invocation under the enabled revision’s grant', async () => {
    await withClient(
      stubRest(() => Effect.succeed({})),
      workflowTools,
      async (client) => {
        await call(client, 'workflow_create', { slug: 'manual', name: 'Manual' })
        await call(client, 'workflow_update_draft', { slug: 'manual', source: SOURCE })
        await call(client, 'workflow_validate', { slug: 'manual', revision: 1 })
        await call(client, 'workflow_publish', { slug: 'manual', revision: 1 })

        // Not yet enabled: there is no revision to run.
        const early = await call(client, 'workflow_invoke', { slug: 'manual' })
        expect(early.isError).toBe(true)
        expect(text(early)).toContain('no enabled revision')

        await call(client, 'workflow_grant', { slug: 'manual', revision: 1, grant: DEFAULT_GRANT })
        await call(client, 'workflow_enable', { slug: 'manual', revision: 1 })

        const invoked = await call(client, 'workflow_invoke', { slug: 'manual', payload: { a: 1 } })
        expect(invoked.isError).toBeFalsy()
        expect(text(invoked)).toContain('succeeded')

        const executions = await call(client, 'workflow_executions_tail', {
          workflowSlug: 'manual',
        })
        expect(text(executions)).toContain('manual')
      },
      layers(),
    )
  })
})
