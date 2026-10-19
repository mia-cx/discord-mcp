import { DiscordApiError, DiscordRateLimitError } from '@discord-mcp/core'
import { DiscordRest } from '@discord-mcp/discord-api'
import { Effect, Layer, Redacted } from 'effect'
import { describe, expect, it } from 'vitest'
import { createRelay, type RelayConfig } from '../src/relay.ts'

const config: RelayConfig = {
  allowedHosts: ['relay.test'],
  allowedOrigins: ['https://relay.test'],
  rest: { timeoutMs: 1000, retries: 0, maxRateLimitWaitMs: 1000 },
}

const envelope = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': {},
}

const request = (
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
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
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
    const relay = createRelay(config, (credential) => {
      const token = Redacted.value(credential)
      const bot = token === 'private-token-a' ? 'bot-a' : 'bot-b'
      return Layer.succeed(DiscordRest)({
        raw: undefined as never,
        request: (call) =>
          Effect.promise(async () => {
            calls.push({ token, route: call.route })
            await Promise.resolve()
            return call.route === '/users/@me' ? { id: bot, bot: true } : { actor: bot }
          }),
      })
    })

    const responses = await Promise.all(
      ['private-token-a', 'private-token-b', 'private-token-a'].map((token) =>
        relay.fetch(request(token)),
      ),
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
    ).toEqual(expect.arrayContaining(['private-token-a', 'private-token-b', 'private-token-a']))
    for (const response of responses) {
      expect(response.headers.get('mcp-session-id')).toBeNull()
      expect(response.headers.get('cache-control')).toBe('no-store')
    }
    expect(JSON.stringify(results)).not.toContain('private-token')

    const mutation = await relay.fetch(
      request(
        'private-token-b',
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
      token: 'private-token-b',
      route: '/channels/123456789012345678/typing',
    })
  })

  it('rejects missing, invalid, non-bot, and subsequently revoked credentials', async () => {
    let revoked = false
    let calls = 0
    const relay = createRelay(config, (credential) =>
      Layer.succeed(DiscordRest)({
        raw: undefined as never,
        request: () => {
          calls++
          const token = Redacted.value(credential)
          if (token === 'invalid' || revoked) {
            return Effect.fail(
              new DiscordApiError({
                message: 'Unauthorized',
                httpStatus: 401,
                retryable: false,
                issues: [],
              }),
            )
          }
          return Effect.succeed({ id: 'bot-a', bot: token !== 'user-token' })
        },
      }),
    )

    expect((await relay.fetch(request())).status).toBe(401)
    expect(calls).toBe(0)
    expect((await relay.fetch(request('invalid'))).status).toBe(401)
    expect((await relay.fetch(request('user-token'))).status).toBe(401)
    expect((await relay.fetch(request('valid', 'tools/list'))).status).toBe(200)
    revoked = true
    expect((await relay.fetch(request('valid', 'tools/list'))).status).toBe(401)
    expect(calls).toBe(4)
  })

  it('reports a Discord rate limit without treating the token as invalid', async () => {
    const relay = createRelay(config, () =>
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
    )
    const response = await relay.fetch(request('valid'))
    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBe('2')
    expect(response.headers.get('www-authenticate')).toBeNull()
  })
})
