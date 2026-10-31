import { randomUUID } from 'node:crypto'
import { countIfAvailable, defineTool, McpRequestContext, ValidationError } from '@discord-mcp/core'
import { AuditRepository } from '@discord-mcp/persistence'
import {
  type CompiledManifest,
  DEFAULT_GRANT,
  WORKFLOW_LIMITS,
  type WorkflowGrant,
} from '@discord-mcp/workflow-sdk'
import { Effect, Schema } from 'effect'
import { CapabilityBroker } from './broker.ts'
import type { CapabilityServer } from './capability-server.ts'
import { CapabilitySockets } from './capability-socket.ts'
import { WorkflowRepository } from './repository.ts'
import { RouteConflict, RouteRegistry } from './route-registry.ts'
import { SandboxSupervisor } from './sandbox.ts'
import { checkScheduleFloor, parseCron } from './schedule.ts'

/**
 * Workflow lifecycle tools.
 *
 * The lifecycle is deliberately five steps, not one: draft, validate, publish, grant, enable.
 * Creating and drafting grant nothing at all; validation proves the code builds; publishing pins an
 * artifact; granting decides capability and needs `workflow:admin`; enabling turns it on. Collapsing
 * any two would mean approving what a workflow *may do* by approving what it *is*.
 */

type Deps =
  | WorkflowRepository
  | SandboxSupervisor
  | CapabilityBroker
  | CapabilitySockets
  | CapabilityServer
  | RouteRegistry
  | AuditRepository

/**
 * Record a lifecycle transition.
 *
 * Every step from draft to deletion is audited, because the interesting question after an incident
 * is not what a workflow did but who let it. Auditing is best-effort: a failed write must not undo
 * a transition that already happened, which would leave the log and the database disagreeing about
 * a thing that did occur.
 */
const audit = (entry: {
  readonly action: string
  readonly slug: string
  readonly outcome: 'allowed' | 'denied' | 'failed'
  readonly detail?: unknown
}) =>
  Effect.gen(function* () {
    const repository = yield* AuditRepository
    const request = yield* Effect.serviceOption(McpRequestContext)

    yield* Effect.ignore(
      repository.record({
        action: entry.action,
        subjectKind: 'workflow',
        subjectId: entry.slug,
        outcome: entry.outcome,
        ...(request._tag === 'Some' ? { principalId: request.value.principal.id } : {}),
        ...(entry.detail === undefined ? {} : { detail: entry.detail }),
      }),
    )
  })

const Slug = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,63}$/)),
).annotate({
  description: 'Lowercase, digits, and hyphens. Used in the workflow’s public route namespace.',
})

const requireWorkflow = (slug: string) =>
  Effect.gen(function* () {
    const repo = yield* WorkflowRepository
    const workflow = yield* repo.get(slug)
    if (workflow === undefined || workflow.deletedAt !== null) {
      return yield* Effect.fail(
        new ValidationError({
          message: `No workflow named "${slug}".`,
          issues: ['slug: call workflow_list to see what exists.'],
        }),
      )
    }
    return workflow
  })

// ---------------------------------------------------------------- read

export const workflowList = defineTool<Record<string, never>, unknown, WorkflowRepository>({
  name: 'workflow_list',
  title: 'List workflows',
  description: 'Every workflow, its enabled revision, and whether it is currently running.',
  toolset: 'automation',
  gate: 'workflows',
  risk: 'read',
  scopes: ['workflow:read'],
  annotations: { readOnlyHint: true, openWorldHint: false },
  input: Schema.Struct({}),
  handler: () => Effect.flatMap(WorkflowRepository, (repo) => repo.list()),
})

const GetInput = Schema.Struct({
  slug: Slug,
  revision: Schema.optionalKey(Schema.Int).annotate({
    description: 'Defaults to the enabled revision, or the latest draft if none is enabled.',
  }),
})

export const workflowGet = defineTool<typeof GetInput.Type, unknown, WorkflowRepository>({
  name: 'workflow_get',
  title: 'Get a workflow',
  description: [
    'A workflow, one of its revisions, that revision’s compiled manifest, and its grant.',
    '',
    'Read this before granting: the manifest states which triggers, routes, and commands the code',
    'declares, and the grant is what it is actually permitted to reach.',
  ].join('\n'),
  toolset: 'automation',
  gate: 'workflows',
  risk: 'read',
  scopes: ['workflow:read'],
  annotations: { readOnlyHint: true, openWorldHint: false },
  input: GetInput,
  handler: (args) =>
    Effect.gen(function* () {
      const repo = yield* WorkflowRepository
      const workflow = yield* requireWorkflow(args.slug)
      const revision = args.revision ?? workflow.enabledRevision ?? 1
      const record = yield* repo.getRevision(workflow.id, revision)
      const grant = yield* repo.getGrant(workflow.id, revision)

      return {
        workflow,
        revision: record,
        // Undefined means never granted, which is not the same as granted-nothing: an ungranted
        // revision cannot be enabled at all.
        grant: grant ?? null,
      }
    }),
})

// ---------------------------------------------------------------- authoring

const CreateInput = Schema.Struct({
  slug: Slug,
  name: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(100))),
})

export const workflowCreate = defineTool<typeof CreateInput.Type, unknown, Deps>({
  name: 'workflow_create',
  title: 'Create a workflow',
  description:
    'Create an empty workflow. This grants nothing and runs nothing; call workflow_update_draft next.',
  toolset: 'automation',
  gate: 'workflows',
  risk: 'write',
  scopes: ['workflow:write'],
  annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  input: CreateInput,
  handler: (args) =>
    Effect.gen(function* () {
      const repo = yield* WorkflowRepository
      const { principal } = yield* McpRequestContext
      const created = yield* repo.create({
        slug: args.slug,
        name: args.name,
        createdBy: principal.id,
      })
      yield* audit({ action: 'workflow.create', slug: args.slug, outcome: 'allowed' })
      return created
    }),
})

const DraftInput = Schema.Struct({
  slug: Slug,
  source: Schema.String.pipe(
    Schema.check(Schema.isMaxLength(WORKFLOW_LIMITS.sourceBytes)),
  ).annotate({
    description:
      'A TypeScript module default-exporting Workflow.make({...}) from @discord-mcp/workflow-sdk.',
  }),
  dependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)).annotate({
    description:
      'npm version ranges, resolved from the configured registry. Git, file, and link specifiers are refused.',
  }),
  requestedGrants: Schema.optionalKey(Schema.Unknown).annotate({
    description:
      'What the author believes the workflow needs. Advisory only — workflow_grant is what decides.',
  }),
})

export const workflowUpdateDraft = defineTool<typeof DraftInput.Type, unknown, Deps>({
  name: 'workflow_update_draft',
  title: 'Save a workflow draft',
  description: [
    'Save source as a new draft revision. Drafts are inert: nothing is built, granted, or run.',
    '',
    'Call workflow_validate next to build it in a sandbox and see its compiled manifest.',
  ].join('\n'),
  toolset: 'automation',
  gate: 'workflows',
  risk: 'write',
  scopes: ['workflow:write'],
  annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false },
  input: DraftInput,
  handler: (args) =>
    Effect.gen(function* () {
      const repo = yield* WorkflowRepository
      const { principal } = yield* McpRequestContext
      const workflow = yield* requireWorkflow(args.slug)

      const draft = yield* repo.saveDraft({
        workflowId: workflow.id,
        source: args.source,
        dependencies: (args.dependencies ?? {}) as Record<string, string>,
        requestedGrants: (args.requestedGrants ?? DEFAULT_GRANT) as WorkflowGrant,
        createdBy: principal.id,
      })
      yield* audit({
        action: 'workflow.update_draft',
        slug: args.slug,
        outcome: 'allowed',
        detail: { revision: draft.revision, sourceDigest: draft.sourceDigest },
      })
      return draft
    }),
})

const RevisionInput = Schema.Struct({ slug: Slug, revision: Schema.Int })

export const workflowValidate = defineTool<typeof RevisionInput.Type, unknown, Deps>({
  name: 'workflow_validate',
  title: 'Build and validate a revision',
  description: [
    'Build a draft in the sandbox: install its dependencies, compile it, import it, and emit its',
    'manifest. Nothing reaches Discord — the build container has no credential and no database.',
    '',
    'On failure this returns the compiler and installer diagnostics. Fix the source and save a new',
    'draft; a revision that failed to build cannot be published.',
  ].join('\n'),
  toolset: 'automation',
  gate: 'workflows',
  risk: 'write',
  scopes: ['workflow:write'],
  annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
  input: RevisionInput,
  handler: (args) =>
    Effect.gen(function* () {
      const repo = yield* WorkflowRepository
      const supervisor = yield* SandboxSupervisor
      const workflow = yield* requireWorkflow(args.slug)

      const revision = yield* repo.getRevision(workflow.id, args.revision)
      if (revision === undefined) {
        return yield* Effect.fail(
          new ValidationError({
            message: `Revision ${args.revision} of "${args.slug}" does not exist.`,
            issues: ['revision: call workflow_get to see which revisions exist.'],
          }),
        )
      }

      const outcome = yield* Effect.result(
        supervisor.build({
          workflowId: workflow.id,
          revision: args.revision,
          source: revision.source,
        }),
      )

      if (outcome._tag === 'Failure') {
        const diagnostics = outcome.failure.diagnostics ?? [outcome.failure.message]
        yield* repo.recordBuildFailure({
          workflowId: workflow.id,
          revision: args.revision,
          diagnostics,
        })
        yield* audit({
          action: 'workflow.validate',
          slug: args.slug,
          outcome: 'failed',
          detail: { revision: args.revision, phase: outcome.failure.phase },
        })
        yield* countIfAvailable('sandbox.build.failed')
        return { status: 'failed', diagnostics }
      }

      yield* repo.recordBuild({
        workflowId: workflow.id,
        revision: args.revision,
        artifactDigest: outcome.success.artifactDigest,
        manifest: outcome.success.manifest,
      })
      yield* audit({
        action: 'workflow.validate',
        slug: args.slug,
        outcome: 'allowed',
        detail: { revision: args.revision, artifactDigest: outcome.success.artifactDigest },
      })
      yield* countIfAvailable('sandbox.build.succeeded')

      return {
        status: 'validated',
        artifactDigest: outcome.success.artifactDigest,
        manifest: outcome.success.manifest,
      }
    }),
})

export const workflowPublish = defineTool<typeof RevisionInput.Type, unknown, Deps>({
  name: 'workflow_publish',
  title: 'Publish a validated revision',
  description: [
    'Mark a validated revision publishable. This still grants nothing and enables nothing.',
    '',
    'Only a revision that built successfully can be published, because publishing pins an artifact',
    'digest — there is nothing to pin for a revision that never produced one.',
  ].join('\n'),
  toolset: 'automation',
  gate: 'workflows',
  risk: 'write',
  scopes: ['workflow:write'],
  annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  input: RevisionInput,
  handler: (args) =>
    Effect.gen(function* () {
      const repo = yield* WorkflowRepository
      const workflow = yield* requireWorkflow(args.slug)
      const revision = yield* repo.getRevision(workflow.id, args.revision)

      if (revision === undefined) {
        return yield* Effect.fail(
          new ValidationError({
            message: `Revision ${args.revision} of "${args.slug}" does not exist.`,
            issues: ['revision: create a draft before publishing.'],
          }),
        )
      }

      if (revision.status !== 'validated') {
        return yield* Effect.fail(
          new ValidationError({
            message: `Revision ${args.revision} is ${revision.status}, not validated.`,
            issues: [
              revision.status === 'failed'
                ? 'revision: this revision failed to build. Fix the source, save a new draft, and validate that.'
                : 'revision: call workflow_validate first — publishing pins the artifact digest a build produces.',
            ],
          }),
        )
      }

      yield* repo.publish(workflow.id, args.revision)
      yield* audit({
        action: 'workflow.publish',
        slug: args.slug,
        outcome: 'allowed',
        detail: { revision: args.revision, artifactDigest: revision.artifactDigest },
      })
      return { slug: args.slug, revision: args.revision, status: 'published' }
    }),
})

// ---------------------------------------------------------------- capability

const GrantInput = Schema.Struct({
  slug: Slug,
  revision: Schema.Int,
  grant: Schema.Unknown.annotate({
    description:
      'The full WorkflowGrant. Empty target lists mean no access, not unrestricted access — an omitted guildIds grants no guilds.',
  }),
})

export const workflowGrant = defineTool<typeof GrantInput.Type, unknown, Deps>({
  name: 'workflow_grant',
  title: 'Grant capabilities to a revision',
  description: [
    'Decide what a revision may do: which operations, guilds, channels, OAuth profiles, event types,',
    'outbound hosts, and action budget.',
    '',
    'Grants are per revision, never per workflow, so new code cannot inherit approval given to old',
    'code. Requires workflow:admin. Show the user the manifest from workflow_get and the grant you',
    'are about to apply, together, before calling this.',
  ].join('\n'),
  toolset: 'admin',
  gate: 'workflows',
  risk: 'bot_admin',
  scopes: ['workflow:admin'],
  annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  input: GrantInput,
  handler: (args) =>
    Effect.gen(function* () {
      const repo = yield* WorkflowRepository
      const { principal } = yield* McpRequestContext
      const workflow = yield* requireWorkflow(args.slug)

      const grant = { ...DEFAULT_GRANT, ...(args.grant as Partial<WorkflowGrant>) } as WorkflowGrant

      if (grant.runtime.timeoutSeconds > WORKFLOW_LIMITS.maxTimeoutSeconds) {
        return yield* Effect.fail(
          new ValidationError({
            message: `A handler deadline of ${grant.runtime.timeoutSeconds}s exceeds the ${WORKFLOW_LIMITS.maxTimeoutSeconds}s maximum.`,
            issues: [
              'grant.runtime.timeoutSeconds: lower it, or split the work across executions.',
            ],
          }),
        )
      }

      yield* repo.setGrant({
        workflowId: workflow.id,
        revision: args.revision,
        grant,
        grantedBy: principal.id,
      })
      // The full grant, not a summary: after an incident the question is exactly what this
      // revision was permitted to do, and a summary is the part that always omits the answer.
      yield* audit({
        action: 'workflow.grant',
        slug: args.slug,
        outcome: 'allowed',
        detail: { revision: args.revision, grant },
      })

      return { slug: args.slug, revision: args.revision, grant }
    }),
})

// ---------------------------------------------------------------- lifecycle

/**
 * Register a revision's routes, refusing schedules the floor forbids on the way.
 *
 * Schedules are checked here rather than at build time because the floor is an operator's policy
 * about their own server, not a property of the code — a workflow that was fine yesterday should
 * fail to enable if the policy tightened, not fail to compile.
 */
const registerRoutes = (input: {
  readonly workflowId: string
  readonly slug: string
  readonly revision: number
  readonly manifest: CompiledManifest | null
}) =>
  Effect.gen(function* () {
    const registry = yield* RouteRegistry
    const manifest = input.manifest
    if (manifest === null) return []

    // Defensive `?? []`: the manifest arrives as JSON from the supervisor, so a version skew shows
    // up as a missing field rather than a type error. Treating that as "declares nothing" is safe;
    // crashing the enable is not.
    for (const schedule of manifest.schedules ?? []) {
      const parsed = parseCron(schedule.expression)
      if ('reason' in parsed) {
        return yield* Effect.fail(
          new ValidationError({
            message: `The schedule "${schedule.expression}" is not valid.`,
            issues: [`schedule: ${parsed.reason}`],
          }),
        )
      }

      const tooFrequent = checkScheduleFloor(parsed)
      if (tooFrequent !== undefined) {
        return yield* Effect.fail(
          new ValidationError({
            message: `The schedule "${schedule.expression}" fires too often.`,
            issues: [`schedule: ${tooFrequent.reason}`],
          }),
        )
      }
    }

    const registered = yield* Effect.mapError(
      registry.register({
        workflowId: input.workflowId,
        workflowSlug: input.slug,
        revision: input.revision,
        routes: (manifest.routes ?? []).map((route) => ({
          method: route.method,
          relativePath: route.path,
          auth: route.auth,
          triggerIndex: route.triggerIndex,
        })),
      }),
      (cause) =>
        cause instanceof RouteConflict
          ? new ValidationError({
              message: 'This revision’s routes could not be registered.',
              issues: [`routes: ${cause.reason}`],
            })
          : cause,
    )

    return registered
  })

export const workflowEnable = defineTool<typeof RevisionInput.Type, unknown, Deps>({
  name: 'workflow_enable',
  title: 'Enable a revision',
  description: [
    'Make a published, granted revision the live one. Its triggers, routes, and commands register',
    'together; if any registration fails, none of them stay.',
    '',
    'A revision with no grant cannot be enabled — an ungranted revision is not "granted nothing",',
    'it is unreviewed.',
  ].join('\n'),
  toolset: 'automation',
  gate: 'workflows',
  risk: 'write',
  scopes: ['workflow:write'],
  annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
  input: RevisionInput,
  handler: (args) =>
    Effect.gen(function* () {
      const repo = yield* WorkflowRepository
      const broker = yield* CapabilityBroker
      const workflow = yield* requireWorkflow(args.slug)

      const revision = yield* repo.getRevision(workflow.id, args.revision)
      if (revision === undefined || revision.status !== 'published') {
        return yield* Effect.fail(
          new ValidationError({
            message: `Revision ${args.revision} of "${args.slug}" is not published.`,
            issues: ['revision: call workflow_validate then workflow_publish first.'],
          }),
        )
      }

      const grant = yield* repo.getGrant(workflow.id, args.revision)
      if (grant === undefined) {
        return yield* Effect.fail(
          new ValidationError({
            message: `Revision ${args.revision} of "${args.slug}" has no grant.`,
            issues: [
              'revision: call workflow_grant first. Enabling an ungranted revision would run unreviewed code with no stated capability.',
            ],
          }),
        )
      }

      // Routes register with the revision, and a failure here stops the enable rather than
      // leaving a workflow live with only some of its routes served.
      const routes = yield* registerRoutes({
        workflowId: workflow.id,
        slug: args.slug,
        revision: args.revision,
        manifest: revision.manifest,
      })

      yield* repo.enable(workflow.id, args.revision)
      yield* broker.setEnabled(workflow.id, args.revision, true)

      yield* audit({
        action: 'workflow.enable',
        slug: args.slug,
        outcome: 'allowed',
        detail: {
          revision: args.revision,
          routes: routes.map((route) => `${route.method} ${route.path}`),
        },
      })

      return {
        slug: args.slug,
        revision: args.revision,
        status: 'enabled',
        routes: routes.map((route) => `${route.method} ${route.path}`),
      }
    }),
})

const SlugInput = Schema.Struct({ slug: Slug })

export const workflowDisable = defineTool<typeof SlugInput.Type, unknown, Deps>({
  name: 'workflow_disable',
  title: 'Disable a workflow',
  description: [
    'Stop dispatching to a workflow. Handlers already running are refused further Discord calls and',
    'drain to their deadline; workflow-owned guild commands and routes are removed.',
  ].join('\n'),
  toolset: 'automation',
  gate: 'workflows',
  risk: 'write',
  scopes: ['workflow:write'],
  annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
  input: SlugInput,
  handler: (args) =>
    Effect.gen(function* () {
      const repo = yield* WorkflowRepository
      const broker = yield* CapabilityBroker
      const registry = yield* RouteRegistry
      const workflow = yield* requireWorkflow(args.slug)

      if (workflow.enabledRevision !== null) {
        // Disable in the broker first. Clearing the database row alone would leave an in-flight
        // handler authorized until its deadline.
        yield* broker.setEnabled(workflow.id, workflow.enabledRevision, false)
      }
      // Routes go with the revision: a public URL that outlived the code behind it would answer
      // with a 503 at best and someone else's handler at worst.
      yield* registry.unregister(workflow.id)
      yield* repo.disable(workflow.id)
      yield* audit({
        action: 'workflow.disable',
        slug: args.slug,
        outcome: 'allowed',
        detail: { revision: workflow.enabledRevision },
      })

      return { slug: args.slug, status: 'disabled' }
    }),
})

export const workflowRollback = defineTool<typeof RevisionInput.Type, unknown, Deps>({
  name: 'workflow_rollback',
  title: 'Roll back to an earlier revision',
  description: [
    'Switch to an already-published revision without rebuilding. Its artifact and its grant are',
    'both the ones that revision had — rolling back the code rolls back the capability with it.',
  ].join('\n'),
  toolset: 'automation',
  gate: 'workflows',
  risk: 'write',
  scopes: ['workflow:write'],
  annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
  input: RevisionInput,
  handler: (args) =>
    Effect.gen(function* () {
      const repo = yield* WorkflowRepository
      const broker = yield* CapabilityBroker
      const workflow = yield* requireWorkflow(args.slug)

      const target = yield* repo.getRevision(workflow.id, args.revision)
      if (target === undefined || target.artifactDigest === null) {
        return yield* Effect.fail(
          new ValidationError({
            message: `Revision ${args.revision} has no built artifact to roll back to.`,
            issues: ['revision: only a revision that was validated and published can be restored.'],
          }),
        )
      }

      if (workflow.enabledRevision !== null) {
        yield* broker.setEnabled(workflow.id, workflow.enabledRevision, false)
      }
      yield* repo.enable(workflow.id, args.revision)
      yield* broker.setEnabled(workflow.id, args.revision, true)

      yield* audit({
        action: 'workflow.rollback',
        slug: args.slug,
        outcome: 'allowed',
        detail: {
          from: workflow.enabledRevision,
          to: args.revision,
          artifactDigest: target.artifactDigest,
        },
      })

      return { slug: args.slug, revision: args.revision, artifactDigest: target.artifactDigest }
    }),
})

export const workflowDelete = defineTool<typeof SlugInput.Type, unknown, Deps>({
  name: 'workflow_delete',
  title: 'Delete a workflow',
  description: [
    'Soft-delete a disabled workflow. Its revisions, grants, and execution history stay queryable,',
    'because an audit trail that disappears with the thing it describes is not an audit trail.',
    '',
    'Disable it first — deleting a running workflow would leave handlers in flight with nothing',
    'left to attribute them to.',
  ].join('\n'),
  toolset: 'automation',
  gate: 'workflows',
  risk: 'destructive',
  scopes: ['workflow:admin'],
  annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
  input: SlugInput,
  handler: (args) =>
    Effect.gen(function* () {
      const repo = yield* WorkflowRepository
      const supervisor = yield* SandboxSupervisor
      const workflow = yield* requireWorkflow(args.slug)

      if (workflow.enabledRevision !== null) {
        return yield* Effect.fail(
          new ValidationError({
            message: `"${args.slug}" is still enabled at revision ${workflow.enabledRevision}.`,
            issues: ['slug: call workflow_disable first.'],
          }),
        )
      }

      yield* repo.softDelete(workflow.id)
      // Best effort: a leftover artifact volume wastes disk but cannot run, and a cleanup failure
      // must not leave the workflow half-deleted.
      yield* Effect.ignore(supervisor.destroy({ workflowId: workflow.id, revision: 0 }))

      yield* audit({ action: 'workflow.delete', slug: args.slug, outcome: 'allowed' })

      return { slug: args.slug, status: 'deleted' }
    }),
})

const InvokeInput = Schema.Struct({
  slug: Slug,
  payload: Schema.optionalKey(Schema.Unknown).annotate({
    description: 'Decoded against the workflow’s manual trigger schema before the handler runs.',
  }),
})

export const workflowInvoke = defineTool<typeof InvokeInput.Type, unknown, Deps>({
  name: 'workflow_invoke',
  title: 'Invoke a workflow manually',
  description: [
    'Run the enabled revision once, now, with a payload you supply.',
    '',
    'The handler runs under the same grant, deadline, and action budget as any other trigger — a',
    'manual run is not a privileged one.',
  ].join('\n'),
  toolset: 'automation',
  gate: 'workflows',
  risk: 'write',
  scopes: ['workflow:write'],
  annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
  input: InvokeInput,
  handler: (args) =>
    Effect.gen(function* () {
      const repo = yield* WorkflowRepository
      const broker = yield* CapabilityBroker
      const supervisor = yield* SandboxSupervisor
      const workflow = yield* requireWorkflow(args.slug)

      if (workflow.enabledRevision === null) {
        return yield* Effect.fail(
          new ValidationError({
            message: `"${args.slug}" has no enabled revision.`,
            issues: ['slug: call workflow_enable first.'],
          }),
        )
      }

      const revision = workflow.enabledRevision
      const grant = yield* repo.getGrant(workflow.id, revision)
      if (grant === undefined) {
        return yield* Effect.fail(
          new ValidationError({
            message: `Revision ${revision} of "${args.slug}" has no grant.`,
            issues: ['slug: call workflow_grant, then workflow_enable.'],
          }),
        )
      }

      const executionId = yield* repo.recordExecution({
        workflowId: workflow.id,
        revision,
        triggerKind: 'manual',
        // A fresh correlation ID: a manual run starts its own causal chain rather than joining one.
        correlationId: randomUUID(),
        causalDepth: 0,
      })

      const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
      const credential = yield* broker.issue({
        workflowId: workflow.id,
        revision,
        executionId,
        grant,
        causalDepth: 0,
        now,
      })

      // The socket must exist before the container does, or the runner connects to nothing. It is
      // closed and removed whatever the outcome — a socket outliving its execution would be a way
      // back in for a container that somehow survived.
      const sockets = yield* CapabilitySockets
      const socket = yield* sockets.open(credential, { index: 0, input: args.payload ?? null })

      const outcome = yield* Effect.result(
        Effect.ensuring(
          supervisor.run({
            workflowId: workflow.id,
            revision,
            executionId,
            capabilityCredential: credential.token,
            payload: args.payload ?? null,
            timeoutSeconds: grant.runtime.timeoutSeconds,
          }),
          Effect.andThen(socket.close(), broker.revoke(credential.token)),
        ),
      )

      if (outcome._tag === 'Failure') {
        yield* repo.finishExecution({
          executionId,
          status: 'failed',
          error: outcome.failure.message,
        })
        return yield* Effect.fail(outcome.failure)
      }

      const status = outcome.success.timedOut
        ? 'timeout'
        : outcome.success.exitCode === 0
          ? 'succeeded'
          : 'failed'

      // The container's own output plus what the workflow logged through the broker: stdout alone
      // would miss everything the SDK's Log service recorded.
      const logs = `${socket.logs()}${outcome.success.logs}`
      yield* repo.finishExecution({ executionId, status, logs })
      yield* countIfAvailable(
        status === 'succeeded'
          ? 'workflow.execution.succeeded'
          : status === 'timeout'
            ? 'workflow.execution.timeout'
            : 'workflow.execution.failed',
      )
      return { executionId, status, logs }
    }),
})

// ---------------------------------------------------------------- observation

const TailInput = Schema.Struct({
  workflowSlug: Schema.optionalKey(Slug),
  limit: Schema.optionalKey(
    Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 200 }))),
  ).annotate({ description: 'Defaults to 50.' }),
  since: Schema.optionalKey(Schema.Int).annotate({
    description: 'Epoch milliseconds. Executions queued at or after this time.',
  }),
})

export const workflowExecutionsTail = defineTool<
  typeof TailInput.Type,
  unknown,
  WorkflowRepository
>({
  name: 'workflow_executions_tail',
  title: 'Tail workflow executions',
  description: [
    'Recent executions with their status, timing, logs, and error. Records persist, so nothing is',
    'lost if the connection drops.',
    '',
    'An event here never starts a new turn on its own — read this when the user asks.',
  ].join('\n'),
  toolset: 'automation',
  gate: 'workflows',
  risk: 'read',
  scopes: ['workflow:read'],
  annotations: { readOnlyHint: true, openWorldHint: false },
  input: TailInput,
  handler: (args) =>
    Effect.gen(function* () {
      const repo = yield* WorkflowRepository
      const workflowId =
        args.workflowSlug === undefined ? undefined : (yield* requireWorkflow(args.workflowSlug)).id

      return yield* repo.executions({
        limit: args.limit ?? 50,
        ...(workflowId === undefined ? {} : { workflowId }),
        ...(args.since === undefined ? {} : { since: args.since }),
      })
    }),
})

const ExecutionInput = Schema.Struct({ executionId: Schema.String })

export const workflowExecutionGet = defineTool<
  typeof ExecutionInput.Type,
  unknown,
  WorkflowRepository
>({
  name: 'workflow_execution_get',
  title: 'Get one workflow execution',
  description:
    'One execution in full: status, timing, correlation and causation IDs, logs, and error.',
  toolset: 'automation',
  gate: 'workflows',
  risk: 'read',
  scopes: ['workflow:read'],
  annotations: { readOnlyHint: true, openWorldHint: false },
  input: ExecutionInput,
  handler: (args) =>
    Effect.gen(function* () {
      const repo = yield* WorkflowRepository
      const execution = yield* repo.execution(args.executionId)

      if (execution === undefined) {
        return yield* Effect.fail(
          new ValidationError({
            message: `No execution with ID "${args.executionId}".`,
            issues: [
              'executionId: call workflow_executions_tail to find recent execution IDs. Executions are retained for seven days.',
            ],
          }),
        )
      }

      return execution
    }),
})

export const workflowTools = [
  workflowList,
  workflowGet,
  workflowCreate,
  workflowUpdateDraft,
  workflowValidate,
  workflowPublish,
  workflowGrant,
  workflowEnable,
  workflowDisable,
  workflowRollback,
  workflowDelete,
  workflowInvoke,
  workflowExecutionGet,
  workflowExecutionsTail,
]
