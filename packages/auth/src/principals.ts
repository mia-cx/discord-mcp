import { randomBytes, randomUUID } from 'node:crypto'
import {
  AuthenticationError,
  type PersistenceError,
  type Principal,
  type Scope,
} from '@discord-mcp/core'
import { Database } from '@discord-mcp/persistence'
import argon2 from 'argon2'
import { Context, Effect, Layer } from 'effect'

/**
 * Principals and personal access tokens.
 *
 * A PAT is shown once and stored only as an argon2id hash. Storing it reversibly would mean a
 * database read is a credential compromise, which for a token that can reach `mcp:destructive` is
 * not a trade worth making.
 */

export const PAT_PREFIX = 'dcmcp_'
const PAT_ENTROPY_BYTES = 32
const DEFAULT_EXPIRY_DAYS = 90
export const MAX_EXPIRY_DAYS = 365
const DAY_MS = 24 * 60 * 60 * 1000

/** Deliberately not the default. Password-grade parameters for a credential that lasts 90 days. */
const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const

export interface CreatedToken {
  readonly id: string
  /** Shown once. Never recoverable afterwards. */
  readonly token: string
  readonly expiresAt: number
}

export class PrincipalStore extends Context.Service<
  PrincipalStore,
  {
    readonly create: (input: {
      readonly id: string
      readonly kind: Principal['kind']
      readonly displayName: string
      readonly scopes: ReadonlyArray<Scope>
    }) => Effect.Effect<Principal, PersistenceError>
    readonly get: (id: string) => Effect.Effect<Principal | undefined, PersistenceError>
    readonly list: () => Effect.Effect<ReadonlyArray<Principal>, PersistenceError>
    readonly issueToken: (input: {
      readonly principalId: string
      readonly name: string
      readonly expiryDays?: number
    }) => Effect.Effect<CreatedToken, PersistenceError>
    /** Resolves a bearer token to its principal, or fails with a reason that is safe to return. */
    readonly authenticateToken: (
      token: string,
    ) => Effect.Effect<Principal, AuthenticationError | PersistenceError>
    readonly revokeToken: (tokenId: string) => Effect.Effect<void, PersistenceError>
    readonly listTokens: (principalId: string) => Effect.Effect<
      ReadonlyArray<{
        readonly id: string
        readonly name: string
        readonly expiresAt: number
        readonly revokedAt: number | null
        readonly lastUsedAt: number | null
      }>,
      PersistenceError
    >
    /** Maps a trusted proxy's identity header to a configured principal. */
    readonly bindProxyIdentity: (
      headerValue: string,
      principalId: string,
    ) => Effect.Effect<void, PersistenceError>
    readonly resolveProxyIdentity: (
      headerValue: string,
    ) => Effect.Effect<Principal | undefined, PersistenceError>
  }
>()('auth/PrincipalStore') {
  static readonly layer = Layer.effect(PrincipalStore)(
    Effect.gen(function* () {
      const db = yield* Database
      const now = Effect.clockWith((c) => c.currentTimeMillis)

      const load = (id: string): Effect.Effect<Principal | undefined, PersistenceError> =>
        Effect.gen(function* () {
          const rows = yield* db.query<{ id: string; kind: string; disabled_at: number | null }>(
            'SELECT id, kind, disabled_at FROM principals WHERE id = ?',
            [id],
          )
          const row = rows[0]
          if (row === undefined || row.disabled_at !== null) return undefined

          const scopes = yield* db.query<{ scope: string }>(
            'SELECT scope FROM principal_scope_bindings WHERE principal_id = ?',
            [id],
          )
          return {
            id: row.id,
            kind: row.kind as Principal['kind'],
            scopes: new Set(scopes.map((s) => s.scope as Scope)),
          } satisfies Principal
        })

      return {
        create: (input) =>
          db.transaction(
            Effect.gen(function* () {
              const at = yield* now
              yield* db.execute(
                `INSERT INTO principals (id, kind, display_name, created_at) VALUES (?, ?, ?, ?)
                 ON CONFLICT (id) DO UPDATE SET display_name = excluded.display_name`,
                [input.id, input.kind, input.displayName, at],
              )
              // Replace rather than merge: a scope set is declarative, and merging would make
              // removing a scope impossible through this path.
              yield* db.execute('DELETE FROM principal_scope_bindings WHERE principal_id = ?', [
                input.id,
              ])
              for (const scope of input.scopes) {
                yield* db.execute(
                  'INSERT INTO principal_scope_bindings (principal_id, scope) VALUES (?, ?)',
                  [input.id, scope],
                )
              }
              return {
                id: input.id,
                kind: input.kind,
                scopes: new Set(input.scopes),
              } satisfies Principal
            }),
          ),

        get: load,

        list: () =>
          Effect.gen(function* () {
            const rows = yield* db.query<{ id: string }>(
              'SELECT id FROM principals WHERE disabled_at IS NULL ORDER BY id',
            )
            const loaded = yield* Effect.forEach(rows, (r) => load(r.id))
            return loaded.filter((p): p is Principal => p !== undefined)
          }),

        issueToken: (input) =>
          Effect.gen(function* () {
            const at = yield* now
            const days = Math.min(input.expiryDays ?? DEFAULT_EXPIRY_DAYS, MAX_EXPIRY_DAYS)
            const id = randomUUID()
            // 256 bits. The prefix is for humans and secret scanners, not for lookup.
            const token = `${PAT_PREFIX}${randomBytes(PAT_ENTROPY_BYTES).toString('base64url')}`
            const hash = yield* Effect.promise(() => argon2.hash(token, ARGON2_OPTIONS))
            const expiresAt = at + days * DAY_MS

            yield* db.execute(
              `INSERT INTO personal_access_tokens (id, principal_id, name, token_hash, created_at, expires_at)
               VALUES (?, ?, ?, ?, ?, ?)`,
              [id, input.principalId, input.name, hash, at, expiresAt],
            )
            return { id, token, expiresAt }
          }),

        authenticateToken: (token) =>
          Effect.gen(function* () {
            const reject = (message: string) => Effect.fail(new AuthenticationError({ message }))

            if (!token.startsWith(PAT_PREFIX)) {
              return yield* reject(
                `Not a personal access token. Tokens issued by this server start with "${PAT_PREFIX}".`,
              )
            }

            const at = yield* now
            const candidates = yield* db.query<{
              id: string
              principal_id: string
              token_hash: string
              expires_at: number
              revoked_at: number | null
            }>(
              'SELECT id, principal_id, token_hash, expires_at, revoked_at FROM personal_access_tokens WHERE revoked_at IS NULL',
            )

            // The hash is not derivable from the token, so every live token has to be tried.
            // argon2 is deliberately slow, which bounds how many can exist before this matters —
            // an operator with thousands of live PATs has a different problem.
            for (const candidate of candidates) {
              const matched = yield* Effect.promise(() =>
                argon2.verify(candidate.token_hash, token).catch(() => false),
              )
              if (!matched) continue

              if (candidate.expires_at <= at) {
                return yield* reject(
                  'This personal access token has expired. Issue a new one with `discord-mcp auth token create`.',
                )
              }

              yield* db.execute('UPDATE personal_access_tokens SET last_used_at = ? WHERE id = ?', [
                at,
                candidate.id,
              ])

              const principal = yield* load(candidate.principal_id)
              return principal === undefined
                ? yield* reject('The principal this token belongs to is disabled or missing.')
                : principal
            }

            // Deliberately identical for "unknown" and "revoked": distinguishing them tells an
            // attacker whether a guessed token ever existed.
            return yield* reject('The personal access token is not valid.')
          }),

        revokeToken: (tokenId) =>
          Effect.flatMap(now, (at) =>
            db.execute('UPDATE personal_access_tokens SET revoked_at = ? WHERE id = ?', [
              at,
              tokenId,
            ]),
          ),

        listTokens: (principalId) =>
          Effect.map(
            db.query<{
              id: string
              name: string
              expires_at: number
              revoked_at: number | null
              last_used_at: number | null
            }>(
              'SELECT id, name, expires_at, revoked_at, last_used_at FROM personal_access_tokens WHERE principal_id = ? ORDER BY created_at',
              [principalId],
            ),
            (rows) =>
              rows.map((r) => ({
                id: r.id,
                name: r.name,
                expiresAt: r.expires_at,
                revokedAt: r.revoked_at,
                lastUsedAt: r.last_used_at,
              })),
          ),

        bindProxyIdentity: (headerValue, principalId) =>
          Effect.flatMap(now, (at) =>
            db.execute(
              `INSERT INTO proxy_identities (header_value, principal_id, created_at) VALUES (?, ?, ?)
               ON CONFLICT (header_value) DO UPDATE SET principal_id = excluded.principal_id`,
              [headerValue, principalId, at],
            ),
          ),

        resolveProxyIdentity: (headerValue) =>
          Effect.gen(function* () {
            const rows = yield* db.query<{ principal_id: string }>(
              'SELECT principal_id FROM proxy_identities WHERE header_value = ?',
              [headerValue],
            )
            const row = rows[0]
            return row === undefined ? undefined : yield* load(row.principal_id)
          }),
      }
    }),
  )
}
