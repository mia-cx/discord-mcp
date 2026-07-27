import { describe, expect, it } from 'vitest'
import { Database } from './database.js'
import { migrations } from './migrations.js'

describe('SQLite persistence', () => {
  it('applies the complete initial schema idempotently with foreign keys enabled', () => {
    const database = new Database(':memory:')
    database.migrate()
    database.migrate()
    expect(
      database.get<{ count: number }>('SELECT COUNT(*) AS count FROM schema_migrations')?.count,
    ).toBe(migrations.length)
    const tables = database
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .map(({ name }) => name)
    expect(tables).toEqual(
      expect.arrayContaining([
        'principals',
        'message_templates',
        'server_blueprints',
        'gateway_events',
        'workflows',
        'preview_tokens',
        'audit_log',
      ]),
    )
    expect(database.get<{ foreign_keys: number }>('PRAGMA foreign_keys')?.foreign_keys).toBe(1)
    database.close()
  })

  it('rolls back failed transactions', () => {
    const database = new Database(':memory:')
    database.migrate()
    expect(() =>
      database.transaction(() => {
        database.run(
          'INSERT INTO principals(id, name, kind, created_at) VALUES (?, ?, ?, ?)',
          'one',
          'One',
          'local',
          new Date().toISOString(),
        )
        throw new Error('stop')
      }),
    ).toThrow('stop')
    expect(database.get('SELECT * FROM principals WHERE id = ?', 'one')).toBeUndefined()
    database.close()
  })
})
