import { once } from 'node:events'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createBotRuntimes, createTokenVault } from '@discord-mcp/bot-host'
import {
  DAVE_MAGIC_MARKER,
  FAKE_VOICE_CHANNEL_ID,
  fakeGateway,
  fakeVoiceServer,
  manualClock,
} from '@discord-mcp/bot-host/testing'
import { DiscordRest } from '@discord-mcp/discord-api'
import { inMemoryStorage } from '@discord-mcp/storage/testing'
import { Effect, Layer } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { createRelay } from '../src/relay.ts'
import { config, discordOAuth, login } from './login-fixture.ts'

const BOT_ID = '345678901234567890'
const GUILD_ID = '456789012345678901'
const TOKEN = 'private-bot-token'
const SILENCE = Buffer.from([0xf8, 0xff, 0xfe])

const cleanup: Array<() => unknown> = []
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})

/** The relay with bot hosting on fake Discord, its voice WebSocket on a local port. */
const start = async () => {
  const storage = await inMemoryStorage()
  const voiceServer = await fakeVoiceServer()
  const gateway = await fakeGateway(undefined, { botId: BOT_ID, endpoint: voiceServer.endpoint })
  const bots = createBotRuntimes({
    vault: createTokenVault(Buffer.alloc(32, 1), storage),
    clock: manualClock(),
    log: () => {},
    gatewayUrl: gateway.url,
  })
  const relay = createRelay(
    { ...config, allowedHosts: [] },
    () =>
      Layer.succeed(DiscordRest)({
        raw: undefined as never,
        request: () => Effect.succeed({ id: BOT_ID, bot: true }),
      }),
    discordOAuth().fetch,
    bots,
  )
  const server = createServer()
  server.on('upgrade', relay.upgrade)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  cleanup.push(storage.close, voiceServer.close, gateway.close, bots.close, () => server.close())
  const { tokens } = await login(relay)
  const headers = { authorization: `Bearer ${tokens.access_token}`, 'x-discord-bot-token': TOKEN }

  const callTool = async (name: string, args: Record<string, unknown>) => {
    const response = await relay.fetch(
      new Request('https://relay.test/mcp', {
        method: 'POST',
        headers: {
          ...headers,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-method': 'tools/call',
          'mcp-name': name,
          'mcp-protocol-version': '2026-07-28',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name,
            arguments: args,
            _meta: {
              'io.modelcontextprotocol/protocolVersion': '2026-07-28',
              'io.modelcontextprotocol/clientCapabilities': {},
            },
          },
        }),
      }),
    )
    return (await response.json()).result.structuredContent
  }

  /** Open the voice socket the way an agent does; resolves with the socket or the refusal. */
  const openSocket = (query: string, socketHeaders: Record<string, string> = headers) =>
    new Promise<WebSocket | number>((resolve) => {
      const { port } = server.address() as AddressInfo
      const socket = new WebSocket(`ws://127.0.0.1:${port}/voice?${query}`, {
        headers: socketHeaders,
      })
      socket.on('open', () => resolve(socket))
      socket.on('unexpected-response', (_, response) => resolve(response.statusCode ?? 0))
      socket.on('error', () => {})
      cleanup.push(() => socket.terminate())
    })

  return { callTool, openSocket, voiceServer }
}

describe('the voice socket', () => {
  it('plays the audio an agent streams after joining, until the bot leaves', async () => {
    const { callTool, openSocket, voiceServer } = await start()
    const joined = await callTool('discord_voice_join', {
      guildId: GUILD_ID,
      channelId: FAKE_VOICE_CHANNEL_ID,
    })
    expect(joined.data).toEqual({ socket: `wss://relay.test/voice?guild_id=${GUILD_ID}` })
    await vi.waitFor(() =>
      expect(voiceServer.received).toContainEqual({ op: 23, d: { transition_id: 1 } }),
    )

    const socket = await openSocket(`guild_id=${GUILD_ID}&codec=opus`)
    if (typeof socket === 'number') throw new Error(`refused with ${socket}`)
    for (let index = 0; index < 5; index++) socket.send(Buffer.from([0xfc, 0xff, 0xfe, index]))
    await vi.waitFor(() =>
      expect(voiceServer.packets.filter((packet) => !packet.equals(SILENCE))).toHaveLength(5),
    )
    for (const packet of voiceServer.packets.filter((packet) => !packet.equals(SILENCE))) {
      expect(packet.subarray(-2)).toEqual(DAVE_MAGIC_MARKER)
    }

    const closed = once(socket, 'close')
    expect((await callTool('discord_voice_leave', { guildId: GUILD_ID })).data).toEqual({
      left: true,
    })
    expect(((await closed) as [number])[0]).toBe(1000)
  })

  it('refuses a socket without credentials, before joining, or with an unknown codec', async () => {
    const { callTool, openSocket } = await start()
    expect(await openSocket(`guild_id=${GUILD_ID}&codec=opus`, {})).toBe(401)
    expect(await openSocket(`guild_id=${GUILD_ID}&codec=opus`)).toBe(409)

    await callTool('discord_voice_join', { guildId: GUILD_ID, channelId: FAKE_VOICE_CHANNEL_ID })
    expect(await openSocket(`guild_id=${GUILD_ID}&codec=mp3`)).toBe(400)
    expect(await openSocket(`guild_id=${GUILD_ID}&codec=pcm16&sample_rate=24000`)).toBeInstanceOf(
      WebSocket,
    )
  })
})
