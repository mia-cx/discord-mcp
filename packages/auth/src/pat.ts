import { randomBytes, randomUUID } from 'node:crypto'
import type { Database } from '@discord-mcp/persistence'
import argon2 from 'argon2'
import { AuthenticationError, type Principal, type Scope, scopes } from './principal.js'

export interface PersonalAccessTokenMetadata {
  readonly id: string
  readonly principalId: string
  readonly name: string
  readonly prefix: string
  readonly expiresAt: string
  readonly revokedAt?: string
  readonly createdAt: string
}

export class PersonalAccessTokens {
  constructor(readonly database: Database) {}

  async create(input: {
    readonly principalId: string
    readonly name: string
    readonly expiresInDays?: number
  }): Promise<{ readonly token: string; readonly metadata: PersonalAccessTokenMetadata }> {
    const days = input.expiresInDays ?? 90
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      throw new AuthenticationError('PAT expiry must be between 1 and 365 days')
    }
    if (input.name.trim().length < 1 || input.name.length > 100) {
      throw new AuthenticationError('PAT name must be 1–100 characters')
    }
    const principal = this.database.get<{ disabled_at: string | null }>(
      'SELECT disabled_at FROM principals WHERE id = ?',
      input.principalId,
    )
    if (!principal || principal.disabled_at !== null) {
      throw new AuthenticationError('PAT principal does not exist or is disabled')
    }
    const token = `dcmcp_${randomBytes(32).toString('base64url')}`
    const prefix = token.slice(0, 14)
    const id = randomUUID()
    const createdAt = new Date().toISOString()
    const expiresAt = new Date(Date.now() + days * 86_400_000).toISOString()
    const hash = await argon2.hash(token, { type: argon2.argon2id })
    this.database.run(
      `INSERT INTO personal_access_tokens
       (id, principal_id, name, prefix, hash, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.principalId,
      input.name,
      prefix,
      hash,
      expiresAt,
      createdAt,
    )
    return {
      token,
      metadata: {
        id,
        principalId: input.principalId,
        name: input.name,
        prefix,
        expiresAt,
        createdAt,
      },
    }
  }

  async authenticate(token: string): Promise<Principal> {
    if (!/^dcmcp_[A-Za-z0-9_-]{43}$/.test(token)) throw new AuthenticationError('invalid PAT')
    const row = this.database.get<{
      id: string
      principal_id: string
      hash: string
      expires_at: string
      revoked_at: string | null
    }>(
      `SELECT id, principal_id, hash, expires_at, revoked_at
       FROM personal_access_tokens WHERE prefix = ?`,
      token.slice(0, 14),
    )
    if (
      !row ||
      row.revoked_at !== null ||
      Date.parse(row.expires_at) <= Date.now() ||
      !(await argon2.verify(row.hash, token))
    ) {
      throw new AuthenticationError('invalid, expired, or revoked PAT')
    }
    const principal = this.database.get<{
      id: string
      name: string
      kind: Principal['kind']
      disabled_at: string | null
    }>('SELECT id, name, kind, disabled_at FROM principals WHERE id = ?', row.principal_id)
    if (!principal || principal.disabled_at !== null)
      throw new AuthenticationError('principal disabled')
    const bound = this.database
      .all<{ scope: string }>(
        'SELECT scope FROM principal_scope_bindings WHERE principal_id = ?',
        principal.id,
      )
      .map(({ scope }) => scope)
      .filter((scope): scope is Scope => scopes.includes(scope as Scope))
    return {
      id: principal.id,
      name: principal.name,
      kind: 'pat',
      scopes: new Set(bound),
      expiresAt: Date.parse(row.expires_at),
    }
  }

  list(principalId?: string): ReadonlyArray<PersonalAccessTokenMetadata> {
    const rows = principalId
      ? this.database.all<{
          id: string
          principal_id: string
          name: string
          prefix: string
          expires_at: string
          revoked_at: string | null
          created_at: string
        }>(
          `SELECT id, principal_id, name, prefix, expires_at, revoked_at, created_at
           FROM personal_access_tokens WHERE principal_id = ? ORDER BY created_at DESC`,
          principalId,
        )
      : this.database.all<{
          id: string
          principal_id: string
          name: string
          prefix: string
          expires_at: string
          revoked_at: string | null
          created_at: string
        }>(
          `SELECT id, principal_id, name, prefix, expires_at, revoked_at, created_at
           FROM personal_access_tokens ORDER BY created_at DESC`,
        )
    return rows.map((row) => ({
      id: row.id,
      principalId: row.principal_id,
      name: row.name,
      prefix: row.prefix,
      expiresAt: row.expires_at,
      ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at }),
      createdAt: row.created_at,
    }))
  }

  revoke(id: string): void {
    const result = this.database.run(
      'UPDATE personal_access_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL',
      new Date().toISOString(),
      id,
    )
    if (result.changes !== 1) throw new AuthenticationError(`active PAT ${id} does not exist`)
  }
}
