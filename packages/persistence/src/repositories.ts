import { randomUUID } from 'node:crypto'
import { PersistenceError, type Scope } from '@discord-mcp/core'
import { Context, Effect, Layer } from 'effect'
import { Database } from './database.ts'
import { MAX_EVENTS_PER_WORKFLOW, RETENTION_MS } from './migrations.ts'

/**
 * Repositories. One per aggregate, each owning its own SQL.
 *
 * SQL stays here rather than in tool handlers so a schema change has one blast radius, and so the
 * shape a handler receives is already the domain's shape rather than a row.
 */

const now = Effect.clockWith((c) => c.currentTimeMillis)

// ---------------------------------------------------------------- blueprint bindings

export interface Binding {
  readonly logicalKey: string
  readonly discordId: string
  readonly objectKind: 'role' | 'channel'
}

export class BlueprintRepository extends Context.Service<
  BlueprintRepository,
  {
    /** Logical key → snowflake for one blueprint in one guild. */
    readonly bindings: (
      blueprintId: string,
      guildId: string,
    ) => Effect.Effect<ReadonlyMap<string, string>, PersistenceError>
    readonly bind: (
      blueprintId: string,
      guildId: string,
      binding: Binding,
    ) => Effect.Effect<void, PersistenceError>
    readonly unbind: (
      blueprintId: string,
      guildId: string,
      logicalKey: string,
    ) => Effect.Effect<void, PersistenceError>
    /** Opens an execution journal. Apply is not transactional, so it must be resumable. */
    readonly startExecution: (input: {
      readonly blueprintId: string
      readonly revision: number
      readonly guildId: string
      readonly snapshotDigest: string
      readonly startedBy: string
      readonly actions: ReadonlyArray<{
        readonly kind: string
        readonly logicalKey: string
        readonly summary: string
        readonly payload: unknown
      }>
    }) => Effect.Effect<string, PersistenceError>
    readonly completeAction: (
      executionId: string,
      sequence: number,
      outcome: {
        readonly status: 'completed' | 'failed' | 'skipped'
        readonly discordId?: string
        readonly error?: string
      },
    ) => Effect.Effect<void, PersistenceError>
    readonly finishExecution: (
      executionId: string,
      status: 'completed' | 'failed' | 'partial',
    ) => Effect.Effect<void, PersistenceError>
    /** Actions still pending, so a restart can pick up exactly where it stopped. */
    readonly pendingActions: (executionId: string) => Effect.Effect<
      ReadonlyArray<{
        readonly sequence: number
        readonly kind: string
        readonly logicalKey: string
        readonly payload: unknown
      }>,
      PersistenceError
    >
    readonly resumableExecutions: (guildId: string) => Effect.Effect<
      ReadonlyArray<{
        readonly id: string
        readonly blueprintId: string
        readonly revision: number
      }>,
      PersistenceError
    >
  }
>()('persistence/BlueprintRepository') {
  static readonly layer = Layer.effect(BlueprintRepository)(
    Effect.gen(function* () {
      const db = yield* Database

      return {
        bindings: (blueprintId, guildId) =>
          Effect.map(
            db.query<{ logical_key: string; discord_id: string }>(
              'SELECT logical_key, discord_id FROM server_blueprint_bindings WHERE blueprint_id = ? AND guild_id = ?',
              [blueprintId, guildId],
            ),
            (rows) => new Map(rows.map((r) => [r.logical_key, r.discord_id])),
          ),

        bind: (blueprintId, guildId, binding) =>
          Effect.flatMap(now, (at) =>
            // Upsert: rebinding after a manual delete-and-recreate must not fail.
            db.execute(
              `INSERT INTO server_blueprint_bindings
                 (blueprint_id, guild_id, logical_key, discord_id, object_kind, bound_at)
               VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT (blueprint_id, guild_id, logical_key)
               DO UPDATE SET discord_id = excluded.discord_id, bound_at = excluded.bound_at`,
              [blueprintId, guildId, binding.logicalKey, binding.discordId, binding.objectKind, at],
            ),
          ),

        unbind: (blueprintId, guildId, logicalKey) =>
          db.execute(
            'DELETE FROM server_blueprint_bindings WHERE blueprint_id = ? AND guild_id = ? AND logical_key = ?',
            [blueprintId, guildId, logicalKey],
          ),

        startExecution: (input) =>
          Effect.gen(function* () {
            const id = randomUUID()
            const at = yield* now

            yield* db.execute(
              `INSERT INTO server_blueprint_executions
                 (id, blueprint_id, revision, guild_id, status, snapshot_digest, started_by, started_at)
               VALUES (?, ?, ?, ?, 'running', ?, ?, ?)`,
              [
                id,
                input.blueprintId,
                input.revision,
                input.guildId,
                input.snapshotDigest,
                input.startedBy,
                at,
              ],
            )

            // The whole plan is journalled up front, so a crash mid-apply leaves a record of what
            // was intended as well as what was done.
            for (const [index, action] of input.actions.entries()) {
              yield* db.execute(
                `INSERT INTO server_blueprint_actions
                   (execution_id, sequence, kind, logical_key, summary, payload_json, status)
                 VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
                [
                  id,
                  index,
                  action.kind,
                  action.logicalKey,
                  action.summary,
                  JSON.stringify(action.payload),
                ],
              )
            }
            return id
          }),

        completeAction: (executionId, sequence, outcome) =>
          Effect.flatMap(now, (at) =>
            db.execute(
              `UPDATE server_blueprint_actions
                 SET status = ?, discord_id = ?, error = ?, completed_at = ?
               WHERE execution_id = ? AND sequence = ?`,
              [
                outcome.status,
                outcome.discordId ?? null,
                outcome.error ?? null,
                at,
                executionId,
                sequence,
              ],
            ),
          ),

        finishExecution: (executionId, status) =>
          Effect.flatMap(now, (at) =>
            db.execute(
              'UPDATE server_blueprint_executions SET status = ?, finished_at = ? WHERE id = ?',
              [status, at, executionId],
            ),
          ),

        pendingActions: (executionId) =>
          Effect.map(
            db.query<{ sequence: number; kind: string; logical_key: string; payload_json: string }>(
              `SELECT sequence, kind, logical_key, payload_json FROM server_blueprint_actions
               WHERE execution_id = ? AND status = 'pending' ORDER BY sequence`,
              [executionId],
            ),
            (rows) =>
              rows.map((r) => ({
                sequence: r.sequence,
                kind: r.kind,
                logicalKey: r.logical_key,
                payload: JSON.parse(r.payload_json) as unknown,
              })),
          ),

        resumableExecutions: (guildId) =>
          Effect.map(
            db.query<{ id: string; blueprint_id: string; revision: number }>(
              `SELECT id, blueprint_id, revision FROM server_blueprint_executions
               WHERE guild_id = ? AND status = 'running' ORDER BY started_at`,
              [guildId],
            ),
            (rows) =>
              rows.map((r) => ({ id: r.id, blueprintId: r.blueprint_id, revision: r.revision })),
          ),
      }
    }),
  )
}

// ---------------------------------------------------------------- revisions

export interface RevisionInput {
  readonly id: string
  readonly name: string
  readonly body: unknown
  readonly publishedBy: string
}

/**
 * Draft/publish for templates and blueprints alike. They share this because they share the
 * requirement: a published revision is immutable so an apply cannot silently target edited state.
 */
export class RevisionRepository extends Context.Service<
  RevisionRepository,
  {
    readonly saveDraft: (
      table: 'message_templates' | 'server_blueprints',
      input: { readonly id: string; readonly name: string; readonly draft: unknown },
    ) => Effect.Effect<void, PersistenceError>
    readonly publish: (
      table: 'message_templates' | 'server_blueprints',
      input: RevisionInput,
    ) => Effect.Effect<{ readonly revision: number; readonly digest: string }, PersistenceError>
    readonly getRevision: (
      table: 'message_templates' | 'server_blueprints',
      id: string,
      revision: number,
    ) => Effect.Effect<
      { readonly body: unknown; readonly digest: string } | undefined,
      PersistenceError
    >
    readonly latestRevision: (
      table: 'message_templates' | 'server_blueprints',
      id: string,
    ) => Effect.Effect<number, PersistenceError>
  }
>()('persistence/RevisionRepository') {
  static readonly layer = Layer.effect(RevisionRepository)(
    Effect.gen(function* () {
      const db = yield* Database
      const revisionTable = (table: string) =>
        table === 'message_templates' ? 'message_template_revisions' : 'server_blueprint_revisions'
      const fk = (table: string) => (table === 'message_templates' ? 'template_id' : 'blueprint_id')

      const digestOf = async (body: unknown) => {
        const { createHash } = await import('node:crypto')
        return createHash('sha256').update(JSON.stringify(body)).digest('hex')
      }

      return {
        saveDraft: (table, input) =>
          Effect.flatMap(now, (at) =>
            db.execute(
              `INSERT INTO ${table} (id, name, draft_json, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT (id) DO UPDATE SET name = excluded.name, draft_json = excluded.draft_json, updated_at = excluded.updated_at`,
              [input.id, input.name, JSON.stringify(input.draft), at, at],
            ),
          ),

        publish: (table, input) =>
          db.transaction(
            Effect.gen(function* () {
              const at = yield* now
              const digest = yield* Effect.promise(() => digestOf(input.body))

              const [current] = yield* db.query<{ latest_revision: number }>(
                `SELECT latest_revision FROM ${table} WHERE id = ?`,
                [input.id],
              )
              // Publishing freezes a draft, so the draft has to exist. Without this the foreign
              // key fires instead and the caller gets "FOREIGN KEY constraint failed", which says
              // nothing about what to do.
              if (current === undefined) {
                return yield* Effect.fail(
                  new PersistenceError({
                    operation: `publish ${table}`,
                    message: `No ${table === 'message_templates' ? 'template' : 'blueprint'} with id "${input.id}". Create a draft before publishing.`,
                  }),
                )
              }
              const revision = current.latest_revision + 1

              yield* db.execute(
                `INSERT INTO ${revisionTable(table)} (${fk(table)}, revision, body_json, digest, published_by, published_at)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [input.id, revision, JSON.stringify(input.body), digest, input.publishedBy, at],
              )
              yield* db.execute(
                `UPDATE ${table} SET latest_revision = ?, updated_at = ? WHERE id = ?`,
                [revision, at, input.id],
              )

              return { revision, digest }
            }),
          ),

        getRevision: (table, id, revision) =>
          Effect.map(
            db.query<{ body_json: string; digest: string }>(
              `SELECT body_json, digest FROM ${revisionTable(table)} WHERE ${fk(table)} = ? AND revision = ?`,
              [id, revision],
            ),
            (rows) => {
              const row = rows[0]
              return row === undefined
                ? undefined
                : { body: JSON.parse(row.body_json) as unknown, digest: row.digest }
            },
          ),

        latestRevision: (table, id) =>
          Effect.map(
            db.query<{ latest_revision: number }>(
              `SELECT latest_revision FROM ${table} WHERE id = ?`,
              [id],
            ),
            (rows) => rows[0]?.latest_revision ?? 0,
          ),
      }
    }),
  )
}

// ---------------------------------------------------------------- component bindings

export class ComponentBindingRepository extends Context.Service<
  ComponentBindingRepository,
  {
    /**
     * Mint an opaque handle for a logical action.
     *
     * The handle carries no meaning. Discord round-trips `custom_id` through the client, so
     * anything encoded in it returns as untrusted input; this is a lookup key and nothing else.
     */
    readonly create: (input: {
      readonly kind: 'workflow' | 'inbox'
      readonly actionKey: string
      readonly ownerKind: 'message' | 'template' | 'workflow'
      readonly ownerId: string
      readonly ownerRevision?: number
    }) => Effect.Effect<string, PersistenceError>
    readonly resolve: (handle: string) => Effect.Effect<
      | {
          readonly kind: 'workflow' | 'inbox'
          readonly actionKey: string
          readonly ownerKind: string
          readonly ownerId: string
          readonly ownerRevision: number | null
        }
      | undefined,
      PersistenceError
    >
  }
>()('persistence/ComponentBindingRepository') {
  static readonly layer = Layer.effect(ComponentBindingRepository)(
    Effect.gen(function* () {
      const db = yield* Database

      return {
        create: (input) =>
          Effect.gen(function* () {
            // 32 base64url characters, well inside Discord's 100-character custom_id limit.
            const handle = randomUUID().replaceAll('-', '')
            const at = yield* now
            yield* db.execute(
              `INSERT INTO component_bindings (handle, kind, action_key, owner_kind, owner_id, owner_revision, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
              [
                handle,
                input.kind,
                input.actionKey,
                input.ownerKind,
                input.ownerId,
                input.ownerRevision ?? null,
                at,
              ],
            )
            return handle
          }),

        resolve: (handle) =>
          Effect.map(
            db.query<{
              kind: 'workflow' | 'inbox'
              action_key: string
              owner_kind: string
              owner_id: string
              owner_revision: number | null
            }>(
              'SELECT kind, action_key, owner_kind, owner_id, owner_revision FROM component_bindings WHERE handle = ?',
              [handle],
            ),
            (rows) => {
              const row = rows[0]
              return row === undefined
                ? undefined
                : {
                    kind: row.kind,
                    actionKey: row.action_key,
                    ownerKind: row.owner_kind,
                    ownerId: row.owner_id,
                    ownerRevision: row.owner_revision,
                  }
            },
          ),
      }
    }),
  )
}

// ---------------------------------------------------------------- audit and retention

export class AuditRepository extends Context.Service<
  AuditRepository,
  {
    readonly record: (entry: {
      readonly principalId?: string
      readonly action: string
      readonly subjectKind?: string
      readonly subjectId?: string
      readonly outcome: 'allowed' | 'denied' | 'failed'
      readonly detail?: unknown
      readonly correlationId?: string
    }) => Effect.Effect<void, PersistenceError>
    readonly list: (options: {
      readonly limit: number
      readonly since?: number
    }) => Effect.Effect<ReadonlyArray<Record<string, unknown>>, PersistenceError>
  }
>()('persistence/AuditRepository') {
  static readonly layer = Layer.effect(AuditRepository)(
    Effect.gen(function* () {
      const db = yield* Database
      return {
        record: (entry) =>
          Effect.flatMap(now, (at) =>
            db.execute(
              `INSERT INTO audit_log (id, at, principal_id, action, subject_kind, subject_id, outcome, detail_json, correlation_id)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                randomUUID(),
                at,
                entry.principalId ?? null,
                entry.action,
                entry.subjectKind ?? null,
                entry.subjectId ?? null,
                entry.outcome,
                entry.detail === undefined ? null : JSON.stringify(entry.detail),
                entry.correlationId ?? null,
              ],
            ),
          ),

        list: (options) =>
          db.query<Record<string, unknown>>(
            `SELECT * FROM audit_log WHERE at >= ? ORDER BY at DESC LIMIT ?`,
            [options.since ?? 0, options.limit],
          ),
      }
    }),
  )
}

/**
 * Delete what has aged out.
 *
 * Runs on a schedule rather than on write: doing it inline would put a variable-cost delete in the
 * path of every event a busy guild produces, which is exactly when you least want it.
 */
export const cleanupExpired = (db: Database['Service']) =>
  Effect.gen(function* () {
    const at = yield* now
    const deletions: Array<[string, ReadonlyArray<unknown>]> = [
      ['DELETE FROM workflow_events WHERE received_at < ?', [at - RETENTION_MS.workflowEvents]],
      [
        `DELETE FROM workflow_events WHERE sequence NOT IN (
           SELECT sequence FROM workflow_events w2
           WHERE w2.workflow_id IS workflow_events.workflow_id
           ORDER BY sequence DESC LIMIT ?)`,
        [MAX_EVENTS_PER_WORKFLOW],
      ],
      [
        'DELETE FROM interaction_deduplication WHERE received_at < ?',
        [at - RETENTION_MS.interactionDeduplication],
      ],
      [
        'DELETE FROM webhook_replay_protection WHERE seen_at < ?',
        [at - RETENTION_MS.webhookReplay],
      ],
      ['DELETE FROM audit_log WHERE at < ?', [at - RETENTION_MS.auditLog]],
      ['DELETE FROM preview_tokens WHERE expires_at < ?', [at]],
      ['DELETE FROM oauth_authorization_states WHERE expires_at < ?', [at]],
      [
        'UPDATE workflow_executions SET logs = NULL WHERE finished_at IS NOT NULL AND finished_at < ?',
        [at - RETENTION_MS.executionLogs],
      ],
    ]

    for (const [sql, params] of deletions) yield* db.execute(sql, params)
  })

export const PersistenceLayer = (path: string) =>
  Layer.mergeAll(
    BlueprintRepository.layer,
    RevisionRepository.layer,
    ComponentBindingRepository.layer,
    AuditRepository.layer,
  ).pipe(Layer.provideMerge(Database.layer({ path })))

export type { Scope }
