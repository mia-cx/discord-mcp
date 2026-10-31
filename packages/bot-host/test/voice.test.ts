import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { inMemoryStorage } from '@discord-mcp/storage/testing'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import { createBotRuntimes } from '../src/runtimes.ts'
import {
  DAVE_MAGIC_MARKER,
  FAKE_VOICE_CHANNEL_ID,
  fakeGateway,
  fakeVoiceServer,
  manualClock,
} from '../src/testing.ts'
import { createTokenVault } from '../src/vault.ts'
import { JOIN_TIMEOUT_MS, parseAudioFormat } from '../src/voice.ts'

const BOT_ID = '345678901234567890'
const GUILD_ID = '234567890123456789'
const TOKEN = 'private-bot-token'
const HOUR = 60 * 60 * 1000
const SILENCE = Buffer.from([0xf8, 0xff, 0xfe])

const cleanup: Array<() => unknown> = []
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})

/** A bot online on a fake Gateway that routes voice joins to a fake voice server. */
const start = async ({ heartbeatIntervalMs = 41_250, answersVoice = true } = {}) => {
  const storage = await inMemoryStorage()
  const voiceServer = await fakeVoiceServer()
  const gateway = await fakeGateway(
    heartbeatIntervalMs,
    answersVoice ? { botId: BOT_ID, endpoint: voiceServer.endpoint } : undefined,
  )
  const clock = manualClock()
  const vault = createTokenVault(Buffer.alloc(32, 1), storage)
  const bots = createBotRuntimes({
    vault,
    clock,
    log: () => {},
    gatewayUrl: gateway.url,
  })
  cleanup.push(storage.close, voiceServer.close, gateway.close, bots.close)
  await bots.use(BOT_ID, TOKEN)
  const voice = bots.voice(BOT_ID)
  if (voice === undefined) throw new Error('the bot is not running')
  return { bots, vault, voice, voiceServer, gateway, clock }
}

/** An agent's WebSocket and the server side of it, which the bot host takes over. */
const agentSocket = async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await once(server, 'listening')
  const accepted = once(server, 'connection')
  const agent = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`)
  const [socket] = (await accepted) as [WebSocket]
  await once(agent, 'open')
  cleanup.push(
    () =>
      new Promise((resolve) => {
        for (const client of server.clients) client.terminate()
        server.close(resolve)
      }),
  )
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    agent.on('close', (code, reason) => resolve({ code, reason: String(reason) })),
  )
  return { agent, socket, closed }
}

const daveReady = (voiceServer: Awaited<ReturnType<typeof fakeVoiceServer>>) =>
  vi.waitFor(() => expect(voiceServer.received).toContainEqual({ op: 23, d: { transition_id: 1 } }))

/** Audio plays in real time, so this waits for as long as the longest clip. */
const stoppedSpeaking = (voiceServer: Awaited<ReturnType<typeof fakeVoiceServer>>) =>
  vi.waitFor(
    () =>
      expect(voiceServer.received).toContainEqual(
        expect.objectContaining({ op: 5, d: expect.objectContaining({ speaking: 0 }) }),
      ),
    { timeout: 5_000 },
  )

describe('voice', () => {
  it("plays an agent's Opus packets end-to-end encrypted, then stops speaking", async () => {
    const { voice, voiceServer, gateway } = await start()
    // Called before the bot is online: the join waits for it.
    await voice.join(GUILD_ID, FAKE_VOICE_CHANNEL_ID)
    expect(gateway.connections[0]?.received).toContainEqual({
      op: 4,
      d: {
        guild_id: GUILD_ID,
        channel_id: FAKE_VOICE_CHANNEL_ID,
        self_deaf: true,
        self_mute: false,
      },
    })
    expect(voiceServer.received[0]).toMatchObject({ op: 0, d: { max_dave_protocol_version: 1 } })
    await daveReady(voiceServer)

    const { agent, socket } = await agentSocket()
    expect(voice.attach(GUILD_ID, socket, { codec: 'opus' })).toBe(true)
    // 2.4 seconds sent at once, faster than real time, in more bytes than one socket read: the
    // bot host stops reading once a second is queued, and reads on as it plays.
    const opus = Array.from({ length: 120 }, (_, index) => {
      const packet = Buffer.alloc(1000, index)
      packet[0] = 0xfc
      return packet
    })
    for (const packet of opus) agent.send(packet)

    await stoppedSpeaking(voiceServer)
    const audio = voiceServer.packets.filter((packet) => !packet.equals(SILENCE))
    expect(audio).toHaveLength(120)
    for (const [index, packet] of audio.entries()) {
      expect(packet.subarray(-2)).toEqual(DAVE_MAGIC_MARKER)
      expect(packet.includes(opus[index] as Buffer)).toBe(false)
    }
  })

  it('encodes pcm16 at the agent sample rate into 20 ms packets', async () => {
    const { voice, voiceServer } = await start()
    await voice.join(GUILD_ID, FAKE_VOICE_CHANNEL_ID)
    await daveReady(voiceServer)
    const { agent, socket } = await agentSocket()
    voice.attach(GUILD_ID, socket, { codec: 'pcm16', sampleRate: 24_000, channels: 1 })

    // 100 ms of a 440 Hz tone at 24 kHz mono, split across messages mid-frame.
    const pcm = Buffer.alloc(2400 * 2)
    for (let sample = 0; sample < 2400; sample++) {
      pcm.writeInt16LE(
        Math.round(8000 * Math.sin((2 * Math.PI * 440 * sample) / 24_000)),
        sample * 2,
      )
    }
    agent.send(pcm.subarray(0, 3000))
    agent.send(pcm.subarray(3000))

    await stoppedSpeaking(voiceServer)
    const audio = voiceServer.packets.filter((packet) => !packet.equals(SILENCE))
    expect(audio).toHaveLength(5)
    for (const packet of audio) expect(packet.subarray(-2)).toEqual(DAVE_MAGIC_MARKER)
  })

  it('closes the socket when a newer one replaces it, the bot leaves, or Discord disconnects it', async () => {
    const { voice, voiceServer, gateway, clock } = await start()
    await voice.join(GUILD_ID, FAKE_VOICE_CHANNEL_ID)
    const replaced = await agentSocket()
    voice.attach(GUILD_ID, replaced.socket, { codec: 'opus' })
    const left = await agentSocket()
    voice.attach(GUILD_ID, left.socket, { codec: 'opus' })
    expect(await replaced.closed).toEqual({
      code: 4000,
      reason: 'Another voice socket replaced this one.',
    })

    // Two seconds ahead of playback, so the bot host has stopped reading the socket.
    for (let index = 0; index < 100; index++) left.agent.send(Buffer.alloc(1000, 0xfc))
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(voice.leave(GUILD_ID)).toBe(true)
    expect(await left.closed).toEqual({ code: 1000, reason: 'The bot left the voice channel.' })
    expect(gateway.connections[0]?.received.at(-1)).toMatchObject({
      op: 4,
      d: { guild_id: GUILD_ID, channel_id: null },
    })
    expect(voice.joined(GUILD_ID)).toBe(false)

    await voice.join(GUILD_ID, FAKE_VOICE_CHANNEL_ID)
    const kicked = await agentSocket()
    voice.attach(GUILD_ID, kicked.socket, { codec: 'opus' })
    // Discord's close for a bot disconnected from the channel. It gets five seconds to return.
    voiceServer.disconnect(4014)
    let outcome: { code: number; reason: string } | undefined
    void kicked.closed.then((closed) => {
      outcome = closed
    })
    await vi.waitFor(() => {
      clock.advance(5_000)
      expect(outcome).toEqual({ code: 1000, reason: 'The bot left the voice channel.' })
    })
  })

  it('closes the socket when the bot goes offline', async () => {
    const { bots, voice } = await start()
    await voice.join(GUILD_ID, FAKE_VOICE_CHANNEL_ID)
    const { socket, closed } = await agentSocket()
    voice.attach(GUILD_ID, socket, { codec: 'opus' })
    bots.close()
    expect(await closed).toEqual({ code: 1001, reason: 'The bot went offline.' })
  })

  it('closes the socket on a text message or audio that does not fit the codec', async () => {
    const { voice } = await start()
    await voice.join(GUILD_ID, FAKE_VOICE_CHANNEL_ID)

    const text = await agentSocket()
    voice.attach(GUILD_ID, text.socket, { codec: 'opus' })
    text.agent.send('hello')
    expect(await text.closed).toMatchObject({ code: 1003 })

    const split = await agentSocket()
    voice.attach(GUILD_ID, split.socket, { codec: 'pcm16', sampleRate: 48_000, channels: 2 })
    split.agent.send(Buffer.alloc(6))
    expect(await split.closed).toMatchObject({ code: 1007 })
  })

  it('keeps a bot with an open voice socket online past the idle timeout', async () => {
    // Heartbeats are proven in the shard suite; keep them out of this 48-hour window.
    const { voice, gateway, clock } = await start({ heartbeatIntervalMs: 100 * HOUR })
    await voice.join(GUILD_ID, FAKE_VOICE_CHANNEL_ID)
    const { agent, socket } = await agentSocket()
    voice.attach(GUILD_ID, socket, { codec: 'opus' })

    clock.advance(24 * HOUR)
    expect(voice.joined(GUILD_ID)).toBe(true)

    agent.close()
    await once(socket, 'close')
    clock.advance(24 * HOUR)
    await vi.waitFor(() => expect(gateway.connections[0]?.closeCode).toBe(1000))
  })

  it('waits out a Gateway reconnect to join, and leaves once the session resumes', async () => {
    const { voice, gateway, clock } = await start()
    await voice.join(GUILD_ID, FAKE_VOICE_CHANNEL_ID)
    // Discord asks the bot to reconnect, which it routinely does.
    gateway.connections[0]?.send({ op: 7 })
    await vi.waitFor(() => expect(gateway.connections[0]?.closeCode).toBe(4000))

    const joining = voice.join('234567890123456780', FAKE_VOICE_CHANNEL_ID)
    // A leave while disconnected can't reach Discord yet, and the resumed session still has the
    // bot in the channel.
    expect(voice.leave(GUILD_ID)).toBe(true)
    clock.advance(1_000)
    await vi.waitFor(() => expect(gateway.connections[1]?.received[0]).toMatchObject({ op: 6 }))
    gateway.connections[1]?.send({ op: 0, t: 'RESUMED', s: 2 })
    await joining
    expect(voice.joined('234567890123456780')).toBe(true)
    expect(gateway.connections[1]?.received).toContainEqual({
      op: 4,
      d: { guild_id: GUILD_ID, channel_id: null, self_deaf: true, self_mute: false },
    })
  })

  it('brings a bot back with a fresh session when its leave could not reach Discord', async () => {
    const { bots, vault, voice, gateway, clock } = await start()
    await voice.join(GUILD_ID, FAKE_VOICE_CHANNEL_ID)
    await vi.waitFor(async () => expect(await vault.loadSessions()).toHaveLength(1))
    gateway.connections[0]?.send({ op: 7 })
    await vi.waitFor(() => expect(gateway.connections[0]?.closeCode).toBe(4000))

    // Shutting down mid-reconnect: a resumed session would still have the bot in the channel.
    await bots.close()
    const next = createBotRuntimes({ vault, clock, log: () => {}, gatewayUrl: gateway.url })
    cleanup.push(next.close)
    await next.resume()
    await vi.waitFor(() =>
      expect(gateway.connections[1]?.received[0]).toMatchObject({ op: 2, d: { token: TOKEN } }),
    )
  })

  it('fails the join when Discord does not connect the bot', async () => {
    const { voice, gateway, clock } = await start({ answersVoice: false })
    const joining = voice.join(GUILD_ID, FAKE_VOICE_CHANNEL_ID)
    await vi.waitFor(() =>
      expect(gateway.connections[0]?.received).toContainEqual(expect.objectContaining({ op: 4 })),
    )
    clock.advance(JOIN_TIMEOUT_MS)
    await expect(joining).rejects.toThrow('Discord did not connect the bot to the voice channel.')
    expect(voice.joined(GUILD_ID)).toBe(false)
  })
})

describe('the audio format an agent asks for', () => {
  it.each([
    ['codec=opus', { codec: 'opus' }],
    ['codec=pcm16&sample_rate=24000', { codec: 'pcm16', sampleRate: 24_000, channels: 1 }],
    [
      'codec=pcm16&sample_rate=48000&channels=2',
      { codec: 'pcm16', sampleRate: 48_000, channels: 2 },
    ],
    // Opus encodes only these rates natively; anything else would need a resampler.
    ['codec=pcm16&sample_rate=44100', 'pcm16 needs sample_rate'],
    ['codec=pcm16', 'pcm16 needs sample_rate'],
    ['codec=pcm16&sample_rate=16000&channels=3', 'channels must be 1 or 2.'],
    ['codec=mp3', 'codec must be "opus" or "pcm16".'],
    ['', 'codec must be "opus" or "pcm16".'],
  ])('%s', (query, expected) => {
    const format = parseAudioFormat(new URLSearchParams(query))
    if (typeof expected === 'string') expect(format).toContain(expected)
    else expect(format).toEqual(expected)
  })
})
