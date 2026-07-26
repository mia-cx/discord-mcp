import { defineResource } from '@discord-mcp/core'
import { AuditRepository } from '@discord-mcp/persistence'
import { Effect } from 'effect'
import { WorkflowRepository } from './repository.ts'

/**
 * Workflow and audit detail as resources.
 *
 * A workflow's source, its manifest, and its grant are each large enough that returning all three
 * from `workflow_get` on every call would crowd out whatever the model was actually doing.
 */

export const workflowResource = defineResource<WorkflowRepository>({
  name: 'workflow',
  title: 'A workflow',
  description: 'One workflow, its enabled revision, and whether it has been deleted.',
  uri: 'discord://workflows/{slug}',
  mimeType: 'application/json',
  variables: ['slug'],
  read: (variables) =>
    Effect.gen(function* () {
      const repository = yield* WorkflowRepository
      const workflow = yield* repository.get(variables.slug ?? '')

      if (workflow === undefined) {
        return yield* Effect.fail(new Error(`No workflow named "${variables.slug}".`))
      }
      return workflow
    }),
  list: () =>
    Effect.flatMap(WorkflowRepository, (repository) =>
      Effect.map(repository.list(), (workflows) =>
        workflows.map((workflow) => ({
          uri: `discord://workflows/${workflow.slug}`,
          name: workflow.slug,
        })),
      ),
    ),
})

export const workflowRevisionResource = defineResource<WorkflowRepository>({
  name: 'workflow-revision',
  title: 'A workflow revision',
  description:
    'One revision in full: its source, dependency set, compiled manifest, artifact digest, build status, and grant. This is what to read before granting.',
  uri: 'discord://workflows/{slug}/revisions/{revision}',
  mimeType: 'application/json',
  variables: ['slug', 'revision'],
  read: (variables) =>
    Effect.gen(function* () {
      const repository = yield* WorkflowRepository
      const workflow = yield* repository.get(variables.slug ?? '')

      if (workflow === undefined) {
        return yield* Effect.fail(new Error(`No workflow named "${variables.slug}".`))
      }

      const revision = Number(variables.revision)
      const record = yield* repository.getRevision(workflow.id, revision)
      const grant = yield* repository.getGrant(workflow.id, revision)

      if (record === undefined) {
        return yield* Effect.fail(
          new Error(`Revision ${variables.revision} of "${variables.slug}" does not exist.`),
        )
      }

      // Null rather than omitted: an ungranted revision is a distinct state from a revision
      // granted nothing, and the difference decides whether it can be enabled at all.
      return { ...record, grant: grant ?? null }
    }),
})

export const workflowExecutionResource = defineResource<WorkflowRepository>({
  name: 'workflow-execution',
  title: 'A workflow execution',
  description:
    'One execution in full, including its logs and error. Executions are retained for seven days.',
  uri: 'discord://workflows/executions/{executionId}',
  mimeType: 'application/json',
  variables: ['executionId'],
  read: (variables) =>
    Effect.gen(function* () {
      const repository = yield* WorkflowRepository
      const execution = yield* repository.execution(variables.executionId ?? '')

      if (execution === undefined) {
        return yield* Effect.fail(
          new Error(`No execution with ID "${variables.executionId}". Executions are kept 7 days.`),
        )
      }
      return execution
    }),
})

export const auditResource = defineResource<AuditRepository>({
  name: 'audit-log',
  title: 'The audit log',
  description:
    'Recent audited actions with their principal, subject, and outcome. Retained for 90 days.',
  uri: 'discord://audit',
  mimeType: 'application/json',
  read: () => Effect.flatMap(AuditRepository, (repository) => repository.list({ limit: 100 })),
})

export const workflowResources = [
  workflowResource,
  workflowRevisionResource,
  workflowExecutionResource,
  auditResource,
]
