import { createHash, randomUUID } from 'node:crypto'
import type { PersistenceError } from '@discord-mcp/core'
import { Database } from '@discord-mcp/persistence'
import { type CompiledManifest, DEFAULT_GRANT, type WorkflowGrant } from '@discord-mcp/workflow-sdk'
import { Context, Effect, Layer } from 'effect'

/**
 * Workflow, revision, grant, and execution storage.
 *
 * The lifecycle is draft → validate → publish → grant → enable, and each step is separate on
 * purpose: publishing proves the code builds, granting decides what it may do, and enabling turns
 * it on. Collapsing any two would mean approving capability by approving source.
 */

export type RevisionStatus = 'draft' | 'building' | 'validated' | 'published' | 'failed'
export type ExecutionStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'timeout' | 'killed'

export interface WorkflowRecord {
  readonly id: string
  readonly slug: string
  readonly name: string
  readonly enabledRevision: number | null
  readonly deletedAt: number | null
}

export interface RevisionRecord {
  readonly workflowId: string
  readonly revision: number
  readonly source: string
  readonly sourceDigest: string
  readonly artifactDigest: string | null
  readonly status: RevisionStatus
  readonly manifest: CompiledManifest | null
  readonly diagnostics: ReadonlyArray<string>
}

export class WorkflowRepository extends Context.Service<
  WorkflowRepository,
  {
    readonly create: (input: {
      readonly slug: string
      readonly name: string
      readonly createdBy: string
    }) => Effect.Effect<WorkflowRecord, PersistenceError>
    readonly get: (slug: string) => Effect.Effect<WorkflowRecord | undefined, PersistenceError>
    readonly list: () => Effect.Effect<ReadonlyArray<WorkflowRecord>, PersistenceError>
    readonly saveDraft: (input: {
      readonly workflowId: string
      readonly source: string
      readonly dependencies: Record<string, string>
      readonly requestedGrants: WorkflowGrant
      readonly createdBy: string
    }) => Effect.Effect<RevisionRecord, PersistenceError>
    readonly getRevision: (
      workflowId: string,
      revision: number,
    ) => Effect.Effect<RevisionRecord | undefined, PersistenceError>
    /** Records a successful build. The artifact digest is what publishing later checks against. */
    readonly recordBuild: (input: {
      readonly workflowId: string
      readonly revision: number
      readonly artifactDigest: string
      readonly manifest: CompiledManifest
    }) => Effect.Effect<void, PersistenceError>
    readonly recordBuildFailure: (input: {
      readonly workflowId: string
      readonly revision: number
      readonly diagnostics: ReadonlyArray<string>
    }) => Effect.Effect<void, PersistenceError>
    readonly publish: (
      workflowId: string,
      revision: number,
    ) => Effect.Effect<void, PersistenceError>
    readonly setGrant: (input: {
      readonly workflowId: string
      readonly revision: number
      readonly grant: WorkflowGrant
      readonly grantedBy: string
    }) => Effect.Effect<void, PersistenceError>
    readonly getGrant: (
      workflowId: string,
      revision: number,
    ) => Effect.Effect<WorkflowGrant | undefined, PersistenceError>
    readonly enable: (workflowId: string, revision: number) => Effect.Effect<void, PersistenceError>
    readonly disable: (workflowId: string) => Effect.Effect<void, PersistenceError>
    /**
     * Soft delete. Revisions, grants, and executions stay, because an audit trail that vanishes
     * with the thing it describes is not an audit trail.
     */
    readonly softDelete: (workflowId: string) => Effect.Effect<void, PersistenceError>
    readonly execution: (
      executionId: string,
    ) => Effect.Effect<Record<string, unknown> | undefined, PersistenceError>
    readonly recordExecution: (input: {
      readonly workflowId: string
      readonly revision: number
      readonly triggerKind: string
      readonly correlationId: string
      readonly causationId?: string
      readonly causalDepth: number
    }) => Effect.Effect<string, PersistenceError>
    readonly finishExecution: (input: {
      readonly executionId: string
      readonly status: ExecutionStatus
      readonly logs?: string
      readonly error?: string
    }) => Effect.Effect<void, PersistenceError>
    readonly executions: (input: {
      readonly workflowId?: string
      readonly limit: number
      readonly since?: number
    }) => Effect.Effect<ReadonlyArray<Record<string, unknown>>, PersistenceError>
  }
>()('workflow-runtime/WorkflowRepository') {
  static readonly layer = Layer.effect(WorkflowRepository)(
    Effect.gen(function* () {
      const db = yield* Database
      const now = Effect.clockWith((c) => c.currentTimeMillis)

      const loadWorkflow = (slug: string) =>
        Effect.map(
          db.query<{
            id: string
            slug: string
            name: string
            enabled_revision: number | null
            deleted_at: number | null
          }>('SELECT * FROM workflows WHERE slug = ?', [slug]),
          (rows) => {
            const row = rows[0]
            return row === undefined
              ? undefined
              : ({
                  id: row.id,
                  slug: row.slug,
                  name: row.name,
                  enabledRevision: row.enabled_revision,
                  deletedAt: row.deleted_at,
                } satisfies WorkflowRecord)
          },
        )

      const loadRevision = (workflowId: string, revision: number) =>
        Effect.map(
          db.query<{
            workflow_id: string
            revision: number
            source: string
            source_digest: string
            artifact_digest: string | null
            status: string
            compiled_manifest_json: string | null
            diagnostics_json: string
          }>('SELECT * FROM workflow_revisions WHERE workflow_id = ? AND revision = ?', [
            workflowId,
            revision,
          ]),
          (rows) => {
            const row = rows[0]
            return row === undefined
              ? undefined
              : ({
                  workflowId: row.workflow_id,
                  revision: row.revision,
                  source: row.source,
                  sourceDigest: row.source_digest,
                  artifactDigest: row.artifact_digest,
                  status: row.status as RevisionStatus,
                  manifest:
                    row.compiled_manifest_json === null
                      ? null
                      : (JSON.parse(row.compiled_manifest_json) as CompiledManifest),
                  diagnostics: JSON.parse(row.diagnostics_json) as ReadonlyArray<string>,
                } satisfies RevisionRecord)
          },
        )

      return {
        create: (input) =>
          Effect.gen(function* () {
            const at = yield* now
            const id = randomUUID()
            yield* db.execute(
              `INSERT INTO workflows (id, slug, name, created_by, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT (slug) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`,
              [id, input.slug, input.name, input.createdBy, at, at],
            )
            const created = yield* loadWorkflow(input.slug)
            return (
              created ?? {
                id,
                slug: input.slug,
                name: input.name,
                enabledRevision: null,
                deletedAt: null,
              }
            )
          }),

        get: loadWorkflow,

        list: () =>
          Effect.map(
            db.query<{
              id: string
              slug: string
              name: string
              enabled_revision: number | null
              deleted_at: number | null
            }>('SELECT * FROM workflows WHERE deleted_at IS NULL ORDER BY slug'),
            (rows) =>
              rows.map((r) => ({
                id: r.id,
                slug: r.slug,
                name: r.name,
                enabledRevision: r.enabled_revision,
                deletedAt: r.deleted_at,
              })),
          ),

        saveDraft: (input) =>
          db.transaction(
            Effect.gen(function* () {
              const at = yield* now
              const digest = createHash('sha256').update(input.source).digest('hex')

              const existing = yield* db.query<{ next: number }>(
                'SELECT COALESCE(MAX(revision), 0) + 1 AS next FROM workflow_revisions WHERE workflow_id = ?',
                [input.workflowId],
              )
              const revision = existing[0]?.next ?? 1

              yield* db.execute(
                `INSERT INTO workflow_revisions
                   (workflow_id, revision, source, dependencies_json, source_digest,
                    requested_grants_json, status, created_by, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
                [
                  input.workflowId,
                  revision,
                  input.source,
                  JSON.stringify(input.dependencies),
                  digest,
                  JSON.stringify(input.requestedGrants),
                  input.createdBy,
                  at,
                ],
              )

              return {
                workflowId: input.workflowId,
                revision,
                source: input.source,
                sourceDigest: digest,
                artifactDigest: null,
                status: 'draft' as const,
                manifest: null,
                diagnostics: [],
              }
            }),
          ),

        getRevision: loadRevision,

        recordBuild: (input) =>
          db.execute(
            `UPDATE workflow_revisions
               SET artifact_digest = ?, compiled_manifest_json = ?, status = 'validated', diagnostics_json = '[]'
             WHERE workflow_id = ? AND revision = ?`,
            [
              input.artifactDigest,
              JSON.stringify(input.manifest),
              input.workflowId,
              input.revision,
            ],
          ),

        recordBuildFailure: (input) =>
          db.execute(
            `UPDATE workflow_revisions SET status = 'failed', diagnostics_json = ?
             WHERE workflow_id = ? AND revision = ?`,
            [JSON.stringify(input.diagnostics), input.workflowId, input.revision],
          ),

        publish: (workflowId, revision) =>
          db.execute(
            `UPDATE workflow_revisions SET status = 'published'
             WHERE workflow_id = ? AND revision = ? AND status = 'validated'`,
            [workflowId, revision],
          ),

        setGrant: (input) =>
          Effect.flatMap(now, (at) =>
            db.execute(
              `INSERT INTO workflow_grants (workflow_id, revision, grant_json, granted_by, granted_at)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT (workflow_id, revision)
               DO UPDATE SET grant_json = excluded.grant_json, granted_by = excluded.granted_by, granted_at = excluded.granted_at`,
              [input.workflowId, input.revision, JSON.stringify(input.grant), input.grantedBy, at],
            ),
          ),

        getGrant: (workflowId, revision) =>
          Effect.map(
            db.query<{ grant_json: string }>(
              'SELECT grant_json FROM workflow_grants WHERE workflow_id = ? AND revision = ?',
              [workflowId, revision],
            ),
            (rows) => {
              const row = rows[0]
              // Absent means never granted, which is not the same as DEFAULT_GRANT — an ungranted
              // revision must not run at all, so the caller has to distinguish them.
              return row === undefined ? undefined : (JSON.parse(row.grant_json) as WorkflowGrant)
            },
          ),

        enable: (workflowId, revision) =>
          Effect.flatMap(now, (at) =>
            db.execute('UPDATE workflows SET enabled_revision = ?, updated_at = ? WHERE id = ?', [
              revision,
              at,
              workflowId,
            ]),
          ),

        disable: (workflowId) =>
          Effect.flatMap(now, (at) =>
            db.execute(
              'UPDATE workflows SET enabled_revision = NULL, updated_at = ? WHERE id = ?',
              [at, workflowId],
            ),
          ),

        softDelete: (workflowId) =>
          Effect.flatMap(now, (at) =>
            db.execute(
              'UPDATE workflows SET deleted_at = ?, enabled_revision = NULL, updated_at = ? WHERE id = ?',
              [at, at, workflowId],
            ),
          ),

        execution: (executionId) =>
          Effect.map(
            db.query<Record<string, unknown>>('SELECT * FROM workflow_executions WHERE id = ?', [
              executionId,
            ]),
            (rows) => rows[0],
          ),

        recordExecution: (input) =>
          Effect.gen(function* () {
            const at = yield* now
            const id = randomUUID()
            yield* db.execute(
              `INSERT INTO workflow_executions
                 (id, workflow_id, revision, trigger_kind, status, correlation_id, causation_id, causal_depth, queued_at)
               VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?)`,
              [
                id,
                input.workflowId,
                input.revision,
                input.triggerKind,
                input.correlationId,
                input.causationId ?? null,
                input.causalDepth,
                at,
              ],
            )
            return id
          }),

        finishExecution: (input) =>
          Effect.flatMap(now, (at) =>
            db.execute(
              'UPDATE workflow_executions SET status = ?, finished_at = ?, logs = ?, error = ? WHERE id = ?',
              [input.status, at, input.logs ?? null, input.error ?? null, input.executionId],
            ),
          ),

        executions: (input) =>
          db.query<Record<string, unknown>>(
            `SELECT * FROM workflow_executions
             WHERE (? IS NULL OR workflow_id = ?) AND queued_at >= ?
             ORDER BY queued_at DESC LIMIT ?`,
            [input.workflowId ?? null, input.workflowId ?? null, input.since ?? 0, input.limit],
          ),
      }
    }),
  )
}

export { DEFAULT_GRANT }
