import { createHash } from 'node:crypto'
import { Redacted } from 'effect'
import { expect } from 'vitest'
import type { RelayConfig } from '../src/relay.ts'

export const config: RelayConfig = {
  allowedHosts: ['relay.test'],
  allowedOrigins: ['https://relay.test'],
  rest: { timeoutMs: 1000, retries: 0, maxRateLimitWaitMs: 1000 },
  login: {
    publicBaseUrl: 'https://relay.test',
    clientId: '123456789012345678',
    clientSecret: Redacted.make('test-client-secret'),
    encryptionKey: Redacted.make(Buffer.alloc(32, 7).toString('base64')),
  },
}

/** Fake only Discord's external OAuth endpoints; the issuer, crypto, browser checks and MCP are real. */
export const discordOAuth = () => {
  const state = {
    revoked: false,
    applicationId: config.login.clientId,
    userId: '234567890123456789',
    status: 200,
  }
  const calls: Array<{ path: string; init: RequestInit | undefined }> = []
  const network: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname
    calls.push({ path, init })
    if (state.revoked) return Response.json({ error: 'invalid_token' }, { status: 401 })
    if (state.status !== 200) return Response.json({}, { status: state.status })
    if (path.endsWith('/oauth2/token'))
      return Response.json({
        access_token: 'private-discord-user-access',
        refresh_token: 'private-discord-user-refresh',
        token_type: 'Bearer',
        scope: 'identify',
        expires_in: 604800,
      })
    if (path.endsWith('/oauth2/@me'))
      return Response.json({
        application: { id: state.applicationId },
        user: { id: state.userId },
        scopes: ['identify'],
        expires: new Date(Date.now() + 604800_000).toISOString(),
      })
    throw new Error(`Unexpected Discord request: ${path}`)
  }
  return { state, calls, fetch: network }
}

type Relay = { fetch: (request: Request) => Promise<Response> }
export const beginLogin = async (relay: Relay) => {
  const redirect = 'http://127.0.0.1:45678/callback'
  const registered = await relay.fetch(
    new Request('https://relay.test/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Test MCP client',
        redirect_uris: [redirect],
        grant_types: ['authorization_code', 'refresh_token'],
      }),
    }),
  )
  expect(registered.status).toBe(201)
  const clientId: string = (await registered.json()).client_id
  const verifier = 'v'.repeat(43)
  const authorize = new URL('https://relay.test/authorize')
  authorize.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirect,
    response_type: 'code',
    code_challenge_method: 'S256',
    scope: 'mcp',
    resource: 'https://relay.test/mcp',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    state: 'client-state',
  }).toString()
  const consent = await relay.fetch(new Request(authorize))
  expect(consent.status).toBe(200)
  const cookie = consent.headers.get('set-cookie')?.split(';')[0] ?? ''
  const html = await consent.text()
  const flow = /name="flow" value="([^"]+)"/.exec(html)?.[1] ?? ''
  return { clientId, verifier, redirect, cookie, flow, authorize, html }
}

export const finishLogin = async (
  relay: Relay,
  started: Awaited<ReturnType<typeof beginLogin>>,
) => {
  const consent = await relay.fetch(
    new Request('https://relay.test/authorize', {
      method: 'POST',
      headers: { cookie: started.cookie, origin: 'https://relay.test' },
      body: new URLSearchParams({ flow: started.flow, decision: 'allow' }),
    }),
  )
  expect(consent.status).toBe(302)
  const discordUrl = new URL(consent.headers.get('location') ?? '')
  const callback = new URL('https://relay.test/auth/discord/callback')
  callback.search = new URLSearchParams({
    state: discordUrl.searchParams.get('state') ?? '',
    code: 'discord-single-use-code',
    iss: 'https://discord.com',
  }).toString()
  const completed = await relay.fetch(
    new Request(callback, { headers: { cookie: started.cookie } }),
  )
  expect(completed.status).toBe(302)
  const destination = new URL(completed.headers.get('location') ?? '')
  expect(destination.searchParams.get('state')).toBe('client-state')
  expect(destination.searchParams.get('iss')).toBe('https://relay.test')
  const params = {
    grant_type: 'authorization_code',
    code: destination.searchParams.get('code') ?? '',
    code_verifier: started.verifier,
    client_id: started.clientId,
    redirect_uri: started.redirect,
    resource: 'https://relay.test/mcp',
  }
  return { params, discordUrl, callback }
}

export const redeem = (relay: Relay, params: Record<string, string>) =>
  relay.fetch(
    new Request('https://relay.test/token', {
      method: 'POST',
      body: new URLSearchParams(params),
    }),
  )

export const login = async (relay: Relay) => {
  const started = await beginLogin(relay)
  const finished = await finishLogin(relay, started)
  const response = await redeem(relay, finished.params)
  expect(response.status).toBe(200)
  const tokens: { access_token: string } = await response.json()
  return { ...started, ...finished, tokens }
}
