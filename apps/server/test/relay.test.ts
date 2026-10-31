import { DiscordApiError, DiscordRateLimitError } from '@discord-mcp/core'
import { DEFAULT_FAILURE_THRESHOLD, DiscordRest } from '@discord-mcp/discord-api'
import { Effect, Layer, Redacted } from 'effect'
import { describe, expect, it } from 'vitest'
import { createRelay } from '../src/relay.ts'
import { BOT_ID, botToken, config, discordOAuth, executor, login } from './login-fixture.ts'

const BOT_B = '456789012345678901'
const TOKEN_A = botToken(BOT_ID, 'private-token-a')
const TOKEN_B = botToken(BOT_B, 'private-token-b')

const envelope = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': {},
}

const request = (
  accessToken: string,
  token?: string,
  method = 'tools/call',
  args: Record<string, unknown> = {},
  tool = 'discord_api_read',
) =>
  new Request('https://relay.test/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-method': method,
      'mcp-protocol-version': '2026-07-28',
      ...(method === 'tools/call' ? { 'mcp-name': tool } : {}),
      authorization: `Bearer ${accessToken}`,
      ...(token === undefined ? {} : { 'x-discord-bot-token': token }),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params: {
        _meta: envelope,
        ...(method === 'tools/call'
          ? {
              name: tool,
              arguments: {
                operationId: 'get_guild',
                path: { guild_id: '123456789012345678' },
                ...args,
              },
            }
          : {}),
      },
    }),
  })

describe('the stateless Discord relay', () => {
  it('validates every request and keeps concurrent callers on their own bot', async () => {
    const calls: Array<{ token: string; route: string }> = []
    const oauth = discordOAuth()
    const relay = createRelay(
      config,
      executor((credential) => {
        const token = Redacted.value(credential)
        const [id, actor] = token === TOKEN_A ? [BOT_ID, 'bot-a'] : [BOT_B, 'bot-b']
        return Layer.succeed(DiscordRest)({
          raw: undefined as never,
          request: (call) =>
            Effect.promise(async () => {
              calls.push({ token, route: call.route })
              await Promise.resolve()
              return call.route === '/users/@me' ? { id, bot: true } : { actor }
            }),
        })
      }),
      oauth.fetch,
    )
    const { tokens } = await login(relay)

    const responses = await Promise.all(
      [TOKEN_A, TOKEN_B, TOKEN_A].map((token) => relay.fetch(request(tokens.access_token, token))),
    )
    const results = await Promise.all(responses.map((response) => response.json()))

    expect(results.map((result) => result.result.structuredContent.data.actor)).toEqual([
      'bot-a',
      'bot-b',
      'bot-a',
    ])
    expect(calls.filter((call) => call.route === '/users/@me')).toHaveLength(3)
    expect(
      calls.filter((call) => call.route.startsWith('/guilds/')).map((call) => call.token),
    ).toEqual(expect.arrayContaining([TOKEN_A, TOKEN_B, TOKEN_A]))
    for (const response of responses) {
      expect(response.headers.get('mcp-session-id')).toBeNull()
      expect(response.headers.get('cache-control')).toBe('no-store')
    }
    expect(JSON.stringify(results)).not.toContain('private-token')

    const mutation = await relay.fetch(
      request(
        tokens.access_token,
        TOKEN_B,
        'tools/call',
        {
          operationId: 'trigger_typing_indicator',
          path: { channel_id: '123456789012345678' },
        },
        'discord_api_write',
      ),
    )
    expect((await mutation.json()).result.structuredContent.data.actor).toBe('bot-b')
    expect(calls.at(-1)).toEqual({
      token: TOKEN_B,
      route: '/channels/123456789012345678/typing',
    })
  })

  it('rejects missing, malformed, invalid, non-bot, misnamed, and subsequently revoked credentials', async () => {
    let revoked = false
    let calls = 0
    const oauth = discordOAuth()
    const relay = createRelay(
      config,
      executor((credential) =>
        Layer.succeed(DiscordRest)({
          raw: undefined as never,
          request: () => {
            calls++
            const token = Redacted.value(credential)
            if (token === botToken(BOT_ID, 'invalid') || revoked) {
              return Effect.fail(
                new DiscordApiError({
                  message: 'Unauthorized',
                  httpStatus: 401,
                  retryable: false,
                  issues: [],
                }),
              )
            }
            // Discord names the bot the token really belongs to, whatever its first segment says.
            return Effect.succeed({ id: BOT_ID, bot: token !== botToken(BOT_ID, 'user-token') })
          },
        }),
      ),
      oauth.fetch,
    )
    const { tokens } = await login(relay)

    expect((await relay.fetch(request(tokens.access_token))).status).toBe(403)
    expect(calls).toBe(0)
    expect((await relay.fetch(request(tokens.access_token, 'not-a-bot-token'))).status).toBe(403)
    expect(calls).toBe(0)
    for (const token of [
      botToken(BOT_ID, 'invalid'),
      botToken(BOT_ID, 'user-token'),
      botToken(BOT_B, 'misnamed'),
    ]) {
      expect((await relay.fetch(request(tokens.access_token, token))).status).toBe(403)
    }
    const valid = botToken()
    expect((await relay.fetch(request(tokens.access_token, valid, 'tools/list'))).status).toBe(200)
    revoked = true
    expect((await relay.fetch(request(tokens.access_token, valid, 'tools/list'))).status).toBe(403)
    expect(calls).toBe(5)
  })

  it('reports a Discord rate limit without treating the token as invalid', async () => {
    const oauth = discordOAuth()
    const relay = createRelay(
      config,
      executor(() =>
        Layer.succeed(DiscordRest)({
          raw: undefined as never,
          request: () =>
            Effect.fail(
              new DiscordRateLimitError({
                message: 'Rate limited',
                retryAfterMs: 2000,
                global: true,
              }),
            ),
        }),
      ),
      oauth.fetch,
    )
    const { tokens } = await login(relay)
    const response = await relay.fetch(request(tokens.access_token, botToken()))
    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBe('2')
    expect(response.headers.get('www-authenticate')).toBeNull()
  })

  it("keeps forged tokens naming a bot from tripping that bot's rejection guard", async () => {
    const real = botToken()
    const discord: typeof fetch = async (_input, init) =>
      new Headers(init?.headers).get('authorization') === `Bot ${real}`
        ? Response.json({ id: BOT_ID, bot: true })
        : Response.json({ message: '401: Unauthorized', code: 0 }, { status: 401 })
    const oauth = discordOAuth()
    const relay = createRelay(config, executor(undefined, { discordFetch: discord }), oauth.fetch)
    const { tokens } = await login(relay)
    const list = (token: string) => request(tokens.access_token, token, 'tools/list')

    for (let forged = 0; forged < DEFAULT_FAILURE_THRESHOLD + 5; forged++) {
      expect((await relay.fetch(list(botToken(BOT_ID, `forged-${forged}`)))).status).toBe(403)
    }
    expect((await relay.fetch(list(real))).status).toBe(200)
  })
})
