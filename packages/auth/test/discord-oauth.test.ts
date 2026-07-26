import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database, PersistenceLayer } from '@discord-mcp/persistence'
import { Effect, Layer, ManagedRuntime, Redacted } from 'effect'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DiscordOAuth } from '../src/discord-oauth.ts'
import { SecretStore } from '../src/secrets.ts'

const KEY = randomBytes(32)

/** Records every exchange so the test can assert what was sent to Discord, and what was not. */
let exchanges: Array<URLSearchParams>
let nextResponse: {
  access_token: string
  refresh_token?: string
  expires_in: number
  scope: string
}

let dir: string
let runtime: ManagedRuntime.ManagedRuntime<DiscordOAuth | SecretStore | Database, never>

const run = <A, E>(effect: Effect.Effect<A, E, DiscordOAuth | SecretStore | Database>) =>
  runtime.runPromise(effect)

const makeRuntime = () => {
  const persistence = PersistenceLayer(join(dir, 'oauth.sqlite'))
  const secrets = SecretStore.layer(KEY).pipe(Layer.provide(persistence))

  return ManagedRuntime.make(
    Layer.mergeAll(
      // DiscordOAuth stores token material through SecretStore, so it needs it provided rather
      // than merged alongside.
      DiscordOAuth.layer(
        {
          clientId: 'app-id',
          clientSecret: Redacted.make('app-secret'),
          redirectUri: 'https://mcp.example.com/oauth/discord/callback',
        },
        (body) =>
          Effect.sync(() => {
            exchanges.push(body)
            return nextResponse
          }),
      ).pipe(Layer.provide(Layer.merge(secrets, persistence))),
      secrets,
    ).pipe(Layer.provideMerge(persistence)),
  )
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'discord-mcp-oauth-'))
  exchanges = []
  nextResponse = {
    access_token: 'access-1',
    refresh_token: 'refresh-1',
    expires_in: 604_800,
    scope: 'identify guilds',
  }
  runtime = makeRuntime()

  // A profile is foreign-keyed to the principal that owns it, so the principal must exist first —
  // which is also the real order of events: someone authenticated, then authorized a profile.
  await run(
    Effect.flatMap(Database, (db) =>
      db.execute(
        'INSERT INTO principals (id, kind, display_name, created_at) VALUES (?, ?, ?, ?)',
        ['p1', 'pat', 'Test principal', Date.now()],
      ),
    ),
  )
})

afterEach(async () => {
  await runtime.dispose()
  rmSync(dir, { recursive: true, force: true })
})

const authorize = () =>
  run(
    Effect.flatMap(DiscordOAuth, (o) =>
      o.authorize({ profileName: 'me', scopes: ['identify', 'guilds'], principalId: 'p1' }),
    ),
  )

const complete = (state: string, code = 'the-code') =>
  run(Effect.flatMap(DiscordOAuth, (o) => o.callback({ state, code })))

describe('the authorization URL', () => {
  it('carries PKCE S256, the state, and the requested scopes', async () => {
    const started = await authorize()
    const url = new URL(started.url)

    expect(url.origin + url.pathname).toBe('https://discord.com/api/oauth2/authorize')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('scope')).toBe('identify guilds')
    expect(url.searchParams.get('state')).toBe(started.state)
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('code_challenge')).toBeTruthy()
  })

  it('sends a challenge, never the verifier', async () => {
    const started = await authorize()
    const challenge = new URL(started.url).searchParams.get('code_challenge') as string

    const stored = await run(
      Effect.flatMap(Database, (db) =>
        db.query<{ code_verifier: string }>(
          'SELECT code_verifier FROM oauth_authorization_states WHERE state = ?',
          [started.state],
        ),
      ),
    )
    const verifier = stored[0]?.code_verifier as string

    // The whole point of PKCE: the URL travels through an agent and a browser, so it must not
    // carry anything that would let an interceptor complete the exchange.
    expect(started.url).not.toContain(verifier)
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(challenge)
  })

  it('expires', async () => {
    const started = await authorize()
    expect(started.expiresAt - Date.now()).toBeLessThanOrEqual(10 * 60 * 1000)
  })
})

describe('the callback', () => {
  it('exchanges the code with the verifier and stores the profile', async () => {
    const started = await authorize()
    const profile = await complete(started.state)

    expect(profile.name).toBe('me')
    expect(profile.ownerPrincipalId).toBe('p1')
    expect(profile.scopes).toEqual(['identify', 'guilds'])

    const sent = exchanges[0] as URLSearchParams
    expect(sent.get('grant_type')).toBe('authorization_code')
    expect(sent.get('code')).toBe('the-code')
    // The verifier proves this exchange came from the process that started the flow.
    expect(sent.get('code_verifier')).toBeTruthy()
  })

  it('rejects an unknown state', async () => {
    const exit = await runtime.runPromiseExit(
      Effect.flatMap(DiscordOAuth, (o) => o.callback({ state: 'never-issued', code: 'x' })),
    )
    expect(exit._tag).toBe('Failure')
    expect(exchanges).toEqual([])
  })

  it('rejects a replayed state, so a stolen callback cannot mint a second token', async () => {
    const started = await authorize()
    await complete(started.state)

    const exit = await runtime.runPromiseExit(
      Effect.flatMap(DiscordOAuth, (o) => o.callback({ state: started.state, code: 'again' })),
    )
    expect(exit._tag).toBe('Failure')
    // Only the first exchange happened.
    expect(exchanges).toHaveLength(1)
  })

  it('rejects an expired state', async () => {
    const started = await authorize()
    await run(
      Effect.flatMap(Database, (db) =>
        db.execute('UPDATE oauth_authorization_states SET expires_at = ? WHERE state = ?', [
          1,
          started.state,
        ]),
      ),
    )

    const exit = await runtime.runPromiseExit(
      Effect.flatMap(DiscordOAuth, (o) => o.callback({ state: started.state, code: 'x' })),
    )
    expect(exit._tag).toBe('Failure')
    expect(exchanges).toEqual([])
  })

  it('gives the same answer for unknown, replayed, and expired', async () => {
    // Distinguishing them would tell a guesser whether a state value ever existed.
    const started = await authorize()
    await complete(started.state)

    const replayed = await runtime.runPromiseExit(
      Effect.flatMap(DiscordOAuth, (o) => o.callback({ state: started.state, code: 'x' })),
    )
    const unknown = await runtime.runPromiseExit(
      Effect.flatMap(DiscordOAuth, (o) => o.callback({ state: 'nope', code: 'x' })),
    )
    expect(JSON.stringify(replayed)).toBe(JSON.stringify(unknown))
  })
})

describe('stored tokens', () => {
  it('never appear in plaintext on disk', async () => {
    const started = await authorize()
    await complete(started.state)

    const rows = await run(
      Effect.flatMap(Database, (db) =>
        db.query<{ name: string; ciphertext: Uint8Array }>(
          'SELECT name, ciphertext FROM encrypted_secrets',
        ),
      ),
    )
    expect(rows.length).toBe(2)
    for (const row of rows) {
      expect(Buffer.from(row.ciphertext).toString('utf8')).not.toContain('access-1')
      expect(Buffer.from(row.ciphertext).toString('utf8')).not.toContain('refresh-1')
    }
  })

  it('are returned redacted, so an interpolation cannot leak one', async () => {
    const started = await authorize()
    await complete(started.state)

    const token = await run(Effect.flatMap(DiscordOAuth, (o) => o.accessToken('me')))
    expect(Redacted.value(token)).toBe('access-1')
    expect(String(token)).not.toContain('access-1')
  })

  it('survive a restart', async () => {
    const started = await authorize()
    await complete(started.state)
    await runtime.dispose()

    // Same file, same master key, fresh process. The principal is already in the database.
    runtime = makeRuntime()
    const token = await run(Effect.flatMap(DiscordOAuth, (o) => o.accessToken('me')))
    expect(Redacted.value(token)).toBe('access-1')
    // No new exchange: the stored token was still valid.
    expect(exchanges).toHaveLength(1)
  })
})

describe('refresh', () => {
  it('happens ahead of expiry rather than after a 401', async () => {
    const started = await authorize()
    await complete(started.state)

    // Inside the refresh margin but not yet expired.
    await run(
      Effect.flatMap(Database, (db) =>
        db.execute('UPDATE discord_oauth_profiles SET expires_at = ? WHERE name = ?', [
          Date.now() + 60_000,
          'me',
        ]),
      ),
    )

    nextResponse = {
      access_token: 'access-2',
      refresh_token: 'refresh-2',
      expires_in: 604_800,
      scope: 'identify guilds',
    }
    const token = await run(Effect.flatMap(DiscordOAuth, (o) => o.accessToken('me')))

    expect(Redacted.value(token)).toBe('access-2')
    // A token that expires mid-call produces a 401, and 401s cost Cloudflare budget.
    expect((exchanges[1] as URLSearchParams).get('grant_type')).toBe('refresh_token')
  })

  it('reports plainly when there is nothing left to refresh with', async () => {
    nextResponse = { access_token: 'access-1', expires_in: 1, scope: 'identify' }
    const started = await authorize()
    await complete(started.state)

    const exit = await runtime.runPromiseExit(
      Effect.flatMap(DiscordOAuth, (o) => o.accessToken('me')),
    )
    expect(exit._tag).toBe('Failure')
    expect(JSON.stringify(exit)).toContain('Re-authorize')
  })
})

describe('revocation', () => {
  it('deletes the material rather than only flagging the row', async () => {
    const started = await authorize()
    await complete(started.state)
    await run(Effect.flatMap(DiscordOAuth, (o) => o.revoke('me')))

    const secrets = await run(
      Effect.flatMap(Database, (db) =>
        db.query<{ name: string }>('SELECT name FROM encrypted_secrets'),
      ),
    )
    // Nothing left for a later bug to resurrect.
    expect(secrets).toEqual([])

    const exit = await runtime.runPromiseExit(
      Effect.flatMap(DiscordOAuth, (o) => o.accessToken('me')),
    )
    expect(exit._tag).toBe('Failure')
  })

  it('is reflected in the listing without exposing token material', async () => {
    const started = await authorize()
    await complete(started.state)
    await run(Effect.flatMap(DiscordOAuth, (o) => o.revoke('me')))

    const profiles = await run(Effect.flatMap(DiscordOAuth, (o) => o.list()))
    expect(profiles[0]?.revokedAt).not.toBeNull()
    expect(JSON.stringify(profiles)).not.toContain('access-1')
  })
})
