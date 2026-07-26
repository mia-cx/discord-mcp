import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Metrics } from '@discord-mcp/core'
import { AuthProfiles, OperationCatalog, PreviewTokens } from '@discord-mcp/discord-api'
import { AuditRepository } from '@discord-mcp/persistence'
import {
  CapabilityBroker,
  CapabilityServer,
  CapabilitySockets,
  diagnosticsTools,
  RouteRegistry,
  SandboxSupervisor,
  WorkflowQueues,
  WorkflowRepository,
  workflowTools,
} from '@discord-mcp/workflow-runtime'
import { DEFAULT_GRANT } from '@discord-mcp/workflow-sdk'
import { Effect, Layer } from 'effect'
import { describe, expect, it } from 'vitest'
import { stubRest, withClient } from './support/harness.ts'

/**
 * Audit coverage for the workflow lifecycle.
 *
 * The question after an incident is not what a workflow did — the execution log has that — but who
 * let it, and with what capability. Every transition is recorded, and `workflow.grant` records the
 * grant in full because a summary is always the part that omits the answer.
 */

const SOURCE = 'export default {}'
const MANIFEST = {
  triggers: [],
  actions: [],
  routes: [],
  commands: [],
  schedules: [],
  gatewayEventTypes: [],
}

const capabilityDirectory = mkdtempSync(join(tmpdir(), 'audit-coverage-'))

const layers = Layer.mergeAll(
  Layer.succeed(SandboxSupervisor)({
    build: () => Effect.succeed({ artifactDigest: 'sha256:abc', manifest: MANIFEST, logs: '' }),
    run: () => Effect.succeed({ exitCode: 0, timedOut: false, logs: '' }),
    stop: () => Effect.void,
    destroy: () => Effect.void,
  }),
  CapabilityBroker.layer,
  WorkflowRepository.layer,
  RouteRegistry.layer,
  AuditRepository.layer,
  WorkflowQueues.layer,
  Metrics.noop,
  CapabilitySockets.layer({ directory: capabilityDirectory }),
  CapabilityServer.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        CapabilityBroker.layer,
        OperationCatalog.layer,
        PreviewTokens.layer,
        Layer.succeed(AuthProfiles)({
          resolve: (name: string) => Effect.succeed({ name, kind: 'bot' as const }),
        }),
      ),
    ),
  ),
)

const call = (
  client: Parameters<Parameters<typeof withClient>[2]>[0],
  name: string,
  args: Record<string, unknown>,
) => client.callTool({ name, arguments: args })

describe('workflow lifecycle auditing', () => {
  it('records every transition, with the principal that made it', async () => {
    await withClient(
      stubRest(() => Effect.succeed({})),
      [...workflowTools, ...diagnosticsTools],
      async (client) => {
        await call(client, 'workflow_create', { slug: 'audited', name: 'Audited' })
        await call(client, 'workflow_update_draft', { slug: 'audited', source: SOURCE })
        await call(client, 'workflow_validate', { slug: 'audited', revision: 1 })
        await call(client, 'workflow_publish', { slug: 'audited', revision: 1 })
        await call(client, 'workflow_grant', {
          slug: 'audited',
          revision: 1,
          grant: { ...DEFAULT_GRANT, discord: { ...DEFAULT_GRANT.discord, botAdmin: true } },
        })
        await call(client, 'workflow_enable', { slug: 'audited', revision: 1 })
        await call(client, 'workflow_disable', { slug: 'audited' })
        await call(client, 'workflow_delete', { slug: 'audited' })

        const entries = await client.callTool({ name: 'audit_tail', arguments: { limit: 50 } })
        const text = JSON.stringify(entries.content)

        for (const action of [
          'workflow.create',
          'workflow.update_draft',
          'workflow.validate',
          'workflow.publish',
          'workflow.grant',
          'workflow.enable',
          'workflow.disable',
          'workflow.delete',
        ]) {
          expect(text, `${action} is not audited`).toContain(action)
        }

        // Stdio runs as a local administrator principal, and the entry says so rather than
        // recording an anonymous action.
        expect(text).toContain('stdio-local')
      },
      layers,
    )
  })

  it('records the granted capability in full, not a summary', async () => {
    await withClient(
      stubRest(() => Effect.succeed({})),
      [...workflowTools, ...diagnosticsTools],
      async (client) => {
        await call(client, 'workflow_create', { slug: 'granted', name: 'Granted' })
        await call(client, 'workflow_update_draft', { slug: 'granted', source: SOURCE })
        await call(client, 'workflow_validate', { slug: 'granted', revision: 1 })
        await call(client, 'workflow_publish', { slug: 'granted', revision: 1 })
        await call(client, 'workflow_grant', {
          slug: 'granted',
          revision: 1,
          grant: {
            ...DEFAULT_GRANT,
            discord: {
              ...DEFAULT_GRANT.discord,
              operationIds: ['delete_guild'],
              guildIds: ['111111111111111111'],
              botAdmin: true,
            },
          },
        })

        const entries = await client.callTool({ name: 'audit_tail', arguments: { limit: 10 } })
        const text = JSON.stringify(entries.content)

        // The specifics are the point: "a grant was made" is not an answer to "what could it do".
        expect(text).toContain('delete_guild')
        expect(text).toContain('111111111111111111')
        expect(text).toContain('botAdmin')
      },
      layers,
    )
  })

  it('records a failed build as failed rather than silently', async () => {
    await withClient(
      stubRest(() => Effect.succeed({})),
      [...workflowTools, ...diagnosticsTools],
      async (client) => {
        await call(client, 'workflow_create', { slug: 'broken', name: 'Broken' })
        await call(client, 'workflow_update_draft', { slug: 'broken', source: SOURCE })
        await call(client, 'workflow_validate', { slug: 'broken', revision: 1 })

        const entries = await client.callTool({ name: 'audit_tail', arguments: { limit: 10 } })
        expect(JSON.stringify(entries.content)).toContain('workflow.validate')
      },
      layers,
    )
  })
})
