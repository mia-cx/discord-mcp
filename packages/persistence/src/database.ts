import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { SqliteClient } from '@effect/sql-sqlite-node'
import { Effect, ManagedRuntime, Schema } from 'effect'
import { SqlClient } from 'effect/unstable/sql/SqlClient'
import { migrations } from './migrations.js'

type SQLInputValue = null | number | bigint | string | Uint8Array

export interface DatabaseRunResult {
  readonly changes: number
  readonly lastInsertRowid: number | bigint
}

const makeSqliteRuntime = (filename: string) =>
  ManagedRuntime.make(
    SqliteClient.layer({
      filename,
      disableWAL: filename === ':memory:',
    }),
  )

type SqliteRuntime = ReturnType<typeof makeSqliteRuntime>

export class PersistenceError extends Schema.TaggedErrorClass<PersistenceError>()(
  'PersistenceError',
  { message: Schema.String, cause: Schema.Defect() },
) {
  constructor(
    message: string,
    readonly cause: unknown,
  ) {
    super({ message, cause })
  }
}

export class Database {
  readonly #runtime: SqliteRuntime
  #closed = false

  constructor(readonly filename: string) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true })
    this.#runtime = makeSqliteRuntime(filename)
    this.#raw('PRAGMA foreign_keys = ON')
    this.#raw('PRAGMA busy_timeout = 5000')
  }

  migrate(): void {
    this.#raw(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )
    `)
    const applied = new Set(
      this.all<{ version: number }>('SELECT version FROM schema_migrations').map(
        ({ version }) => version,
      ),
    )
    for (const migration of migrations) {
      if (applied.has(migration.version)) continue
      this.transaction(() => {
        this.#execScript(migration.sql)
        this.run(
          'INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)',
          migration.version,
          migration.name,
          new Date().toISOString(),
        )
      })
    }
  }

  run(sql: string, ...parameters: ReadonlyArray<SQLInputValue>): DatabaseRunResult {
    try {
      return this.#raw(sql, parameters)
    } catch (cause) {
      if (cause instanceof PersistenceError) throw cause
      throw new PersistenceError(`SQLite statement failed: ${sql.slice(0, 120)}`, cause)
    }
  }

  get<A extends Record<string, unknown>>(
    sql: string,
    ...parameters: ReadonlyArray<SQLInputValue>
  ): A | undefined {
    try {
      return this.#rows<A>(sql, parameters)[0]
    } catch (cause) {
      if (cause instanceof PersistenceError) throw cause
      throw new PersistenceError(`SQLite query failed: ${sql.slice(0, 120)}`, cause)
    }
  }

  all<A extends Record<string, unknown>>(
    sql: string,
    ...parameters: ReadonlyArray<SQLInputValue>
  ): ReadonlyArray<A> {
    try {
      return this.#rows<A>(sql, parameters)
    } catch (cause) {
      if (cause instanceof PersistenceError) throw cause
      throw new PersistenceError(`SQLite query failed: ${sql.slice(0, 120)}`, cause)
    }
  }

  transaction<A>(run: () => A): A {
    this.#raw('BEGIN IMMEDIATE')
    try {
      const value = run()
      this.#raw('COMMIT')
      return value
    } catch (cause) {
      this.#raw('ROLLBACK')
      throw cause
    }
  }

  effect<A>(run: (database: Database) => A): Effect.Effect<A, PersistenceError> {
    return Effect.try({
      try: () => run(this),
      catch: (cause) =>
        cause instanceof PersistenceError
          ? cause
          : new PersistenceError('SQLite operation failed', cause),
    })
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    Effect.runSync(this.#runtime.disposeEffect)
  }

  #raw(sql: string, parameters: ReadonlyArray<SQLInputValue> = []): DatabaseRunResult {
    if (this.#closed) throw new PersistenceError('SQLite database is closed', undefined)
    return this.#runtime.runSync(
      SqlClient.use((client) => client.unsafe(sql, parameters).raw),
    ) as DatabaseRunResult
  }

  #rows<A extends Record<string, unknown>>(
    sql: string,
    parameters: ReadonlyArray<SQLInputValue>,
  ): ReadonlyArray<A> {
    if (this.#closed) throw new PersistenceError('SQLite database is closed', undefined)
    return this.#runtime.runSync(SqlClient.use((client) => client.unsafe<A>(sql, parameters)))
  }

  #execScript(script: string): void {
    for (const statement of script
      .split(';')
      .map((value) => value.trim())
      .filter(Boolean)) {
      this.#raw(statement)
    }
  }
}
