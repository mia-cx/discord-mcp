import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Principal, Scope } from '@discord-mcp/core'
import { Database, PersistenceLayer } from '@discord-mcp/persistence'
import { Effect, Layer, ManagedRuntime, Redacted } from 'effect'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { evaluateProxyTrust, isWithinCidr, narrowScopes } from '../src/http-identity.ts'
import { PAT_PREFIX, PrincipalStore } from '../src/principals.ts'
import { decodeMasterKey, SecretStore, seal, unseal } from '../src/secrets.ts'

const KEY = randomBytes(32)

let dir: string
let runtime: ManagedRuntime.ManagedRuntime<PrincipalStore | SecretStore | Database, never>

const run = <A, E>(effect: Effect.Effect<A, E, PrincipalStore | SecretStore | Database>) =>
  runtime.runPromise(effect)

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'discord-mcp-auth-'))
  runtime = ManagedRuntime.make(
    Layer.mergeAll(PrincipalStore.layer, SecretStore.layer(KEY)).pipe(
      Layer.provideMerge(PersistenceLayer(join(dir, 'auth.sqlite'))),
    ),
  )
})

afterEach(async () => {
  await runtime.dispose()
  rmSync(dir, { recursive: true, force: true })
})

describe('encrypted secrets', () => {
  it('round-trips a value', () => {
    const sealed = seal(KEY, 'a-refresh-token')
    expect(unseal(KEY, sealed)).toBe('a-refresh-token')
  })

  it('uses a fresh IV each time, so identical plaintexts differ on disk', () => {
    // Reusing an IV under GCM leaks the keystream. Two seals of the same value must not match.
    const a = seal(KEY, 'same')
    const b = seal(KEY, 'same')
    expect(a.iv.equals(b.iv)).toBe(false)
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false)
  })

  it('refuses a tampered ciphertext rather than returning plausible garbage', () => {
    const sealed = seal(KEY, 'a-refresh-token')
    const tampered = Buffer.from(sealed.ciphertext)
    tampered[0] = (tampered[0] as number) ^ 0xff

    // This is why GCM and not CBC: authentication turns tampering into a clear failure.
    expect(() => unseal(KEY, { ...sealed, ciphertext: tampered })).toThrow()
  })

  it('refuses a different key', () => {
    const sealed = seal(KEY, 'secret')
    expect(() => unseal(randomBytes(32), sealed)).toThrow()
  })

  it('rejects a master key of the wrong length, naming how to make one', async () => {
    const exit = await Effect.runPromiseExit(decodeMasterKey(Redacted.make('dG9vLXNob3J0')))
    expect(exit._tag).toBe('Failure')
    expect(JSON.stringify(exit)).toContain('openssl rand -base64 32')
  })

  it('stores and retrieves through the database', async () => {
    await run(Effect.flatMap(SecretStore, (s) => s.put('deploy-hook', 'hunter2')))
    const value = await run(Effect.flatMap(SecretStore, (s) => s.get('deploy-hook')))
    expect(value === undefined ? undefined : Redacted.value(value)).toBe('hunter2')

    // Redacted, so an accidental interpolation into a log cannot leak it.
    expect(String(value)).not.toContain('hunter2')
  })

  it('explains a master-key mismatch instead of returning nothing', async () => {
    await run(Effect.flatMap(SecretStore, (s) => s.put('k', 'v')))
    await runtime.dispose()

    // Restarted with a different key — the classic "restored SQLite without the key" case.
    const other = ManagedRuntime.make(
      SecretStore.layer(randomBytes(32)).pipe(
        Layer.provideMerge(PersistenceLayer(join(dir, 'auth.sqlite'))),
      ),
    )
    const exit = await other.runPromiseExit(Effect.flatMap(SecretStore, (s) => s.get('k')))
    expect(exit._tag).toBe('Failure')
    expect(JSON.stringify(exit)).toContain('does not match')
    await other.dispose()

    runtime = ManagedRuntime.make(
      Layer.mergeAll(PrincipalStore.layer, SecretStore.layer(KEY)).pipe(
        Layer.provideMerge(PersistenceLayer(join(dir, 'auth.sqlite'))),
      ),
    )
  })
})

describe('personal access tokens', () => {
  const seed = () =>
    run(
      Effect.flatMap(PrincipalStore, (s) =>
        s.create({
          id: 'ci',
          kind: 'pat',
          displayName: 'CI',
          scopes: ['mcp:read', 'mcp:write'] as ReadonlyArray<Scope>,
        }),
      ),
    )

  it('issues a prefixed token and authenticates it', async () => {
    await seed()
    const created = await run(
      Effect.flatMap(PrincipalStore, (s) => s.issueToken({ principalId: 'ci', name: 'deploy' })),
    )

    expect(created.token.startsWith(PAT_PREFIX)).toBe(true)
    // 256 bits of entropy, base64url.
    expect(created.token.length).toBeGreaterThan(40)

    const principal = await run(
      Effect.flatMap(PrincipalStore, (s) => s.authenticateToken(created.token)),
    )
    expect(principal.id).toBe('ci')
    expect([...principal.scopes].sort()).toEqual(['mcp:read', 'mcp:write'])
  })

  it('stores only a hash, so a database read is not a credential compromise', async () => {
    await seed()
    const created = await run(
      Effect.flatMap(PrincipalStore, (s) => s.issueToken({ principalId: 'ci', name: 'deploy' })),
    )

    const rows = await run(
      Effect.flatMap(Database, (db) =>
        db.query<{ token_hash: string }>('SELECT token_hash FROM personal_access_tokens'),
      ),
    )
    expect(rows[0]?.token_hash).not.toContain(created.token)
    expect(rows[0]?.token_hash.startsWith('$argon2id$')).toBe(true)
  })

  it('rejects a revoked token', async () => {
    await seed()
    const created = await run(
      Effect.flatMap(PrincipalStore, (s) => s.issueToken({ principalId: 'ci', name: 'deploy' })),
    )
    await run(Effect.flatMap(PrincipalStore, (s) => s.revokeToken(created.id)))

    const exit = await runtime.runPromiseExit(
      Effect.flatMap(PrincipalStore, (s) => s.authenticateToken(created.token)),
    )
    expect(exit._tag).toBe('Failure')
  })

  it('rejects an expired token, and says so distinctly from an unknown one', async () => {
    await seed()
    const created = await run(
      Effect.flatMap(PrincipalStore, (s) =>
        s.issueToken({ principalId: 'ci', name: 'deploy', expiryDays: 1 }),
      ),
    )
    await run(
      Effect.flatMap(Database, (db) =>
        db.execute('UPDATE personal_access_tokens SET expires_at = ? WHERE id = ?', [
          1,
          created.id,
        ]),
      ),
    )

    const exit = await runtime.runPromiseExit(
      Effect.flatMap(PrincipalStore, (s) => s.authenticateToken(created.token)),
    )
    expect(JSON.stringify(exit)).toContain('expired')
  })

  it('gives the same answer for unknown and never-existed, so guessing reveals nothing', async () => {
    await seed()
    const a = await runtime.runPromiseExit(
      Effect.flatMap(PrincipalStore, (s) =>
        s.authenticateToken(`${PAT_PREFIX}aaaaaaaaaaaaaaaaaaaa`),
      ),
    )
    const b = await runtime.runPromiseExit(
      Effect.flatMap(PrincipalStore, (s) =>
        s.authenticateToken(`${PAT_PREFIX}bbbbbbbbbbbbbbbbbbbb`),
      ),
    )
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('caps expiry at a year', async () => {
    await seed()
    const created = await run(
      Effect.flatMap(PrincipalStore, (s) =>
        s.issueToken({ principalId: 'ci', name: 'forever', expiryDays: 10_000 }),
      ),
    )
    const days = (created.expiresAt - Date.now()) / (24 * 60 * 60 * 1000)
    expect(days).toBeLessThanOrEqual(366)
  })
})

describe('trusted proxy identity', () => {
  const base = {
    trustProxyIdentity: true,
    trustedProxyCidrs: ['10.0.0.0/8'],
    allowedHosts: ['mcp.example.com'],
    identityHeader: 'X-Forwarded-User',
    groupsHeader: 'X-Forwarded-Groups',
  }

  const request = (over: Partial<Parameters<typeof evaluateProxyTrust>[1]> = {}) => ({
    remoteAddress: '10.1.2.3',
    host: 'mcp.example.com',
    forwardedProto: 'https',
    headers: { 'x-forwarded-user': 'alice@example.com', 'x-forwarded-groups': 'staff, admins' },
    ...over,
  })

  it('accepts a properly forwarded identity', () => {
    const result = evaluateProxyTrust(base, request())
    expect(result.trusted).toBe(true)
    if (result.trusted) {
      expect(result.identity).toBe('alice@example.com')
      expect(result.groups).toEqual(['staff', 'admins'])
    }
  })

  it('is off by default, which is the safe direction', () => {
    const result = evaluateProxyTrust({ ...base, trustProxyIdentity: false }, request())
    expect(result.trusted).toBe(false)
    if (!result.trusted) expect(result.reason).toContain('TRUST_PROXY_IDENTITY')
  })

  it('trusts nothing when no CIDR is configured', () => {
    // Otherwise "trust the proxy" would mean "trust everyone".
    const result = evaluateProxyTrust({ ...base, trustedProxyCidrs: [] }, request())
    expect(result.trusted).toBe(false)
    if (!result.trusted) expect(result.reason).toContain('TRUSTED_PROXY_CIDRS is empty')
  })

  it('discards a spoofed identity from outside the trusted range', () => {
    // The attack this exists to stop: anyone who can reach the port asserting any identity.
    const result = evaluateProxyTrust(base, request({ remoteAddress: '203.0.113.9' }))
    expect(result.trusted).toBe(false)
    if (!result.trusted) expect(result.reason).toContain('203.0.113.9')
  })

  it('rejects an unexpected Host, which means the request did not come the configured way', () => {
    const result = evaluateProxyTrust(base, request({ host: 'evil.example.net' }))
    expect(result.trusted).toBe(false)
    if (!result.trusted) expect(result.reason).toContain('ALLOWED_HOSTS')
  })

  it('rejects a request the proxy says arrived over plain http', () => {
    const result = evaluateProxyTrust(base, request({ forwardedProto: 'http' }))
    expect(result.trusted).toBe(false)
  })

  it('rejects a trusted proxy that identified nobody', () => {
    const result = evaluateProxyTrust(base, request({ headers: {} }))
    expect(result.trusted).toBe(false)
    if (!result.trusted) expect(result.reason).toContain('did not identify anyone')
  })
})

describe('CIDR matching', () => {
  it('matches inside and outside a range', () => {
    expect(isWithinCidr('10.1.2.3', '10.0.0.0/8')).toBe(true)
    expect(isWithinCidr('11.1.2.3', '10.0.0.0/8')).toBe(false)
    expect(isWithinCidr('192.168.1.5', '192.168.1.0/24')).toBe(true)
    expect(isWithinCidr('192.168.2.5', '192.168.1.0/24')).toBe(false)
    // /32 is a single host; /0 is everything.
    expect(isWithinCidr('127.0.0.1', '127.0.0.1/32')).toBe(true)
    expect(isWithinCidr('8.8.8.8', '0.0.0.0/0')).toBe(true)
  })

  it('rejects malformed input rather than matching it', () => {
    expect(isWithinCidr('not-an-ip', '10.0.0.0/8')).toBe(false)
    expect(isWithinCidr('10.1.2.3', 'garbage')).toBe(false)
    expect(isWithinCidr('10.1.2.3', '10.0.0.0/33')).toBe(false)
  })
})

describe('scope narrowing', () => {
  it('never lets a token widen what a principal holds', () => {
    // An external OIDC provider could otherwise assert a scope nobody granted.
    const principal: Principal = {
      id: 'p',
      kind: 'oauth',
      scopes: new Set<Scope>(['mcp:read']),
    }
    const narrowed = narrowScopes(principal, ['mcp:read', 'mcp:destructive'])
    expect([...narrowed.scopes]).toEqual(['mcp:read'])
  })

  it('intersects downward', () => {
    const principal: Principal = {
      id: 'p',
      kind: 'oauth',
      scopes: new Set<Scope>(['mcp:read', 'mcp:write']),
    }
    expect([...narrowScopes(principal, ['mcp:read']).scopes]).toEqual(['mcp:read'])
  })
})
