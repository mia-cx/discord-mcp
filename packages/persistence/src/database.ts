import { PersistenceError } from '@discord-mcp/core'
import { SqliteClient } from '@effect/sql-sqlite-node'
import { Context, Effect, Layer } from 'effect'
import { SqlClient } from 'effect/unstable/sql'
import { MIGRATIONS } from './migrations.ts'

/**
 * The database, wrapped behind our own service.
 *
 * `effect/unstable/*` may break in minor releases even after v4 GA, so no unstable type crosses a
 * service boundary. Callers see `Database`; only this module sees `SqlClient`.
 */

export interface DatabaseConfig {
  readonly path: string
}

/** A row as SQLite returns it: column names to primitives. */
export type Row = Record<string, string | number | bigint | Uint8Array | null>

export class Database extends Context.Service<
  Database,
  {
    /** Parameterised query. Values are bound, never interpolated. */
    readonly query: <T extends object = Row>(
      sql: string,
      params?: ReadonlyArray<unknown>,
    ) => Effect.Effect<ReadonlyArray<T>, PersistenceError>
    readonly execute: (
      sql: string,
      params?: ReadonlyArray<unknown>,
    ) => Effect.Effect<void, PersistenceError>
    /** Runs `self` in a transaction, rolling back on any failure. */
    readonly transaction: <A, E, R>(
      self: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | PersistenceError, R>
  }
>()('persistence/Database') {
  static readonly layer = (config: DatabaseConfig) =>
    Layer.effect(Database)(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient

        const fail = (operation: string) => (cause: unknown) =>
          new PersistenceError({
            operation,
            message: cause instanceof Error ? cause.message : String(cause),
          })

        const query = <T extends object>(text: string, params: ReadonlyArray<unknown> = []) =>
          Effect.mapError(
            sql.unsafe<T>(text, params as ReadonlyArray<never>),
            fail(text.slice(0, 60)),
          ) as Effect.Effect<ReadonlyArray<T>, PersistenceError>

        const execute = (text: string, params: ReadonlyArray<unknown> = []) =>
          Effect.asVoid(query(text, params))

        // Foreign keys are off by default in SQLite, which would silently let the bindings and
        // journal tables orphan themselves. WAL and a busy timeout keep concurrent readers from
        // tripping over the cleanup schedule.
        yield* execute('PRAGMA foreign_keys = ON')
        yield* execute('PRAGMA busy_timeout = 5000')

        yield* migrate({ query, execute })

        return {
          query,
          execute,
          transaction: <A, E, R>(self: Effect.Effect<A, E, R>) =>
            Effect.mapError(sql.withTransaction(self), (cause) =>
              typeof cause === 'object' &&
              cause !== null &&
              '_tag' in cause &&
              cause._tag === 'SqlError'
                ? new PersistenceError({ operation: 'transaction', message: String(cause) })
                : (cause as E),
            ) as Effect.Effect<A, E | PersistenceError, R>,
        }
      }),
    ).pipe(Layer.provide(SqliteClient.layer({ filename: config.path })))
}

interface MigrationRunner {
  readonly query: <T extends object>(
    sql: string,
    params?: ReadonlyArray<unknown>,
  ) => Effect.Effect<ReadonlyArray<T>, PersistenceError>
  readonly execute: (
    sql: string,
    params?: ReadonlyArray<unknown>,
  ) => Effect.Effect<void, PersistenceError>
}

/**
 * Apply pending migrations in order.
 *
 * Each migration's statements run inside one transaction with its `schema_migrations` row, so a
 * half-applied migration cannot be recorded as done — which would leave the schema permanently
 * wrong in a way no later migration could detect.
 */
export const migrate = (
  runner: MigrationRunner,
): Effect.Effect<ReadonlyArray<number>, PersistenceError> =>
  Effect.gen(function* () {
    yield* runner.execute(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      )`,
    )

    const applied = yield* runner.query<{ id: number }>('SELECT id FROM schema_migrations')
    const appliedIds = new Set(applied.map((r) => r.id))
    const ran: number[] = []

    for (const migration of MIGRATIONS) {
      if (appliedIds.has(migration.id)) continue

      yield* runner.execute('BEGIN')
      const result = yield* Effect.result(
        Effect.gen(function* () {
          for (const statement of migration.statements) yield* runner.execute(statement)
          yield* runner.execute(
            'INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)',
            [migration.id, migration.name, Date.now()],
          )
        }),
      )

      if (result._tag === 'Failure') {
        yield* Effect.ignore(runner.execute('ROLLBACK'))
        return yield* Effect.fail(
          new PersistenceError({
            operation: `migration ${migration.id} (${migration.name})`,
            message: `${result.failure.message}. The database is unchanged; fix the migration and restart.`,
          }),
        )
      }

      yield* runner.execute('COMMIT')
      ran.push(migration.id)
    }

    return ran
  })
