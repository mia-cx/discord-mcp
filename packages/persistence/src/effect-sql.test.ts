import { SqliteClient } from '@effect/sql-sqlite-node'
import { Effect } from 'effect'
import { SqlClient } from 'effect/unstable/sql/SqlClient'
import { expect, it } from 'vitest'

it('runs an Effect v4 SQLite transaction through the pinned SQL cohort', async () => {
  const program = Effect.gen(function* () {
    const sql = yield* SqlClient
    yield* sql`CREATE TABLE phase_zero (id INTEGER PRIMARY KEY, value TEXT NOT NULL)`
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`INSERT INTO phase_zero (id, value) VALUES (1, 'compatible')`
        yield* sql`UPDATE phase_zero SET value = 'committed' WHERE id = 1`
      }),
    )
    return yield* sql<{ readonly value: string }>`SELECT value FROM phase_zero WHERE id = 1`
  }).pipe(Effect.provide(SqliteClient.layer({ filename: ':memory:', disableWAL: true })))

  await expect(Effect.runPromise(program)).resolves.toEqual([{ value: 'committed' }])
})
