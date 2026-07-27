import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { Database } from '@discord-mcp/persistence'
import { Schema } from 'effect'
import type { TokenEncryption } from './encryption.js'

export class OAuthProfileError extends Schema.TaggedErrorClass<OAuthProfileError>()(
  'OAuthProfileError',
  { message: Schema.String },
) {
  constructor(message: string) {
    super({ message })
  }
}

export interface DiscordTokenSet {
  readonly accessToken: string
  readonly refreshToken?: string
  readonly expiresIn: number
  readonly scopes: ReadonlyArray<string>
  readonly discordUserId?: string
}

export interface DiscordOAuthClient {
  exchangeCode(input: {
    readonly code: string
    readonly verifier: string
    readonly redirectUri: string
  }): Promise<DiscordTokenSet>
  refresh(refreshToken: string): Promise<DiscordTokenSet>
  revoke(token: string): Promise<void>
}

export interface OAuthProfileMetadata {
  readonly id: string
  readonly ownerPrincipalId: string
  readonly name: string
  readonly scopes: ReadonlyArray<string>
  readonly discordUserId?: string
  readonly expiresAt?: string
  readonly revoked: boolean
}

export class DiscordOAuthProfiles {
  readonly #refreshes = new Map<string, Promise<string>>()

  constructor(
    readonly database: Database,
    readonly encryption: TokenEncryption,
    readonly client: DiscordOAuthClient,
    readonly applicationId: string,
    readonly redirectUri: string,
    readonly observer: {
      readonly refreshFailed?: (event: { readonly profileId: string }) => void
    } = {},
  ) {}

  authorize(input: {
    readonly principalId: string
    readonly name: string
    readonly scopes: ReadonlyArray<string>
  }): {
    readonly profileId: string
    readonly url: string
    readonly authorizationPath: string
    readonly expiresAt: string
  } {
    if (input.scopes.length === 0) throw new OAuthProfileError('OAuth profile needs scopes')
    const profileId = randomUUID()
    const state = randomBytes(32).toString('base64url')
    const verifier = randomBytes(32).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString()
    this.database.run(
      `INSERT INTO discord_oauth_authorization_states
       (state_hash, principal_id, profile_id, profile_name, scopes_json,
        pkce_verifier_encrypted, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      createHash('sha256').update(state).digest('hex'),
      input.principalId,
      profileId,
      input.name,
      JSON.stringify(input.scopes),
      this.encryption.encrypt(verifier, `oauth-state:${profileId}`),
      expiresAt,
      new Date().toISOString(),
    )
    return {
      profileId,
      url: this.#authorizationUrl(state, input.scopes, challenge),
      authorizationPath: `/oauth/discord/authorize/${encodeURIComponent(state)}`,
      expiresAt,
    }
  }

  authorizationUrl(state: string, principalId: string): string {
    const stateHash = createHash('sha256').update(state).digest('hex')
    const row = this.database.get<{
      principal_id: string
      profile_id: string
      scopes_json: string
      pkce_verifier_encrypted: Uint8Array
      expires_at: string
    }>(
      `SELECT principal_id, profile_id, scopes_json, pkce_verifier_encrypted, expires_at
       FROM discord_oauth_authorization_states WHERE state_hash = ?`,
      stateHash,
    )
    if (!row || row.principal_id !== principalId || Date.parse(row.expires_at) <= Date.now()) {
      throw new OAuthProfileError(
        'OAuth state is invalid, expired, or belongs to another principal',
      )
    }
    const verifier = this.encryption.decrypt(
      row.pkce_verifier_encrypted,
      `oauth-state:${row.profile_id}`,
    )
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    return this.#authorizationUrl(
      state,
      JSON.parse(row.scopes_json) as ReadonlyArray<string>,
      challenge,
    )
  }

  async callback(input: {
    readonly state: string
    readonly code: string
    readonly principalId?: string
  }): Promise<OAuthProfileMetadata> {
    const stateHash = createHash('sha256').update(input.state).digest('hex')
    const row = this.database.get<{
      principal_id: string
      profile_id: string
      profile_name: string
      scopes_json: string
      pkce_verifier_encrypted: Uint8Array
      expires_at: string
    }>('SELECT * FROM discord_oauth_authorization_states WHERE state_hash = ?', stateHash)
    this.database.run(
      'DELETE FROM discord_oauth_authorization_states WHERE state_hash = ?',
      stateHash,
    )
    if (
      !row ||
      (input.principalId !== undefined && row.principal_id !== input.principalId) ||
      Date.parse(row.expires_at) <= Date.now()
    ) {
      throw new OAuthProfileError(
        'OAuth state is invalid, expired, or belongs to another principal',
      )
    }
    const verifier = this.encryption.decrypt(
      row.pkce_verifier_encrypted,
      `oauth-state:${row.profile_id}`,
    )
    const tokens = await this.client.exchangeCode({
      code: input.code,
      verifier,
      redirectUri: this.redirectUri,
    })
    const expiresAt = new Date(Date.now() + tokens.expiresIn * 1_000).toISOString()
    this.database.run(
      `INSERT INTO discord_oauth_profiles
       (id, owner_principal_id, name, discord_user_id, scopes_json,
        access_token_encrypted, refresh_token_encrypted, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.profile_id,
      row.principal_id,
      row.profile_name,
      tokens.discordUserId ?? null,
      JSON.stringify(tokens.scopes),
      this.encryption.encrypt(tokens.accessToken, `oauth-access:${row.profile_id}`),
      tokens.refreshToken === undefined
        ? null
        : this.encryption.encrypt(tokens.refreshToken, `oauth-refresh:${row.profile_id}`),
      expiresAt,
      new Date().toISOString(),
    )
    return this.get(row.profile_id, row.principal_id)
  }

  list(ownerPrincipalId: string): ReadonlyArray<OAuthProfileMetadata> {
    return this.database
      .all<{
        id: string
        owner_principal_id: string
        name: string
        discord_user_id: string | null
        scopes_json: string
        expires_at: string | null
        revoked_at: string | null
      }>('SELECT * FROM discord_oauth_profiles WHERE owner_principal_id = ?', ownerPrincipalId)
      .map(profileMetadata)
  }

  get(id: string, ownerPrincipalId: string): OAuthProfileMetadata {
    const row = this.database.get<{
      id: string
      owner_principal_id: string
      name: string
      discord_user_id: string | null
      scopes_json: string
      expires_at: string | null
      revoked_at: string | null
    }>(
      'SELECT * FROM discord_oauth_profiles WHERE id = ? AND owner_principal_id = ?',
      id,
      ownerPrincipalId,
    )
    if (!row) throw new OAuthProfileError(`OAuth profile ${id} does not exist`)
    return profileMetadata(row)
  }

  accessToken(id: string, ownerPrincipalId: string): Promise<string> {
    const refreshKey = `${ownerPrincipalId}\0${id}`
    const existing = this.#refreshes.get(refreshKey)
    if (existing) return existing
    const work = this.#accessToken(id, ownerPrincipalId).finally(() =>
      this.#refreshes.delete(refreshKey),
    )
    this.#refreshes.set(refreshKey, work)
    return work
  }

  async #accessToken(id: string, ownerPrincipalId: string): Promise<string> {
    const row = this.database.get<{
      access_token_encrypted: Uint8Array
      refresh_token_encrypted: Uint8Array | null
      expires_at: string
      revoked_at: string | null
    }>(
      `SELECT access_token_encrypted, refresh_token_encrypted, expires_at, revoked_at
       FROM discord_oauth_profiles WHERE id = ? AND owner_principal_id = ?`,
      id,
      ownerPrincipalId,
    )
    if (!row || row.revoked_at !== null) throw new OAuthProfileError('OAuth profile unavailable')
    if (Date.parse(row.expires_at) > Date.now() + 60_000) {
      return this.encryption.decrypt(row.access_token_encrypted, `oauth-access:${id}`)
    }
    if (!row.refresh_token_encrypted) throw new OAuthProfileError('OAuth profile cannot refresh')
    let tokens: DiscordTokenSet
    try {
      tokens = await this.client.refresh(
        this.encryption.decrypt(row.refresh_token_encrypted, `oauth-refresh:${id}`),
      )
    } catch (cause) {
      this.observer.refreshFailed?.({ profileId: id })
      throw cause instanceof OAuthProfileError
        ? cause
        : new OAuthProfileError(
            `OAuth profile refresh failed: ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
          )
    }
    this.database.run(
      `UPDATE discord_oauth_profiles SET access_token_encrypted = ?,
       refresh_token_encrypted = ?, scopes_json = ?, expires_at = ? WHERE id = ?`,
      this.encryption.encrypt(tokens.accessToken, `oauth-access:${id}`),
      tokens.refreshToken === undefined
        ? row.refresh_token_encrypted
        : this.encryption.encrypt(tokens.refreshToken, `oauth-refresh:${id}`),
      JSON.stringify(tokens.scopes),
      new Date(Date.now() + tokens.expiresIn * 1_000).toISOString(),
      id,
    )
    return tokens.accessToken
  }

  async revoke(id: string, ownerPrincipalId: string): Promise<void> {
    const token = await this.accessToken(id, ownerPrincipalId)
    try {
      await this.client.revoke(token)
    } finally {
      this.database.run(
        `UPDATE discord_oauth_profiles SET revoked_at = ?,
         access_token_encrypted = NULL, refresh_token_encrypted = NULL
         WHERE id = ? AND owner_principal_id = ?`,
        new Date().toISOString(),
        id,
        ownerPrincipalId,
      )
    }
  }

  #authorizationUrl(state: string, scopes: ReadonlyArray<string>, challenge: string): string {
    const url = new URL('https://discord.com/oauth2/authorize')
    url.searchParams.set('client_id', this.applicationId)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('redirect_uri', this.redirectUri)
    url.searchParams.set('scope', scopes.join(' '))
    url.searchParams.set('state', state)
    url.searchParams.set('code_challenge', challenge)
    url.searchParams.set('code_challenge_method', 'S256')
    return url.toString()
  }
}

const profileMetadata = (row: {
  readonly id: string
  readonly owner_principal_id: string
  readonly name: string
  readonly discord_user_id: string | null
  readonly scopes_json: string
  readonly expires_at: string | null
  readonly revoked_at: string | null
}): OAuthProfileMetadata => ({
  id: row.id,
  ownerPrincipalId: row.owner_principal_id,
  name: row.name,
  scopes: JSON.parse(row.scopes_json) as Array<string>,
  ...(row.discord_user_id === null ? {} : { discordUserId: row.discord_user_id }),
  ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
  revoked: row.revoked_at !== null,
})
