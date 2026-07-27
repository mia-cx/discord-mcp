import { AuthenticationError } from '@discord-mcp/auth'
import { Database } from '@discord-mcp/persistence'
import { describe, expect, it } from 'vitest'
import { ensureAuthenticatedPrincipal } from './http.js'

describe('HTTP authenticated principal persistence', () => {
  it('materializes an OIDC subject before audited requests', () => {
    const database = new Database(':memory:')
    database.migrate()
    ensureAuthenticatedPrincipal(database, {
      id: 'oidc:subject-123',
      name: 'OIDC operator',
      kind: 'oidc',
      scopes: new Set(['mcp:read']),
      expiresAt: Date.now() + 60_000,
    })
    expect(
      database.get('SELECT id, name, kind FROM principals WHERE id = ?', 'oidc:subject-123'),
    ).toEqual({
      id: 'oidc:subject-123',
      name: 'OIDC operator',
      kind: 'oidc',
    })
    database.close()
  })

  it('rejects a disabled OIDC subject and unprovisioned non-OIDC identities', () => {
    const database = new Database(':memory:')
    database.migrate()
    database.run(
      `INSERT INTO principals(id, name, kind, disabled_at, created_at)
       VALUES ('oidc:disabled', 'Disabled', 'oidc', ?, ?)`,
      new Date().toISOString(),
      new Date().toISOString(),
    )
    expect(() =>
      ensureAuthenticatedPrincipal(database, {
        id: 'oidc:disabled',
        name: 'Disabled',
        kind: 'oidc',
        scopes: new Set(['mcp:read']),
      }),
    ).toThrow(AuthenticationError)
    expect(() =>
      ensureAuthenticatedPrincipal(database, {
        id: 'missing-proxy',
        name: 'Missing proxy',
        kind: 'proxy',
        scopes: new Set(['mcp:read']),
      }),
    ).toThrow(/not provisioned/)
    database.close()
  })
})
