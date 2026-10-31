import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { inMemoryStorage } from '@discord-mcp/storage/testing'
import opus from '@discordjs/opus'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import { createBotRuntimes } from '../src/runtimes.ts'
import {
  DAVE_MAGIC_MARKER,
  FAKE_VOICE_CHANNEL_ID,
  FAKE_VOICE_MEMBER_ID,
  fakeGateway,
  fakeVoiceServer,
  manualClock,
} from '../src/testing.ts'
import { createTokenVault } from '../src/vault.ts'
import { JOIN_TIMEOUT_MS, parseAudioFormat, type VoiceEvent } from '../src/voice.ts'

const BOT_ID = '345678901234567890'
const GUILD_ID = '234567890123456789'
const TOKEN = 'private-bot-token'
const HOUR = 60 * 60 * 1000
const SILENCE = Buffer.from([0xf8, 0xff, 0xfe])
const ALICE = FAKE_VOICE_MEMBER_ID
const BOB = '222222222222222222'

const cleanup: Array<() => unknown> = []
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})

/** A bot online on a fake Gateway that routes voice joins to a fake voice server. */
const start = async ({
  heartbeatIntervalMs = 41_250,
  answersVoice = true,
  shards = 1,
  members = [ALICE],
  sendMessages = true,
  onDispatch = (_botId: string, _event: string, _data: unknown) => {},
} = {}) => {
  const storage = await inMemoryStorage()
  const voiceServer = await fakeVoiceServer({ members })
  const gateway = await fakeGateway(
    heartbeatIntervalMs,
    answersVoice ? { botId: BOT_ID, endpoint: voiceServer.endpoint } : undefined,
  )
  const clock = manualClock()
  const vault = createTokenVault(Buffer.alloc(32, 1), storage)
  const bots = createBotRuntimes({
    vault,
    storage,
    clock,
    log: () => {},
    discordFetch: gateway.discordFetch({ shards, sendMessages }),
    onDispatch,
  })
  cleanup.push(storage.close, voiceServer.close, gateway.close, bots.close)
  await bots.use(BOT_ID, TOKEN)
  const voice = bots.voice(BOT_ID)
  if (voice === undefined) throw new Error('the bot is not running')
  return { bots, storage, vault, voice, voiceServer, gateway, clock }
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
    const { bots, storage, vault, voice, gateway, clock } = await start()
    await voice.join(GUILD_ID, FAKE_VOICE_CHANNEL_ID)
    await vi.waitFor(async () => expect(await vault.loadSessions()).toHaveLength(1))
    gateway.connections[0]?.send({ op: 7 })
    await vi.waitFor(() => expect(gateway.connections[0]?.closeCode).toBe(4000))

    // Shutting down mid-reconnect: a resumed session would still have the bot in the channel.
    await bots.close()
    const next = createBotRuntimes({
      vault,
      storage,
      clock,
      log: () => {},
      discordFetch: gateway.discordFetch(),
    })
    cleanup.push(next.close)
    await next.resume()
    await vi.waitFor(() =>
      expect(gateway.connections[1]?.received[0]).toMatchObject({ op: 2, d: { token: TOKEN } }),
    )
  })

  it("joins through the shard that carries the server's events", async () => {
    const { voice, voiceServer, gateway, clock } = await start({ shards: 2 })
    // (guild_id >> 22) % 2 is 1, so shard 1 of 2 carries this server.
    const guildId = '419430399995805696'
    const joining = voice.join(guildId, FAKE_VOICE_CHANNEL_ID)
    // Shard 1 identifies five seconds after shard 0.
    await vi.waitFor(() => expect(gateway.connections).toHaveLength(2))
    await new Promise((resolve) => setTimeout(resolve, 50))
    clock.advance(5_000)
    await joining
    await daveReady(voiceServer)

    const onShard = (shardId: number) =>
      gateway.connections.find(
        ({ received }) =>
          (received[0]?.d as { shard?: number[] } | undefined)?.shard?.[0] === shardId,
      )?.received ?? []
    const joinPayload = { op: 4, d: expect.objectContaining({ guild_id: guildId }) }
    expect(onShard(1)).toContainEqual(joinPayload)
    expect(onShard(0)).not.toContainEqual(joinPayload)
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

/** What an agent hears on its voice socket: events, and each speaker's packets by user ID. */
const listen = (agent: WebSocket) => {
  const events: VoiceEvent[] = []
  const audio: Array<{ readonly userId: string; readonly payload: Buffer }> = []
  agent.on('message', (data: Buffer, isBinary) => {
    if (!isBinary) return void events.push(JSON.parse(String(data)))
    audio.push({ userId: data.readBigUInt64BE(0).toString(), payload: data.subarray(8) })
  })
  const from = (userId: string) =>
    audio.filter((heard) => heard.userId === userId).map(({ payload }) => payload)
  return { events, audio, from }
}

/** Distinct Opus-shaped packets, none of them the plaintext silence frame. */
const speech = (count: number, tag: number) =>
  Array.from({ length: count }, (_, index) => Buffer.from([0xfc, tag, index, 1, 2, 3]))

/** Long enough for audio the bot would relay to have arrived. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 300))

let clicks = 0
/** Someone clicks one of Textile's buttons in the server. */
const click = (gateway: Awaited<ReturnType<typeof fakeGateway>>, userId: string, button: string) =>
  gateway.connections[0]?.send({
    op: 0,
    t: 'INTERACTION_CREATE',
    s: 1000 + ++clicks,
    d: {
      id: String(900000000000000000 + clicks),
      token: `interaction-token-${clicks}`,
      type: 3,
      guild_id: GUILD_ID,
      member: { user: { id: userId } },
      data: { custom_id: `textile:voice:${button}`, component_type: 2 },
    },
  })

const NOTICE = `/channels/${FAKE_VOICE_CHANNEL_ID}/messages`
const voiceStates = (gateway: Awaited<ReturnType<typeof fakeGateway>>) =>
  (gateway.connections[0]?.received ?? []).filter(({ op }) => op === 4)

describe('receiving voice', () => {
  it('relays each speaker separately, tagged with their user ID, only once the notice is up', async () => {
    const { voice, voiceServer, gateway } = await start({ members: [ALICE, BOB] })
    expect(await voice.join(GUILD_ID, FAKE_VOICE_CHANNEL_ID)).toEqual({ receiving: false })
    await daveReady(voiceServer)
    const { agent, socket } = await agentSocket()
    const heard = listen(agent)
    voice.attach(GUILD_ID, socket, { codec: 'opus' })

    // A session that only sends hears nobody, and Discord shows the bot deafened.
    await voiceServer.speak(ALICE, speech(2, 0xa0))
    await settle()
    expect(heard.events).toEqual([])
    expect(heard.audio).toEqual([])
    expect(gateway.rest).toEqual([])
    expect(voiceStates(gateway).at(-1)).toMatchObject({ d: { self_deaf: true } })

    expect(await voice.join(GUILD_ID, FAKE_VOICE_CHANNEL_ID, true)).toEqual({ receiving: true })
    expect(gateway.rest).toEqual([
      {
        method: 'POST',
        path: NOTICE,
        body: expect.objectContaining({
          allowed_mentions: { parse: [] },
          components: [
            expect.objectContaining({
              components: [
                expect.objectContaining({ custom_id: 'textile:voice:opt-out:bot' }),
                expect.objectContaining({ custom_id: 'textile:voice:opt-out:all' }),
              ],
            }),
          ],
        }),
      },
    ])
    await vi.waitFor(() =>
      expect(voiceStates(gateway).at(-1)).toMatchObject({ d: { self_deaf: false } }),
    )
    await vi.waitFor(() =>
      expect(heard.events).toEqual([
        { type: 'join', user_id: ALICE },
        { type: 'join', user_id: BOB },
      ]),
    )

    // Bob's SSRC isn't named yet, so his first packets can't be told apart and are dropped.
    await voiceServer.speak(BOB, speech(2, 0xbe), { announce: false })
    const fromAlice = speech(3, 0xa1)
    const fromBob = speech(2, 0xb1)
    await voiceServer.speak(ALICE, fromAlice)
    await voiceServer.speak(BOB, fromBob)
    await vi.waitFor(() => {
      expect(heard.from(ALICE)).toEqual(fromAlice)
      expect(heard.from(BOB)).toEqual(fromBob)
    })
    await vi.waitFor(() =>
      expect(heard.events).toContainEqual({ type: 'speaking', user_id: BOB, speaking: false }),
    )
    expect(heard.events).toContainEqual({ type: 'speaking', user_id: ALICE, speaking: true })
    expect(heard.events).toContainEqual({ type: 'speaking', user_id: ALICE, speaking: false })
  })

  it('decodes each speaker to pcm16 at the agent sample rate', async () => {
    const { voice, voiceServer } = await start()
    await voice.join(GUILD_ID, FAKE_VOICE_CHANNEL_ID, true)
    await daveReady(voiceServer)
    const { agent, socket } = await agentSocket()
    const heard = listen(agent)
    voice.attach(GUILD_ID, socket, { codec: 'pcm16', sampleRate: 24_000, channels: 1 })
    await vi.waitFor(() => expect(heard.events).toEqual([{ type: 'join', user_id: ALICE }]))

    // Three 20 ms frames of a 440 Hz tone, as Discord carries it: 48 kHz stereo Opus.
    const encoder = new opus.OpusEncoder(48_000, 2)
    const frames = Array.from({ length: 3 }, (_, frame) => {
      const pcm = Buffer.alloc(960 * 4)
      for (let sample = 0; sample < 960; sample++) {
        const value = Math.round(
          8000 * Math.sin((2 * Math.PI * 440 * (frame * 960 + sample)) / 48_000),
        )
        pcm.writeInt16LE(value, sample * 4)
        pcm.writeInt16LE(value, sample * 4 + 2)
      }
      return encoder.encode(pcm)
    })
    await voiceServer.speak(ALICE, frames)

    // 20 ms at 24 kHz mono is 480 samples of 2 bytes.
    await vi.waitFor(() => expect(heard.from(ALICE)).toHaveLength(3))
    for (const pcm of heard.from(ALICE)) expect(pcm).toHaveLength(960)
    expect(heard.from(ALICE).some((pcm) => pcm.some((byte) => byte !== 0))).toBe(true)
  })

  it('only sends audio, deafened, when the notice cannot be posted', async () => {
    const { voice, voiceServer, gateway } = await start({ sendMessages: false })
    expect(await voice.join(GUILD_ID, FAKE_VOICE_CHANNEL_ID, true)).toEqual({
      receiving: false,
      reason: expect.stringContaining('Send Messages'),
    })
    await daveReady(voiceServer)
    const { agent, socket } = await agentSocket()
    const heard = listen(agent)
    voice.attach(GUILD_ID, socket, { codec: 'opus' })
    await voiceServer.speak(ALICE, speech(3, 0xa0))
    await settle()
    expect(heard.events).toEqual([])
    expect(heard.audio).toEqual([])
    for (const state of voiceStates(gateway))
      expect(state).toMatchObject({ d: { self_deaf: true } })
  })

  it('drops a speaker who opts out of this bot at once, never tells workflows, and undoes it', async () => {
    const onDispatch = vi.fn()
    const { voice, voiceServer, gateway, storage } = await start({ onDispatch })
    await voice.join(GUILD_ID, FAKE_VOICE_CHANNEL_ID, true)
    await daveReady(voiceServer)
    const { agent, socket } = await agentSocket()
    const heard = listen(agent)
    voice.attach(GUILD_ID, socket, { codec: 'opus' })
    await vi.waitFor(() => expect(heard.events).toEqual([{ type: 'join', user_id: ALICE }]))

    click(gateway, ALICE, 'opt-out:bot')
    await vi.waitFor(() => expect(heard.events.at(-1)).toEqual({ type: 'leave', user_id: ALICE }))
    expect(gateway.rest.at(-1)).toMatchObject({
      path: expect.stringMatching(/^\/interactions\/\d+\/interaction-token-\d+\/callback$/),
      body: {
        type: 4,
        data: {
          flags: 64,
          components: [{ components: [{ custom_id: 'textile:voice:undo:bot' }] }],
        },
      },
    })
    expect(await storage.voiceOptedOut(BOT_ID, GUILD_ID, ALICE)).toBe(true)
    expect(await storage.voiceOptedOut(BOT_ID, '234567890123456780', ALICE)).toBe(false)
    await voiceServer.speak(ALICE, speech(3, 0xa0))
    await settle()
    expect(heard.audio).toEqual([])

    click(gateway, ALICE, 'undo:bot')
    await vi.waitFor(() => expect(heard.events.at(-1)).toEqual({ type: 'join', user_id: ALICE }))
    expect(gateway.rest.at(-1)).toMatchObject({ body: { type: 7, data: { components: [] } } })
    expect(await storage.voiceOptedOut(BOT_ID, GUILD_ID, ALICE)).toBe(false)
    const after = speech(2, 0xa1)
    await voiceServer.speak(ALICE, after)
    await vi.waitFor(() => expect(heard.from(ALICE)).toEqual(after))

    const dispatched = onDispatch.mock.calls.map(([, event]) => event)
    expect(dispatched).toContain('READY')
    expect(dispatched).not.toContain('INTERACTION_CREATE')
  })

  it('keeps a speaker who opted out of every bot out of later sessions until they undo it', async () => {
    const { voice, voiceServer, gateway, storage } = await start()
    await voice.join(GUILD_ID, FAKE_VOICE_CHANNEL_ID, true)
    await daveReady(voiceServer)
    const first = await agentSocket()
    const firstHeard = listen(first.agent)
    voice.attach(GUILD_ID, first.socket, { codec: 'opus' })
    await vi.waitFor(() => expect(firstHeard.events).toEqual([{ type: 'join', user_id: ALICE }]))
    click(gateway, ALICE, 'opt-out:all')
    await vi.waitFor(() =>
      expect(firstHeard.events.at(-1)).toEqual({ type: 'leave', user_id: ALICE }),
    )
    expect(await storage.voiceOptedOut('456789012345678901', '234567890123456780', ALICE)).toBe(
      true,
    )

    // A new session reads the opt-out from storage.
    voice.leave(GUILD_ID)
    await voice.join(GUILD_ID, FAKE_VOICE_CHANNEL_ID, true)
    await vi.waitFor(() =>
      expect(voiceServer.received.filter(({ op }) => op === 23)).toHaveLength(2),
    )
    const second = await agentSocket()
    const heard = listen(second.agent)
    voice.attach(GUILD_ID, second.socket, { codec: 'opus' })
    // Someone connects mid-call.
    voiceServer.connect([BOB])
    await vi.waitFor(() => expect(heard.events).toEqual([{ type: 'join', user_id: BOB }]))
    await voiceServer.speak(ALICE, speech(3, 0xa0))
    await settle()
    expect(heard.audio).toEqual([])
    expect(heard.events).toEqual([{ type: 'join', user_id: BOB }])

    click(gateway, ALICE, 'undo:all')
    await vi.waitFor(() => expect(heard.events.at(-1)).toEqual({ type: 'join', user_id: ALICE }))
    voiceServer.disconnectMember(BOB)
    await vi.waitFor(() => expect(heard.events.at(-1)).toEqual({ type: 'leave', user_id: BOB }))
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
