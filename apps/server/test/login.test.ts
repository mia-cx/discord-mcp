import { DiscordRest } from '@discord-mcp/discord-api/relay'
import { Effect, Layer } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRelay } from '../src/relay.ts'
import {
  BOT_ID,
  beginLogin,
  botToken,
  config,
  discordOAuth,
  executor,
  finishLogin,
  login,
  redeem,
} from './login-fixture.ts'

const execute = executor(() =>
  Layer.succeed(DiscordRest)({
    raw: undefined as never,
    request: () => Effect.succeed({ id: BOT_ID, bot: true }),
  }),
)
const mcp = (token?: string) =>
  new Request('https://relay.test/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'mcp-method': 'tools/list',
      'mcp-protocol-version': '2026-07-28',
      'x-discord-bot-token': botToken(),
      origin: 'https://relay.test',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    }),
  })

afterEach(() => vi.useRealTimers())

describe('Discord login for the relay', () => {
  it('advertises OAuth discovery and requires a human login in addition to a bot token', async () => {
    const oauth = discordOAuth()
    const relay = createRelay(config, execute, oauth.fetch)
    const missing = await relay.fetch(mcp())
    expect(missing.status).toBe(401)
    expect(missing.headers.get('access-control-expose-headers')).toContain('WWW-Authenticate')
    expect(missing.headers.get('access-control-allow-origin')).toBe('https://relay.test')
    const preflight = await relay.fetch(
      new Request('https://relay.test/mcp', {
        method: 'OPTIONS',
        headers: { origin: 'https://relay.test' },
      }),
    )
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-headers')).toContain('X-Discord-Bot-Token')
    expect(missing.headers.get('www-authenticate')).toContain(
      'https://relay.test/.well-known/oauth-protected-resource/mcp',
    )
    expect((await relay.fetch(mcp(botToken()))).status).toBe(401)
    expect(oauth.calls).toHaveLength(0)
    const metadata = await relay.fetch(
      new Request('https://relay.test/.well-known/oauth-protected-resource/mcp'),
    )
    expect(await metadata.json()).toMatchObject({
      resource: 'https://relay.test/mcp',
      authorization_servers: ['https://relay.test'],
    })
    const { tokens, discordUrl, params } = await login(relay)
    expect(discordUrl.searchParams.get('scope')).toBe('identify')
    expect(discordUrl.searchParams.get('code_challenge_method')).toBe('S256')
    expect(discordUrl.searchParams.get('redirect_uri')).toBe(
      'https://relay.test/auth/discord/callback',
    )
    expect(tokens.access_token).not.toContain('private-')
    expect(params.code).not.toContain('private-')
    const accepted = await relay.fetch(mcp(tokens.access_token))
    expect(accepted.status).toBe(200)
    const body = await accepted.text()
    expect(body).toContain('discord_api_read')
    expect(body).not.toContain('private-')
    expect(accepted.headers.get('mcp-session-id')).toBeNull()
    expect(accepted.headers.get('cache-control')).toBe('no-store')
  })

  it('rechecks Discord identity and revocation on every request without confusing outages with logout', async () => {
    const oauth = discordOAuth()
    const relay = createRelay(config, execute, oauth.fetch)
    const { tokens } = await login(relay)
    const before = oauth.calls.length
    expect((await relay.fetch(mcp(tokens.access_token))).status).toBe(200)
    expect((await relay.fetch(mcp(tokens.access_token))).status).toBe(200)
    expect(oauth.calls.length - before).toBe(2)
    oauth.state.revoked = true
    expect((await relay.fetch(mcp(tokens.access_token))).status).toBe(401)
    oauth.state.revoked = false
    oauth.state.applicationId = '999999999999999999'
    expect((await relay.fetch(mcp(tokens.access_token))).status).toBe(401)
    oauth.state.applicationId = config.login.clientId
    oauth.state.userId = '999999999999999999'
    expect((await relay.fetch(mcp(tokens.access_token))).status).toBe(401)
    oauth.state.userId = '234567890123456789'
    oauth.state.status = 503
    expect((await relay.fetch(mcp(tokens.access_token))).status).toBe(502)
    oauth.state.status = 429
    const limited = await relay.fetch(mcp(tokens.access_token))
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBe('1')
    expect(limited.headers.get('www-authenticate')).toBeNull()
    oauth.state.status = 200
    const tampered = `${tokens.access_token.slice(0, -10)}abcdefghij`
    expect((await relay.fetch(mcp(tampered))).status).toBe(401)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 8 * 24 * 3600_000)
    expect((await relay.fetch(mcp(tokens.access_token))).status).toBe(401)
  })

  it('allows listed humans and denies unlisted humans at login and on previously issued credentials', async () => {
    const oauth = discordOAuth()
    const unrestricted = createRelay(config, execute, oauth.fetch)
    const { tokens } = await login(unrestricted)
    const restricted = createRelay(
      { ...config, login: { ...config.login, allowedUserIds: ['345678901234567890'] } },
      execute,
      oauth.fetch,
    )
    const denied = await restricted.fetch(mcp(tokens.access_token))
    expect(denied.status).toBe(403)
    expect(await denied.json()).toMatchObject({ error: 'access_denied' })
    expect(denied.headers.get('www-authenticate')).toBeNull()
    expect(denied.headers.get('cache-control')).toBe('no-store')

    const started = await beginLogin(restricted)
    const finished = await finishLogin(restricted, started)
    expect(finished.destination.searchParams.get('error')).toBe('access_denied')
    expect(finished.destination.searchParams.has('code')).toBe(false)

    oauth.state.userId = '345678901234567890'
    const accepted = await login(restricted)
    expect((await restricted.fetch(mcp(accepted.tokens.access_token))).status).toBe(200)

    const empty = createRelay(
      { ...config, login: { ...config.login, allowedUserIds: [] } },
      execute,
      oauth.fetch,
    )
    expect((await empty.fetch(mcp(accepted.tokens.access_token))).status).toBe(403)
  })

  it('rotates refresh credentials through Discord and rejects replayed ones', async () => {
    const oauth = discordOAuth()
    const relay = createRelay(config, execute, oauth.fetch)
    const metadata = await relay.fetch(
      new Request('https://relay.test/.well-known/oauth-authorization-server'),
    )
    expect((await metadata.json()).grant_types_supported).toContain('refresh_token')
    const { tokens, clientId } = await login(relay)
    const refresh = (refresh_token: string) =>
      redeem(relay, {
        grant_type: 'refresh_token',
        refresh_token,
        client_id: clientId,
        resource: 'https://relay.test/mcp',
      })
    const rotated = await refresh(tokens.refresh_token)
    expect(rotated.status).toBe(200)
    const next = await rotated.json()
    expect(next.refresh_token).not.toBe(tokens.refresh_token)
    expect(JSON.stringify(next)).not.toContain('private-')
    expect((await relay.fetch(mcp(tokens.access_token))).status).toBe(401)
    expect((await relay.fetch(mcp(next.access_token))).status).toBe(200)
    const replayed = await refresh(tokens.refresh_token)
    expect(replayed.status).toBe(400)
    const body = await replayed.text()
    expect(JSON.parse(body).error).toBe('invalid_grant')
    expect(body).not.toContain('private-')
    // A thief's failed replay does not sign the owner out.
    expect((await refresh(next.refresh_token)).status).toBe(200)
  })

  it('binds refresh to its client, resource and allowlist, and outlives the client registration', async () => {
    const oauth = discordOAuth()
    const relay = createRelay(config, execute, oauth.fetch)
    const { tokens, clientId } = await login(relay)
    const another = await beginLogin(relay)
    const params = {
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: clientId,
      resource: 'https://relay.test/mcp',
    }
    const before = oauth.calls.length
    for (const overrides of [
      { client_id: another.clientId },
      { resource: 'https://another-relay.test/mcp' },
      { refresh_token: tokens.access_token },
    ])
      expect((await redeem(relay, { ...params, ...overrides })).status).toBe(400)
    expect(oauth.calls.length).toBe(before)

    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 20 * 24 * 3600_000)
    const first = await redeem(relay, params)
    expect(first.status).toBe(200)
    // The registration from sign-in expires on day 30.
    vi.setSystemTime(Date.now() + 15 * 24 * 3600_000)
    const second = await redeem(relay, {
      ...params,
      refresh_token: (await first.json()).refresh_token,
    })
    expect(second.status).toBe(200)

    const restricted = createRelay(
      { ...config, login: { ...config.login, allowedUserIds: ['345678901234567890'] } },
      execute,
      oauth.fetch,
    )
    const denied = await redeem(restricted, {
      ...params,
      refresh_token: (await second.json()).refresh_token,
    })
    expect(denied.status).toBe(400)
    expect(await denied.json()).toMatchObject({ error: 'invalid_grant' })
  })

  it('rejects malformed allowlist configuration instead of starting with unrestricted access', () => {
    expect(() =>
      createRelay(
        { ...config, login: { ...config.login, allowedUserIds: ['not-a-discord-user-id'] } },
        execute,
      ),
    ).toThrow('DISCORD_OAUTH_ALLOWED_USER_IDS')
  })

  it('binds authorization codes to PKCE, client, redirect and resource, single-use across replicas', async () => {
    const oauth = discordOAuth()
    const relay = createRelay(config, execute, oauth.fetch)
    const started = await beginLogin(relay)
    const { params } = await finishLogin(relay, started)
    const another = await beginLogin(relay)
    for (const overrides of [
      { code_verifier: 'x'.repeat(43) },
      { client_id: another.clientId },
      { redirect_uri: 'https://attacker.test/callback' },
      { resource: 'https://another-relay.test/mcp' },
      { code: started.clientId },
    ])
      expect((await redeem(relay, { ...params, ...overrides })).status).toBe(400)
    // Another replica, or this one after a restart, redeems the code; the first replica then
    // refuses it, because Discord rejects the refresh token the code already spent.
    const replica = createRelay(config, execute, oauth.fetch)
    expect((await redeem(replica, params)).status).toBe(200)
    const replayed = await redeem(relay, params)
    expect(replayed.status).toBe(400)
    expect(await replayed.text()).not.toContain('private-')
    const later = await finishLogin(relay, another)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 61_000)
    expect((await redeem(relay, later.params)).status).toBe(400)
  })

  it('requires browser-bound consent and rejects unsafe redirects, callback issuers and oversized bodies', async () => {
    const oauth = discordOAuth()
    const relay = createRelay(config, execute, oauth.fetch)
    const started = await beginLogin(relay)
    for (const headers of [
      { origin: 'https://relay.test' },
      { cookie: 'wrong=nonce', origin: 'https://relay.test' },
      { cookie: started.cookie, origin: 'https://attacker.test' },
    ])
      expect(
        (
          await relay.fetch(
            new Request('https://relay.test/authorize', {
              method: 'POST',
              headers,
              body: new URLSearchParams({ flow: started.flow, decision: 'allow' }),
            }),
          )
        ).status,
      ).toBe(400)
    const denied = await relay.fetch(
      new Request('https://relay.test/authorize', {
        method: 'POST',
        headers: { cookie: started.cookie, origin: 'https://relay.test' },
        body: new URLSearchParams({ flow: started.flow, decision: 'deny' }),
      }),
    )
    expect(denied.status).toBe(302)
    expect(new URL(denied.headers.get('location') ?? '').searchParams.get('error')).toBe(
      'access_denied',
    )
    const callback = new URL('https://relay.test/auth/discord/callback')
    callback.search = new URLSearchParams({
      state: started.flow,
      code: 'code',
      iss: 'https://attacker.test',
    }).toString()
    expect(
      (await relay.fetch(new Request(callback, { headers: { cookie: started.cookie } }))).status,
    ).toBe(400)
    callback.searchParams.set('iss', 'https://discord.com')
    expect((await relay.fetch(new Request(callback))).status).toBe(400)
    for (const redirect of ['https://attacker.test/callback', 'http://remote.test/callback']) {
      const authorize = new URL(started.authorize)
      authorize.searchParams.set('redirect_uri', redirect)
      expect((await relay.fetch(new Request(authorize))).status).toBe(400)
    }
    expect(oauth.calls).toHaveLength(0)
    const tooLarge = await relay.fetch(
      new Request('https://relay.test/register', { method: 'POST', body: 'x'.repeat(16_385) }),
    )
    expect(tooLarge.status).toBe(400)
  })
})
