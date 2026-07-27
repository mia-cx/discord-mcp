import { randomBytes } from 'node:crypto'
import { Database } from '@discord-mcp/persistence'
import { describe, expect, it } from 'vitest'
import { TokenEncryption } from './encryption.js'
import { PersonalAccessTokens } from './pat.js'
import { requireScopes } from './principal.js'
import { resolveForwardedClientAddress, TrustedProxyAuthentication } from './proxy.js'

const database = (): Database => {
  const value = new Database(':memory:')
  value.migrate()
  value.run(
    'INSERT INTO principals(id, name, kind, created_at) VALUES (?, ?, ?, ?)',
    'operator',
    'Operator',
    'local',
    new Date().toISOString(),
  )
  value.run(
    'INSERT INTO principal_scope_bindings(principal_id, scope) VALUES (?, ?)',
    'operator',
    'mcp:read',
  )
  return value
}

describe('control-plane authentication', () => {
  it('encrypts tokens with context-bound AES-256-GCM', () => {
    const encryption = new TokenEncryption(randomBytes(32).toString('base64'))
    const encrypted = encryption.encrypt('secret-token', 'profile:one')
    expect(encryption.decrypt(encrypted, 'profile:one')).toBe('secret-token')
    expect(() => encryption.decrypt(encrypted, 'profile:two')).toThrow(/authenticated/)
    expect(encrypted.toString()).not.toContain('secret-token')
  })

  it('creates one-time-display Argon2id PATs with scopes, expiry, and revocation', async () => {
    const db = database()
    const pats = new PersonalAccessTokens(db)
    const created = await pats.create({ principalId: 'operator', name: 'test', expiresInDays: 1 })
    expect(created.token).toMatch(/^dcmcp_/)
    const principal = await pats.authenticate(created.token)
    expect(requireScopes(principal, ['mcp:read']).id).toBe('operator')
    pats.revoke(created.metadata.id)
    await expect(pats.authenticate(created.token)).rejects.toThrow(/invalid, expired, or revoked/)
    db.close()
  })

  it('accepts proxy identity only from configured CIDRs', () => {
    const db = database()
    db.run(
      'INSERT INTO proxy_identities(identity, principal_id) VALUES (?, ?)',
      'mia@example.test',
      'operator',
    )
    const proxy = new TrustedProxyAuthentication(db, ['10.0.0.0/8'])
    expect(
      proxy.authenticate({
        peerAddress: '10.1.2.3',
        headers: {
          'x-forwarded-user': 'mia@example.test',
          'x-forwarded-groups': 'discord-operators',
        },
      }).id,
    ).toBe('operator')
    expect(() =>
      proxy.authenticate({
        peerAddress: '192.0.2.10',
        headers: {
          'x-forwarded-user': 'mia@example.test',
          'x-forwarded-groups': 'discord-operators',
        },
      }),
    ).toThrow(/untrusted/)
    db.close()
  })

  it('resolves forwarded client addresses only through a fully trusted proxy suffix', () => {
    expect(resolveForwardedClientAddress('10.0.0.2', '192.0.2.10, 10.0.0.1', ['10.0.0.0/8'])).toBe(
      '192.0.2.10',
    )
    expect(resolveForwardedClientAddress('192.0.2.20', '198.51.100.1', ['10.0.0.0/8'])).toBe(
      '192.0.2.20',
    )
    expect(() => resolveForwardedClientAddress('10.0.0.2', 'not-an-ip', ['10.0.0.0/8'])).toThrow()
  })
})
