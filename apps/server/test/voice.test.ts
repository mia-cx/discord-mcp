import { once } from 'node:events'
import { createServer, type IncomingMessage } from 'node:http'
import { type AddressInfo, connect } from 'node:net'
import type { Duplex } from 'node:stream'
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
import { toNodeHandler } from '@modelcontextprotocol/node'
import { Effect, Layer } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import { createRelay, createTokenCheck } from '../src/relay.ts'
import { createBotHost, forwardToBotHosts, forwardVoiceToBotHosts } from '../src/tiers.ts'
import { createVoiceUpgrade } from '../src/voice.ts'
import { BOT_ID, botToken, config, discordOAuth, executor, login } from './login-fixture.ts'

const GUILD_ID = '456789012345678901'
const TOKEN = botToken()
const SECRET = 'test-bot-host-secret-0123456789abcdef'
const SILENCE = Buffer.from([0xf8, 0xff, 0xfe])

const cleanup: Array<() => unknown> = []
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})

interface Tier {
  readonly fetch: (request: Request) => Promise<Response>
  readonly upgrade: (request: IncomingMessage, socket: Duplex, head: Buffer) => void
}

/** A local port that serves a tier's requests and upgrades, as the server binary does. */
const serve = async () => {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  cleanup.push(
    () => server.closeAllConnections(),
    () => server.close(),
  )
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    port: (server.address() as AddressInfo).port,
    use: (tier: Tier) => {
      const handle = toNodeHandler(tier)
      server.on('request', (request, response) => {
        void handle(
          {
            method: request.method ?? 'GET',
            url: request.url ?? '/',
            headers: request.headers,
            [Symbol.asyncIterator]: () => request[Symbol.asyncIterator](),
          },
          response,
        )
      })
      server.on('upgrade', tier.upgrade)
    },
  }
}

/**
 * Central in front of the one bot host that owns the bot, each on a local port, with bot hosting
 * on fake Discord. Agents reach only central.
 */
const start = async () => {
  const storage = await inMemoryStorage()
  const voiceServer = await fakeVoiceServer()
  const gateway = await fakeGateway(undefined, { botId: BOT_ID, endpoint: voiceServer.endpoint })
  const bots = createBotRuntimes({
    vault: createTokenVault(Buffer.alloc(32, 1), storage),
    storage,
    clock: manualClock(),
    log: () => {},
    self: 'bot-host-0',
    discordFetch: gateway.discordFetch(),
  })
  cleanup.push(storage.close, voiceServer.close, gateway.close, bots.close)
  const restLayer = () =>
    Layer.succeed(DiscordRest)({
      raw: undefined as never,
      request: () => Effect.succeed({ id: BOT_ID, bot: true }),
    })
  const rest = { timeoutMs: 1000, retries: 0, maxRateLimitWaitMs: 1000 }

  const host = await serve()
  const members = { hosts: [host.url], secret: SECRET }
  host.use(
    createBotHost({ ...members, self: host.url }, executor(restLayer, { bots }), {
      bots,
      upgrade: createVoiceUpgrade({ bots, checkToken: createTokenCheck({ rest, restLayer }) }),
    }),
  )
  const central = await serve()
  const relay = createRelay(
    { ...config, allowedHosts: [] },
    forwardToBotHosts(members),
    discordOAuth().fetch,
    { upgrade: forwardVoiceToBotHosts(members) },
  )
  central.use(relay)
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
      const socket = new WebSocket(`ws://127.0.0.1:${central.port}/voice?${query}`, {
        headers: socketHeaders,
      })
      socket.on('open', () => resolve(socket))
      socket.on('unexpected-response', (_, response) => resolve(response.statusCode ?? 0))
      socket.on('error', () => {})
      cleanup.push(() => socket.terminate())
    })

  /** Send a raw upgrade request that no URL can hold to a tier; resolves when it ends. */
  const upgradeMalformed = async (port: number, target: string, hostHeader: string) => {
    const socket = connect(port, '127.0.0.1')
    await once(socket, 'connect')
    socket.end(
      `GET ${target} HTTP/1.1\r\nHost: ${hostHeader}\r\nConnection: Upgrade\r\n` +
        'Upgrade: websocket\r\nSec-WebSocket-Version: 13\r\n' +
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n',
    )
    socket.resume()
    await once(socket, 'close')
  }
  const upgradeWithBadUrls = async () => {
    await upgradeMalformed(central.port, '/voice', '[')
    await upgradeMalformed(host.port, '//[', 'localhost')
  }

  return { callTool, openSocket, upgradeWithBadUrls, voiceServer }
}

describe('the voice socket', () => {
  it('plays audio streamed through central after joining, until the bot leaves', async () => {
    const { callTool, openSocket, voiceServer } = await start()
    const joined = await callTool('discord_voice_join', {
      guildId: GUILD_ID,
      channelId: FAKE_VOICE_CHANNEL_ID,
    })
    expect(joined.data).toEqual({ socket: `/voice?guild_id=${GUILD_ID}` })
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
    const { callTool, openSocket, upgradeWithBadUrls } = await start()
    // Neither tier may crash on them, so the requests below still get answers.
    await upgradeWithBadUrls()
    expect(await openSocket(`guild_id=${GUILD_ID}&codec=opus`, {})).toBe(401)
    expect(await openSocket(`guild_id=${GUILD_ID}&codec=opus`)).toBe(409)

    await callTool('discord_voice_join', { guildId: GUILD_ID, channelId: FAKE_VOICE_CHANNEL_ID })
    expect(await openSocket(`guild_id=${GUILD_ID}&codec=mp3`)).toBe(400)
    expect(await openSocket(`guild_id=${GUILD_ID}&codec=pcm16&sample_rate=24000`)).toBeInstanceOf(
      WebSocket,
    )
  })

  it('takes the host side down when an agent leaves while the host is still admitting it', async () => {
    // A bot host that holds the handshake until told to finish it.
    const sockets = new WebSocketServer({ noServer: true })
    let finish = () => {}
    const finished = new Promise<void>((resolve) => {
      finish = resolve
    })
    let admitting = false
    const host = createServer()
    // Both stubs listen for socket errors, as the server binary's handlers do.
    host.on('upgrade', (request, socket, head) => {
      socket.on('error', () => {})
      admitting = true
      void finished.then(() => sockets.handleUpgrade(request, socket, head, () => {}))
    })
    host.listen(0, '127.0.0.1')
    await once(host, 'listening')
    const forward = forwardVoiceToBotHosts({
      hosts: [`http://127.0.0.1:${(host.address() as AddressInfo).port}`],
      secret: SECRET,
    })
    const central = createServer()
    central.on('upgrade', (request, socket, head) => {
      socket.on('error', () => {})
      forward(request, socket, head, TOKEN, BOT_ID)
    })
    central.listen(0, '127.0.0.1')
    await once(central, 'listening')
    cleanup.push(
      () => new Promise((resolve) => central.close(resolve)),
      () => {
        for (const client of sockets.clients) client.terminate()
        host.closeAllConnections()
        return new Promise((resolve) => host.close(resolve))
      },
    )

    // The agent's connection resets, so central sees it close without an end.
    const agent = connect((central.address() as AddressInfo).port, '127.0.0.1')
    agent.on('error', () => {})
    await once(agent, 'connect')
    agent.write(
      `GET /voice?guild_id=${GUILD_ID}&codec=opus HTTP/1.1\r\nHost: localhost\r\n` +
        'Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\n' +
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n',
    )
    await vi.waitFor(() => expect(admitting).toBe(true))
    agent.resetAndDestroy()
    await new Promise((resolve) => setTimeout(resolve, 100))
    finish()
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(sockets.clients.size).toBe(0)
  })
})
