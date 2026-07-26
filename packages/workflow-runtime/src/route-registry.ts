import { randomUUID } from 'node:crypto'
import type { PersistenceError } from '@discord-mcp/core'
import { Database } from '@discord-mcp/persistence'
import type { RouteAuth } from '@discord-mcp/workflow-sdk'
import { Context, Effect, Layer } from 'effect'
import { mountPath } from './routes.ts'

/**
 * Registered workflow routes.
 *
 * Registration happens when a revision is enabled and is removed when it is disabled, so the set of
 * live routes is always the set the enabled revisions declare — there is no way for a route to
 * outlive the code behind it.
 */

export interface RegisteredRoute {
  readonly id: string
  readonly workflowId: string
  readonly workflowSlug: string
  readonly revision: number
  readonly method: string
  /** The full mounted path, beneath `/workflows/{slug}/`. */
  readonly path: string
  readonly auth: RouteAuth
  readonly triggerIndex: number
}

export interface RouteDeclaration {
  readonly method: string
  readonly relativePath: string
  readonly auth: RouteAuth
  readonly triggerIndex: number
}

export class RouteRegistry extends Context.Service<
  RouteRegistry,
  {
    /**
     * Replace a workflow's routes with the ones a revision declares.
     *
     * All or nothing: a half-registered workflow serves some of its routes and 404s the rest,
     * which is worse than serving none.
     */
    readonly register: (input: {
      readonly workflowId: string
      readonly workflowSlug: string
      readonly revision: number
      readonly routes: ReadonlyArray<RouteDeclaration>
    }) => Effect.Effect<ReadonlyArray<RegisteredRoute>, PersistenceError | RouteConflict>
    readonly unregister: (workflowId: string) => Effect.Effect<void, PersistenceError>
    readonly resolve: (input: {
      readonly method: string
      readonly path: string
    }) => Effect.Effect<RegisteredRoute | undefined, PersistenceError>
    readonly list: () => Effect.Effect<ReadonlyArray<RegisteredRoute>, PersistenceError>
    /** Record a replay ID, returning false when it was already seen inside the window. */
    readonly claimReplayId: (input: {
      readonly routeId: string
      readonly replayId: string
      readonly now: number
    }) => Effect.Effect<boolean, PersistenceError>
  }
>()('workflow-runtime/RouteRegistry') {
  static readonly layer = Layer.effect(RouteRegistry)(
    Effect.gen(function* () {
      const db = yield* Database

      const rowToRoute = (row: RouteRow): RegisteredRoute => ({
        id: row.id,
        workflowId: row.workflow_id,
        workflowSlug: row.workflow_slug,
        revision: row.revision,
        method: row.method,
        path: row.path,
        auth: JSON.parse(row.auth_json) as RouteAuth,
        triggerIndex: row.trigger_index,
      })

      return {
        register: (input) =>
          Effect.gen(function* () {
            const mounted: Array<{ declaration: RouteDeclaration; path: string }> = []

            // Every path is validated before anything is written, so a bad one cannot leave half a
            // registration behind.
            for (const declaration of input.routes) {
              const result = mountPath(input.workflowSlug, declaration.relativePath)
              if ('reason' in result) {
                return yield* Effect.fail(new RouteConflict({ reason: result.reason }))
              }
              mounted.push({ declaration, path: result.path })
            }

            const seen = new Set<string>()
            for (const entry of mounted) {
              const key = `${entry.declaration.method} ${entry.path}`
              if (seen.has(key)) {
                return yield* Effect.fail(
                  new RouteConflict({
                    reason: `This revision declares "${key}" twice. Two handlers on one route means the second is unreachable.`,
                  }),
                )
              }
              seen.add(key)
            }

            return yield* db.transaction(
              Effect.gen(function* () {
                const at = yield* Effect.clockWith((clock) => clock.currentTimeMillis)

                // Replacing rather than merging: a route the new revision does not declare must
                // stop being served.
                yield* db.execute('DELETE FROM workflow_routes WHERE workflow_id = ?', [
                  input.workflowId,
                ])

                const registered: RegisteredRoute[] = []
                for (const entry of mounted) {
                  const id = randomUUID()
                  yield* db.execute(
                    `INSERT INTO workflow_routes
                       (id, workflow_id, workflow_slug, revision, method, path, auth_json, trigger_index, created_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                      id,
                      input.workflowId,
                      input.workflowSlug,
                      input.revision,
                      entry.declaration.method.toUpperCase(),
                      entry.path,
                      JSON.stringify(entry.declaration.auth),
                      entry.declaration.triggerIndex,
                      at,
                    ],
                  )
                  registered.push({
                    id,
                    workflowId: input.workflowId,
                    workflowSlug: input.workflowSlug,
                    revision: input.revision,
                    method: entry.declaration.method.toUpperCase(),
                    path: entry.path,
                    auth: entry.declaration.auth,
                    triggerIndex: entry.declaration.triggerIndex,
                  })
                }

                return registered
              }),
            )
          }),

        unregister: (workflowId) =>
          db.execute('DELETE FROM workflow_routes WHERE workflow_id = ?', [workflowId]),

        resolve: (input) =>
          Effect.map(
            db.query<RouteRow>('SELECT * FROM workflow_routes WHERE method = ? AND path = ?', [
              input.method.toUpperCase(),
              input.path,
            ]),
            (rows) => {
              const row = rows[0]
              return row === undefined ? undefined : rowToRoute(row)
            },
          ),

        list: () =>
          Effect.map(db.query<RouteRow>('SELECT * FROM workflow_routes ORDER BY path'), (rows) =>
            rows.map(rowToRoute),
          ),

        claimReplayId: (input) =>
          Effect.map(
            // The primary key does the work: a second insert of the same ID conflicts, so the check
            // and the record are one atomic step rather than a read followed by a write.
            Effect.result(
              db.execute(
                'INSERT INTO webhook_replay_protection (replay_id, route_id, seen_at) VALUES (?, ?, ?)',
                [`${input.routeId}:${input.replayId}`, input.routeId, input.now],
              ),
            ),
            (result) => result._tag === 'Success',
          ),
      }
    }),
  )
}

interface RouteRow {
  readonly id: string
  readonly workflow_id: string
  readonly workflow_slug: string
  readonly revision: number
  readonly method: string
  readonly path: string
  readonly auth_json: string
  readonly trigger_index: number
}

export class RouteConflict extends Error {
  readonly reason: string

  constructor(input: { readonly reason: string }) {
    super(input.reason)
    this.name = 'RouteConflict'
    this.reason = input.reason
  }
}
