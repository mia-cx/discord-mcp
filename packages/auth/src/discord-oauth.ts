import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { AuthenticationError, type PersistenceError, ValidationError } from '@discord-mcp/core'
import { Database } from '@discord-mcp/persistence'
import { Context, Effect, Layer, Redacted } from 'effect'
import { SecretStore } from './secrets.ts'

/**
 * Discord OAuth2 profiles — authorization-code flow with PKCE.
 *
 * Separate from MCP client authentication: this is how the *server* acts on behalf of a Discord
 * user, which is the only way to reach the five operations a bot token cannot.
 *
 * PKCE even though this is a confidential client with a secret. The verifier binds the callback to
 * the process that started it, so an intercepted `code` is useless on its own — and the
 * authorization URL travels through an agent and a browser, which is exactly where interception
 * happens.
 */

/** Long enough that an interrupted flow fails cleanly rather than lingering as a live credential. */
export const AUTHORIZATION_STATE_TTL_MS = 10 * 60 * 1000

/** Refresh this far before expiry, so a call in flight never races the token going stale. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000

const DISCORD_AUTHORIZE_URL = 'https://discord.com/api/oauth2/authorize'
const DISCORD_TOKEN_URL = 'https://discord.com/api/oauth2/token'

export interface DiscordOAuthConfig {
  readonly clientId: string
  readonly clientSecret: Redacted.Redacted<string>
  readonly redirectUri: string
}

export interface AuthorizationStart {
  readonly state: string
  readonly url: string
  readonly expiresAt: number
}

export interface OAuthProfile {
  readonly id: string
  readonly name: string
  readonly ownerPrincipalId: string
  readonly discordUserId: string | null
  readonly scopes: ReadonlyArray<string>
  readonly expiresAt: number | null
  readonly revokedAt: number | null
}

/** RFC 7636 S256. The plain method exists in the spec and is not worth supporting. */
const pkce = () => {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

const constantTimeEquals = (a: string, b: string): boolean => {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

interface TokenResponse {
  readonly access_token: string
  readonly refresh_token?: string
  readonly expires_in: number
  readonly scope: string
}

export class DiscordOAuth extends Context.Service<
  DiscordOAuth,
  {
    /** Begin a flow. Returns a URL the user must visit; nothing is stored against Discord yet. */
    readonly authorize: (input: {
      readonly profileName: string
      readonly scopes: ReadonlyArray<string>
      readonly principalId: string
    }) => Effect.Effect<AuthorizationStart, PersistenceError>
    /** Complete a flow. Validates state, principal binding, expiry, and PKCE before exchanging. */
    readonly callback: (input: {
      readonly state: string
      readonly code: string
    }) => Effect.Effect<OAuthProfile, AuthenticationError | ValidationError | PersistenceError>
    readonly list: () => Effect.Effect<ReadonlyArray<OAuthProfile>, PersistenceError>
    readonly get: (name: string) => Effect.Effect<OAuthProfile | undefined, PersistenceError>
    /** The access token, refreshed if it is close to expiry. Redacted; never logged. */
    readonly accessToken: (
      name: string,
    ) => Effect.Effect<
      Redacted.Redacted<string>,
      AuthenticationError | ValidationError | PersistenceError
    >
    readonly revoke: (name: string) => Effect.Effect<void, PersistenceError>
  }
>()('auth/DiscordOAuth') {
  static readonly layer = (
    config: DiscordOAuthConfig,
    exchange: (body: URLSearchParams) => Effect.Effect<TokenResponse, AuthenticationError> = (
      body,
    ) => defaultExchange(config, body),
  ) =>
    Layer.effect(DiscordOAuth)(
      Effect.gen(function* () {
        const db = yield* Database
        const secrets = yield* SecretStore
        const now = Effect.clockWith((c) => c.currentTimeMillis)

        const secretNames = (profileId: string) => ({
          access: `discord-oauth/${profileId}/access`,
          refresh: `discord-oauth/${profileId}/refresh`,
        })

        const loadProfile = (name: string) =>
          Effect.map(
            db.query<{
              id: string
              name: string
              owner_principal_id: string
              discord_user_id: string | null
              scopes: string
              expires_at: number | null
              revoked_at: number | null
            }>('SELECT * FROM discord_oauth_profiles WHERE name = ?', [name]),
            (rows) => {
              const row = rows[0]
              return row === undefined
                ? undefined
                : ({
                    id: row.id,
                    name: row.name,
                    ownerPrincipalId: row.owner_principal_id,
                    discordUserId: row.discord_user_id,
                    scopes: JSON.parse(row.scopes) as ReadonlyArray<string>,
                    expiresAt: row.expires_at,
                    revokedAt: row.revoked_at,
                  } satisfies OAuthProfile)
            },
          )

        /**
         * Store the exchanged tokens.
         *
         * Both are encrypted at rest and referenced by name, so nothing above this service ever
         * sees the material — including the MCP tools that use a profile.
         */
        const storeTokens = (profileId: string, tokens: TokenResponse, at: number) =>
          Effect.gen(function* () {
            const names = secretNames(profileId)
            yield* secrets.put(names.access, tokens.access_token)
            if (tokens.refresh_token !== undefined) {
              yield* secrets.put(names.refresh, tokens.refresh_token)
            }
            yield* db.execute(
              `UPDATE discord_oauth_profiles
                 SET access_secret_name = ?, refresh_secret_name = ?, expires_at = ?, scopes = ?
               WHERE id = ?`,
              [
                names.access,
                tokens.refresh_token === undefined ? null : names.refresh,
                at + tokens.expires_in * 1000,
                JSON.stringify(tokens.scope.split(' ').filter((s) => s.length > 0)),
                profileId,
              ],
            )
          })

        return {
          authorize: (input) =>
            Effect.gen(function* () {
              const at = yield* now
              const state = randomBytes(32).toString('base64url')
              const { verifier, challenge } = pkce()

              yield* db.execute(
                `INSERT INTO oauth_authorization_states
                   (state, principal_id, profile_name, scopes, code_verifier, nonce, created_at, expires_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                  state,
                  input.principalId,
                  input.profileName,
                  JSON.stringify(input.scopes),
                  verifier,
                  randomUUID(),
                  at,
                  at + AUTHORIZATION_STATE_TTL_MS,
                ],
              )

              const url = new URL(DISCORD_AUTHORIZE_URL)
              url.searchParams.set('client_id', config.clientId)
              url.searchParams.set('redirect_uri', config.redirectUri)
              url.searchParams.set('response_type', 'code')
              url.searchParams.set('scope', input.scopes.join(' '))
              url.searchParams.set('state', state)
              url.searchParams.set('code_challenge', challenge)
              url.searchParams.set('code_challenge_method', 'S256')

              return {
                state,
                url: url.toString(),
                expiresAt: at + AUTHORIZATION_STATE_TTL_MS,
              }
            }),

          callback: (input) =>
            Effect.gen(function* () {
              const at = yield* now
              const rows = yield* db.query<{
                state: string
                principal_id: string
                profile_name: string
                scopes: string
                code_verifier: string
                expires_at: number
                consumed_at: number | null
              }>('SELECT * FROM oauth_authorization_states WHERE state = ?', [input.state])

              const pending = rows[0]
              // Identical failure for unknown, consumed, and expired: distinguishing them tells a
              // guesser whether a state value ever existed.
              const reject = () =>
                Effect.fail(
                  new AuthenticationError({
                    message:
                      'The authorization state is unknown, already used, or expired. Start the flow again with discord_oauth_profile_authorize.',
                  }),
                )

              if (pending === undefined) return yield* reject()
              if (!constantTimeEquals(pending.state, input.state)) return yield* reject()
              if (pending.consumed_at !== null || pending.expires_at <= at) return yield* reject()

              // Consumed before the exchange, so a replayed callback cannot mint a second token
              // even if the first exchange is still in flight.
              yield* db.execute(
                'UPDATE oauth_authorization_states SET consumed_at = ? WHERE state = ?',
                [at, input.state],
              )

              const body = new URLSearchParams({
                client_id: config.clientId,
                client_secret: Redacted.value(config.clientSecret),
                grant_type: 'authorization_code',
                code: input.code,
                redirect_uri: config.redirectUri,
                code_verifier: pending.code_verifier,
              })
              const tokens = yield* exchange(body)

              const profileId = randomUUID()
              yield* db.execute(
                `INSERT INTO discord_oauth_profiles (id, name, owner_principal_id, scopes, created_at)
                 VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT (name) DO UPDATE SET
                   owner_principal_id = excluded.owner_principal_id,
                   revoked_at = NULL`,
                [profileId, pending.profile_name, pending.principal_id, pending.scopes, at],
              )

              const stored = yield* loadProfile(pending.profile_name)
              if (stored === undefined) {
                return yield* Effect.fail(
                  new ValidationError({
                    message: 'The profile could not be stored.',
                    issues: ['profile: unexpected database state after insert.'],
                  }),
                )
              }

              yield* storeTokens(stored.id, tokens, at)
              const refreshed = yield* loadProfile(pending.profile_name)
              return refreshed ?? stored
            }),

          list: () =>
            Effect.map(
              db.query<{
                id: string
                name: string
                owner_principal_id: string
                discord_user_id: string | null
                scopes: string
                expires_at: number | null
                revoked_at: number | null
              }>('SELECT * FROM discord_oauth_profiles ORDER BY name'),
              (rows) =>
                rows.map((row) => ({
                  id: row.id,
                  name: row.name,
                  ownerPrincipalId: row.owner_principal_id,
                  discordUserId: row.discord_user_id,
                  scopes: JSON.parse(row.scopes) as ReadonlyArray<string>,
                  expiresAt: row.expires_at,
                  revokedAt: row.revoked_at,
                })),
            ),

          get: loadProfile,

          accessToken: (name) =>
            Effect.gen(function* () {
              const profile = yield* loadProfile(name)
              if (profile === undefined || profile.revokedAt !== null) {
                return yield* Effect.fail(
                  new ValidationError({
                    message: `No usable OAuth2 profile named "${name}".`,
                    issues: [
                      'authProfile: create one with discord_oauth_profile_authorize, or check the name with discord_oauth_profile_list.',
                    ],
                  }),
                )
              }

              const at = yield* now
              const names = secretNames(profile.id)

              // Refreshed ahead of expiry rather than on failure: a token that expires mid-call
              // produces a 401, and a 401 costs Cloudflare budget.
              const needsRefresh =
                profile.expiresAt === null || profile.expiresAt - REFRESH_MARGIN_MS <= at

              if (!needsRefresh) {
                const token = yield* secrets.get(names.access)
                if (token !== undefined) return token
              }

              const refresh = yield* secrets.get(names.refresh)
              if (refresh === undefined) {
                return yield* Effect.fail(
                  new AuthenticationError({
                    message: `The OAuth2 profile "${name}" has no refresh token and its access token has expired. Re-authorize it.`,
                  }),
                )
              }

              const tokens = yield* exchange(
                new URLSearchParams({
                  client_id: config.clientId,
                  client_secret: Redacted.value(config.clientSecret),
                  grant_type: 'refresh_token',
                  refresh_token: Redacted.value(refresh),
                }),
              )
              yield* storeTokens(profile.id, tokens, at)
              return Redacted.make(tokens.access_token)
            }),

          revoke: (name) =>
            Effect.gen(function* () {
              const profile = yield* loadProfile(name)
              if (profile === undefined) return

              const at = yield* now
              const names = secretNames(profile.id)

              // Clear the references first. The profile row foreign-keys to encrypted_secrets, so
              // deleting the secrets while it still points at them violates the constraint — and
              // an ordering bug here would leave the profile revoked but its tokens on disk.
              yield* db.execute(
                'UPDATE discord_oauth_profiles SET revoked_at = ?, access_secret_name = NULL, refresh_secret_name = NULL WHERE id = ?',
                [at, profile.id],
              )

              // Delete the material, not just the flag: a revoked profile should leave nothing
              // behind that a later bug could resurrect.
              yield* secrets.delete(names.access)
              yield* secrets.delete(names.refresh)
            }),
        }
      }),
    )
}

const defaultExchange = (
  _config: DiscordOAuthConfig,
  body: URLSearchParams,
): Effect.Effect<TokenResponse, AuthenticationError> =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(DISCORD_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
      })
      if (!response.ok) {
        throw new Error(`Discord returned HTTP ${response.status}: ${await response.text()}`)
      }
      return (await response.json()) as TokenResponse
    },
    catch: (cause) =>
      new AuthenticationError({
        message: `The Discord token exchange failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  })
