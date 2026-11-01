import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { DiscordRest } from '@discord-mcp/discord-api'
import { Effect, Layer, Redacted } from 'effect'
import { describe, expect, it } from 'vitest'
import { createRelay } from '../src/relay.ts'
import { botToken, config, discordOAuth, executor, login } from './login-fixture.ts'

const GUILD = '223456789012345678'
const CHANNEL = '123456789012345678'
const BOT = { id: '345678901234567890', username: 'textile', discriminator: '0', bot: true }
const TOKEN = botToken(BOT.id, 'private-token-a')

/** Fakes Discord behind the relay's REST seam, recording which token each call carried. */
const relayWithFakeDiscord = () => {
  const calls: Array<{ token: string; method: string; route: string; body?: unknown }> = []
  let messages = 0
  const oauth = discordOAuth()
  const relay = createRelay(
    { ...config, login: { ...config.login, allowedUserIds: [oauth.state.userId] } },
    executor(
      (credential) =>
        Layer.succeed(DiscordRest)({
          raw: undefined as never,
          request: (call) =>
            Effect.sync(() => {
              calls.push({
                token: Redacted.value(credential),
                method: call.method,
                route: call.route,
                ...(call.body === undefined ? {} : { body: call.body }),
              })
              if (call.route === '/users/@me') return BOT
              if (call.method === 'GET')
                return { id: CHANNEL, type: 0, name: 'general', guild_id: GUILD }
              messages += 1
              return {
                id: String(900000000000000000n + BigInt(messages)),
                channel_id: CHANNEL,
                author: BOT,
                content: '',
                timestamp: '2026-10-31T00:00:00.000Z',
                edited_timestamp: null,
                tts: false,
                mention_everyone: false,
                mentions: [],
                mention_roles: [],
                attachments: [],
                embeds: [],
                pinned: false,
                type: 0,
              }
            }),
        }),
      { scripts: true },
    ),
    oauth.fetch,
  )
  return { relay, calls }
}

const runScript = async (
  relay: ReturnType<typeof relayWithFakeDiscord>['relay'],
  args: Record<string, unknown>,
) => {
  const { tokens } = await login(relay)
  const response = await relay.fetch(
    new Request('https://relay.test/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-method': 'tools/call',
        'mcp-name': 'discord_script_run',
        'mcp-protocol-version': '2026-07-28',
        authorization: `Bearer ${tokens.access_token}`,
        'x-discord-bot-token': TOKEN,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientCapabilities': {},
          },
          name: 'discord_script_run',
          arguments: args,
        },
      }),
    }),
  )
  return (await response.json()).result.structuredContent.data
}

describe('discord_script_run', () => {
  it('runs a discord.js script whose many calls each pass the grants, without the token', async () => {
    const { relay, calls } = relayWithFakeDiscord()

    const run = await runScript(relay, {
      source: `
        import { EmbedBuilder } from 'discord.js'
        export default async ({ client }) => {
          const channel = await client.channels.fetch('${CHANNEL}')
          const sent = []
          for (let i = 0; i < 20; i++) {
            const embed = new EmbedBuilder().setTitle('Report ' + i)
            sent.push((await channel.send({ embeds: [embed] })).id)
          }
          await channel.messages.react(sent[1], '👍')
          await channel.messages.delete(sent[0]).catch((error) => console.log(error.status))
          return { channel: channel.name, sent: sent.length, me: client.user.username, token: client.token, env: process.env }
        }`,
      grants: { families: ['channel', 'message'] },
    })

    expect(run.outcome).toBe('completed')
    expect(run.result).toMatchObject({ channel: 'general', sent: 20, me: 'textile' })
    expect(run.logs).toEqual(['403'])
    expect(run.denied).toEqual([
      expect.objectContaining({
        method: 'DELETE',
        reason: expect.stringContaining('delete_message is a destructive operation'),
      }),
    ])
    const replayed = calls.filter((call) => call.route.startsWith('/channels/'))
    expect(replayed).toHaveLength(22)
    expect(replayed.every((call) => call.token === TOKEN)).toBe(true)
    expect(replayed.some((call) => call.method === 'DELETE')).toBe(false)
    expect(replayed[1]?.body).toMatchObject({ embeds: [{ title: 'Report 0' }] })
    // A bodyless write reaches Discord with no body.
    expect(replayed.at(-1)).toEqual({
      token: TOKEN,
      method: 'PUT',
      route: expect.stringMatching(/\/reactions\/%F0%9F%91%8D\/@me$/),
    })
    expect(JSON.stringify(run)).not.toContain('private-token')
  })

  it('never lets fetch() reach private, loopback, or link-local addresses', async () => {
    const hits: string[] = []
    const inside = createServer((request, response) => {
      hits.push(request.url ?? '')
      response.end('inside')
    })
    await new Promise<void>((resolve) => inside.listen(0, '127.0.0.1', resolve))
    const port = (inside.address() as AddressInfo).port
    const { relay } = relayWithFakeDiscord()

    try {
      const run = await runScript(relay, {
        source: `
          export default async () => Promise.all([
            'http://127.0.0.1:${port}/',
            'http://localhost:${port}/',
            'http://10.0.0.1/',
            'http://169.254.169.254/latest/meta-data/',
            'http://example.org/',
          ].map((url) => fetch(url).then((response) => response.status)))`,
        grants: { hosts: ['127.0.0.1', 'localhost', '10.0.0.1', '169.254.169.254'] },
      })

      expect(run.result).toEqual([403, 403, 403, 403, 403])
      expect(run.denied.map((denial: { reason: string }) => denial.reason)).toEqual(
        expect.arrayContaining([
          expect.stringContaining('127.0.0.1, which is not a public address'),
          expect.stringContaining('Host example.org is not granted'),
        ]),
      )
      expect(hits).toEqual([])
    } finally {
      inside.close()
    }
  })
})
