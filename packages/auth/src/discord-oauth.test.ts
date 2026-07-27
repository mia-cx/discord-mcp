import { randomBytes } from 'node:crypto'
import { Database } from '@discord-mcp/persistence'
import { describe, expect, it } from 'vitest'
import {
  type DiscordOAuthClient,
  DiscordOAuthProfiles,
  type DiscordTokenSet,
} from './discord-oauth.js'
import { TokenEncryption } from './encryption.js'

describe('Discord OAuth2 profiles', () => {
  it('binds state to the principal, persists encrypted tokens, and single-flights refresh', async () => {
    const database = new Database(':memory:')
    database.migrate()
    database.run(
      'INSERT INTO principals(id, name, kind, created_at) VALUES (?, ?, ?, ?)',
      'owner',
      'Owner',
      'local',
      new Date().toISOString(),
    )
    let refreshes = 0
    const client: DiscordOAuthClient = {
      exchangeCode: async (): Promise<DiscordTokenSet> => ({
        accessToken: 'first-access',
        refreshToken: 'first-refresh',
        expiresIn: 0,
        scopes: ['identify'],
        discordUserId: '12345678901234567',
      }),
      refresh: async () => {
        refreshes += 1
        return {
          accessToken: 'refreshed-access',
          refreshToken: 'refreshed-refresh',
          expiresIn: 3_600,
          scopes: ['identify'],
        }
      },
      revoke: async () => {},
    }
    const profiles = new DiscordOAuthProfiles(
      database,
      new TokenEncryption(randomBytes(32).toString('base64')),
      client,
      '12345678901234568',
      'https://example.test/oauth/discord/callback',
    )
    const authorization = profiles.authorize({
      principalId: 'owner',
      name: 'personal',
      scopes: ['identify'],
    })
    expect(authorization.authorizationPath).toMatch(/^\/oauth\/discord\/authorize\//)
    const state = new URL(authorization.url).searchParams.get('state')
    if (!state) throw new Error('state missing')
    expect(profiles.authorizationUrl(state, 'owner')).toBe(authorization.url)
    expect(() => profiles.authorizationUrl(state, 'attacker')).toThrow(/another principal/)
    await expect(
      profiles.callback({ state, code: 'code', principalId: 'attacker' }),
    ).rejects.toThrow(/another principal/)

    const second = profiles.authorize({
      principalId: 'owner',
      name: 'personal',
      scopes: ['identify'],
    })
    const secondState = new URL(second.url).searchParams.get('state')
    if (!secondState) throw new Error('state missing')
    const metadata = await profiles.callback({
      state: secondState,
      code: 'code',
      principalId: 'owner',
    })
    expect(metadata.discordUserId).toBe('12345678901234567')
    const stored = database.get<{
      access_token_encrypted: Uint8Array
      refresh_token_encrypted: Uint8Array
    }>('SELECT access_token_encrypted, refresh_token_encrypted FROM discord_oauth_profiles')
    expect(Buffer.from(stored?.access_token_encrypted ?? []).toString()).not.toContain(
      'first-access',
    )
    const [left, right] = await Promise.all([
      profiles.accessToken(metadata.id, 'owner'),
      profiles.accessToken(metadata.id, 'owner'),
    ])
    expect([left, right]).toEqual(['refreshed-access', 'refreshed-access'])
    expect(refreshes).toBe(1)
    await profiles.revoke(metadata.id, 'owner')
    expect(profiles.get(metadata.id, 'owner').revoked).toBe(true)
    database.close()
  })

  it('never shares an in-flight token refresh across profile owners', async () => {
    const database = new Database(':memory:')
    database.migrate()
    const now = new Date().toISOString()
    for (const principal of ['owner', 'attacker']) {
      database.run(
        'INSERT INTO principals(id, name, kind, created_at) VALUES (?, ?, ?, ?)',
        principal,
        principal,
        'local',
        now,
      )
    }
    let releaseRefresh: ((tokens: DiscordTokenSet) => void) | undefined
    const refresh = new Promise<DiscordTokenSet>((resolve) => {
      releaseRefresh = resolve
    })
    const profiles = new DiscordOAuthProfiles(
      database,
      new TokenEncryption(randomBytes(32).toString('base64')),
      {
        exchangeCode: async () => ({
          accessToken: 'expired-access',
          refreshToken: 'refresh-token',
          expiresIn: 0,
          scopes: ['identify'],
        }),
        refresh: async () => refresh,
        revoke: async () => {},
      },
      '12345678901234568',
      'https://example.test/oauth/discord/callback',
    )
    const authorization = profiles.authorize({
      principalId: 'owner',
      name: 'owner-profile',
      scopes: ['identify'],
    })
    const state = new URL(authorization.url).searchParams.get('state')
    if (!state) throw new Error('state missing')
    const profile = await profiles.callback({ state, code: 'code', principalId: 'owner' })
    const ownerRefresh = profiles.accessToken(profile.id, 'owner')
    await expect(profiles.accessToken(profile.id, 'attacker')).rejects.toThrow(/unavailable/)
    releaseRefresh?.({
      accessToken: 'owner-only-access',
      refreshToken: 'owner-only-refresh',
      expiresIn: 3_600,
      scopes: ['identify'],
    })
    await expect(ownerRefresh).resolves.toBe('owner-only-access')
    database.close()
  })

  it('erases local token material even when Discord revocation fails', async () => {
    const database = new Database(':memory:')
    database.migrate()
    database.run(
      'INSERT INTO principals(id, name, kind, created_at) VALUES (?, ?, ?, ?)',
      'owner',
      'Owner',
      'local',
      new Date().toISOString(),
    )
    const profiles = new DiscordOAuthProfiles(
      database,
      new TokenEncryption(randomBytes(32).toString('base64')),
      {
        exchangeCode: async () => ({
          accessToken: 'access',
          refreshToken: 'refresh',
          expiresIn: 3_600,
          scopes: ['identify'],
        }),
        refresh: async () => {
          throw new Error('unexpected refresh')
        },
        revoke: async () => {
          throw new Error('Discord unavailable')
        },
      },
      '12345678901234568',
      'https://example.test/oauth/discord/callback',
    )
    const authorization = profiles.authorize({
      principalId: 'owner',
      name: 'revocation-fixture',
      scopes: ['identify'],
    })
    const state = new URL(authorization.url).searchParams.get('state')
    if (!state) throw new Error('state missing')
    const profile = await profiles.callback({ state, code: 'code', principalId: 'owner' })
    await expect(profiles.revoke(profile.id, 'owner')).rejects.toThrow(/Discord unavailable/)
    expect(
      database.get<{
        revoked_at: string | null
        access_token_encrypted: Uint8Array | null
        refresh_token_encrypted: Uint8Array | null
      }>(
        `SELECT revoked_at, access_token_encrypted, refresh_token_encrypted
         FROM discord_oauth_profiles WHERE id = ?`,
        profile.id,
      ),
    ).toMatchObject({
      revoked_at: expect.any(String),
      access_token_encrypted: null,
      refresh_token_encrypted: null,
    })
    database.close()
  })
})
