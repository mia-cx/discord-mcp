import { Readable } from 'node:stream'
import opus from '@discordjs/opus'
import {
  type AudioPlayer,
  type AudioResource,
  createAudioPlayer,
  createAudioResource,
  type DiscordGatewayAdapterLibraryMethods,
  joinVoiceChannel,
  StreamType,
  type VoiceConnection,
  VoiceConnectionStatus,
} from '@discordjs/voice'
import type { RawData, WebSocket } from 'ws'
import type { Clock } from './clock.ts'

/** Sample rates Opus encodes natively, so `pcm16` needs no resampler. */
export const PCM_SAMPLE_RATES = [8000, 12000, 16000, 24000, 48000] as const
type SampleRate = (typeof PCM_SAMPLE_RATES)[number]

/** How an agent's audio arrives on its voice socket, chosen when it connects. */
export type AudioFormat =
  | { readonly codec: 'opus' }
  | { readonly codec: 'pcm16'; readonly sampleRate: SampleRate; readonly channels: 1 | 2 }

/** The largest voice socket message: about 1.3 seconds of 48 kHz stereo `pcm16`. */
export const MAX_VOICE_MESSAGE_BYTES = 256 * 1024
/** libopus's recommended packet buffer. A larger message is not a single Opus packet. */
const MAX_OPUS_PACKET_BYTES = 4000
const FRAME_MS = 20
/** Encoded packets waiting to play before the socket stops reading: one second of audio. */
const QUEUE_PACKETS = 50
export const JOIN_TIMEOUT_MS = 15_000
/** How long a dropped voice connection may take to come back, as when the bot is moved. */
const RECONNECT_GRACE_MS = 5_000

/** Voice socket close codes beyond RFC 6455's. */
export const VoiceClose = {
  /** The bot left the voice channel, or Discord disconnected it. */
  Left: 1000,
  /** The bot went offline or restarted its Gateway session. */
  Offline: 1001,
  /** A text message arrived; audio travels in binary messages. */
  NotBinary: 1003,
  /** A message was not valid audio for the negotiated codec. */
  InvalidAudio: 1007,
  /** A newer voice socket for the same server took over. */
  Replaced: 4000,
} as const

const isSampleRate = (value: number): value is SampleRate =>
  (PCM_SAMPLE_RATES as ReadonlyArray<number>).includes(value)

/**
 * Read the codec an agent asked for from its voice socket's query: `codec=opus`, or
 * `codec=pcm16&sample_rate=24000&channels=1` (channels default to 1). Returns a message naming
 * what is wrong otherwise.
 */
export const parseAudioFormat = (query: URLSearchParams): AudioFormat | string => {
  const codec = query.get('codec')
  if (codec === 'opus') return { codec }
  if (codec !== 'pcm16') return 'codec must be "opus" or "pcm16".'
  const sampleRate = Number(query.get('sample_rate'))
  const channels = Number(query.get('channels') ?? 1)
  if (!isSampleRate(sampleRate)) {
    return `pcm16 needs sample_rate set to one of ${PCM_SAMPLE_RATES.join(', ')}.`
  }
  if (channels !== 1 && channels !== 2) return 'channels must be 1 or 2.'
  return { codec, sampleRate, channels }
}

/**
 * Turns each socket message into the 20 ms Opus packets Discord plays, or a message naming why it
 * is not valid audio. `pcm16` is little-endian, interleaved when stereo, and may split frames
 * across messages but not samples. Mono is copied to both channels, since Discord expects stereo.
 */
const packetizer = (format: AudioFormat): ((message: Buffer) => Buffer[] | string) => {
  if (format.codec === 'opus') {
    return (message) =>
      message.length > 0 && message.length <= MAX_OPUS_PACKET_BYTES
        ? [message]
        : `Send one Opus packet of 1 to ${MAX_OPUS_PACKET_BYTES} bytes per message.`
  }
  const { sampleRate, channels } = format
  const encoder = new opus.OpusEncoder(sampleRate, 2)
  const sampleBytes = 2 * channels
  const frameBytes = ((sampleRate * FRAME_MS) / 1000) * sampleBytes
  let pending = Buffer.alloc(0)
  return (message) => {
    if (message.length % sampleBytes !== 0) {
      return `pcm16 messages must hold whole ${sampleBytes}-byte samples.`
    }
    pending = Buffer.concat([pending, message])
    const packets: Buffer[] = []
    while (pending.length >= frameBytes) {
      const frame = pending.subarray(0, frameBytes)
      pending = pending.subarray(frameBytes)
      packets.push(encoder.encode(channels === 2 ? frame : stereo(frame)))
    }
    return packets
  }
}

const stereo = (mono: Buffer) => {
  const out = Buffer.alloc(mono.length * 2)
  for (let at = 0; at < mono.length; at += 2) {
    mono.copy(out, at * 2, at, at + 2)
    mono.copy(out, at * 2 + 2, at, at + 2)
  }
  return out
}

/** A paused socket cannot read the peer's close reply, so resume it to finish the handshake. */
const closeSocket = (socket: WebSocket, code: number, reason: string) => {
  socket.resume()
  socket.close(code, reason)
}

/** A Gateway payload the bot's shard sends for voice. */
export interface VoicePayload {
  readonly op: number
  readonly d: unknown
}

export interface VoiceOptions {
  readonly botId: string
  /** Send a payload on the bot's Gateway shard. False when the shard is not connected. */
  readonly send: (payload: VoicePayload) => boolean
  readonly clock: Clock
  readonly log: (message: string) => void
}

/** What an agent's calls can do with a bot's voice. */
export interface BotVoice {
  /**
   * Join a voice channel, resolving once audio can flow. Joining the channel the bot is in does
   * nothing; joining another channel in that server leaves the current one first. Rejects with a
   * message for the agent when Discord does not connect the bot in time.
   */
  readonly join: (guildId: string, channelId: string) => Promise<void>
  /** Leave the server's voice channel. False when the bot was not in one. */
  readonly leave: (guildId: string) => boolean
  readonly joined: (guildId: string) => boolean
  /**
   * Play the socket's audio in the server's voice channel until either ends. A newer socket for
   * the same server replaces this one. False when the bot is not in a voice channel there.
   */
  readonly attach: (guildId: string, socket: WebSocket, format: AudioFormat) => boolean
}

export interface Voice extends BotVoice {
  /** Feed every Gateway dispatch the bot's shard receives. */
  readonly dispatch: (event: string, data: unknown) => void
  /** Whether an agent's voice socket is open, which keeps the bot online. */
  readonly streaming: () => boolean
  /** Leave every voice channel and close every socket, as the bot goes offline. */
  readonly close: () => void
}

interface Session {
  readonly connection: VoiceConnection
  readonly player: AudioPlayer
  ready: Promise<void>
  socket: WebSocket | undefined
  /** How to close the socket once the connection is destroyed. */
  ending: { readonly code: number; readonly reason: string }
  cancelGrace: () => void
}

const JOIN_FAILED =
  'Discord did not connect the bot to the voice channel. Check that the bot can view the channel, Connect, and Speak, then try again.'
const LEFT = { code: VoiceClose.Left, reason: 'The bot left the voice channel.' }
const OFFLINE = { code: VoiceClose.Offline, reason: 'The bot went offline.' }

/**
 * One bot's voice connections, one per server, over its own Gateway shard: `@discordjs/voice`
 * carries the audio and `@snazzah/davey` its DAVE end-to-end encryption.
 */
export const createVoice = ({ botId, send, clock, log }: VoiceOptions): Voice => {
  const sessions = new Map<string, Session>()
  const adapters = new Map<string, DiscordGatewayAdapterLibraryMethods>()
  let online = false
  let onOnline: Array<() => void> = []

  const destroy = (session: Session, ending: Session['ending']) => {
    session.ending = ending
    if (session.connection.state.status !== VoiceConnectionStatus.Destroyed) {
      session.connection.destroy()
    }
  }

  const untilOnline = () =>
    online
      ? Promise.resolve()
      : new Promise<void>((resolve, reject) => {
          const cancel = clock.schedule(() => {
            onOnline = onOnline.filter((waiter) => waiter !== ready)
            reject(new Error('The bot is still connecting to Discord. Try again shortly.'))
          }, JOIN_TIMEOUT_MS)
          const ready = () => {
            cancel()
            resolve()
          }
          onOnline.push(ready)
        })

  /** Settles once the connection is ready, or fails and destroys it. */
  const connected = (connection: VoiceConnection) =>
    new Promise<void>((resolve, reject) => {
      const settle = (error?: Error) => {
        cancel()
        connection.off('stateChange', onChange)
        if (error === undefined) return resolve()
        if (connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy()
        reject(error)
      }
      const onChange = (_: unknown, state: VoiceConnection['state']) => {
        if (state.status === VoiceConnectionStatus.Ready) settle()
        if (
          state.status === VoiceConnectionStatus.Disconnected ||
          state.status === VoiceConnectionStatus.Destroyed
        ) {
          settle(new Error(JOIN_FAILED))
        }
      }
      const cancel = clock.schedule(() => settle(new Error(JOIN_FAILED)), JOIN_TIMEOUT_MS)
      connection.on('stateChange', onChange)
      // The join payload fails synchronously when the shard is disconnected.
      onChange(undefined, connection.state)
    })

  const open = (guildId: string, channelId: string): Session => {
    const connection = joinVoiceChannel({
      guildId,
      channelId,
      // `@discordjs/voice` keeps one connection per group and server, process-wide.
      group: botId,
      selfDeaf: true,
      selfMute: false,
      adapterCreator: (methods) => {
        adapters.set(guildId, methods)
        return {
          sendPayload: send,
          destroy: () => {
            if (adapters.get(guildId) === methods) adapters.delete(guildId)
          },
        }
      },
    })
    const player = createAudioPlayer()
    connection.subscribe(player)
    const session: Session = {
      connection,
      player,
      ready: Promise.resolve(),
      socket: undefined,
      ending: LEFT,
      cancelGrace: () => {},
    }
    sessions.set(guildId, session)
    connection.on('error', (error) => log(`Bot ${botId} voice error: ${error.message}`))
    player.on('error', (error) => log(`Bot ${botId} audio error: ${error.message}`))
    connection.on('stateChange', (_, state) => {
      session.cancelGrace()
      if (state.status === VoiceConnectionStatus.Disconnected) {
        session.cancelGrace = clock.schedule(() => destroy(session, LEFT), RECONNECT_GRACE_MS)
      }
      if (state.status !== VoiceConnectionStatus.Destroyed) return
      if (sessions.get(guildId) === session) sessions.delete(guildId)
      player.stop(true)
      const { socket } = session
      // Detached first, so messages still buffered on it never restart the stopped player.
      session.socket = undefined
      if (socket !== undefined) closeSocket(socket, session.ending.code, session.ending.reason)
    })
    session.ready = connected(connection)
    session.ready.catch(() => {})
    return session
  }

  const attach = (session: Session, socket: WebSocket, format: AudioFormat) => {
    const replaced = session.socket
    session.socket = socket
    if (replaced !== undefined) {
      closeSocket(replaced, VoiceClose.Replaced, 'Another voice socket replaced this one.')
    }
    const packetize = packetizer(format)
    let spurt: { readonly stream: Readable; readonly resource: AudioResource } | undefined

    // Each run of audio plays as its own resource: when the agent pauses for more than 100 ms
    // the player goes idle and the bot stops speaking, and the next packet starts a new run.
    const play = (packet: Buffer) => {
      if (spurt === undefined || spurt.resource.ended || spurt.resource.silenceRemaining !== -1) {
        const stream = new Readable({
          objectMode: true,
          highWaterMark: QUEUE_PACKETS,
          read: () => socket.resume(),
        })
        spurt = { stream, resource: createAudioResource(stream, { inputType: StreamType.Opus }) }
        session.player.play(spurt.resource)
      }
      if (!spurt.stream.push(packet)) socket.pause()
    }

    const reject = (code: number, reason: string) => {
      session.socket = undefined
      closeSocket(socket, code, reason)
    }
    socket.on('message', (data: RawData, isBinary) => {
      if (session.socket !== socket) return
      if (!isBinary) return reject(VoiceClose.NotBinary, 'Send audio as binary messages.')
      const packets = packetize(data as Buffer)
      if (typeof packets === 'string') return reject(VoiceClose.InvalidAudio, packets)
      for (const packet of packets) play(packet)
    })
    socket.on('error', (error) => log(`Bot ${botId} voice socket error: ${error.message}`))
    socket.on('close', () => {
      if (session.socket === socket) session.socket = undefined
      // Queued audio plays out.
      spurt?.stream.push(null)
    })
  }

  return {
    dispatch: (event, data) => {
      if (event === 'READY' || event === 'RESUMED') {
        // A new Gateway session no longer holds the old session's voice state; a resumed one does.
        if (event === 'READY') for (const session of sessions.values()) destroy(session, OFFLINE)
        online = true
        for (const ready of onOnline.splice(0)) ready()
        return
      }
      const voice = data as { guild_id?: string; user_id?: string }
      if (voice.guild_id === undefined) return
      const adapter = adapters.get(voice.guild_id)
      if (event === 'VOICE_STATE_UPDATE' && voice.user_id === botId) {
        adapter?.onVoiceStateUpdate(data as Parameters<typeof adapter.onVoiceStateUpdate>[0])
      }
      if (event === 'VOICE_SERVER_UPDATE') {
        adapter?.onVoiceServerUpdate(data as Parameters<typeof adapter.onVoiceServerUpdate>[0])
      }
    },
    join: async (guildId, channelId) => {
      await untilOnline()
      const current = sessions.get(guildId)
      if (current?.connection.joinConfig.channelId === channelId) return current.ready
      if (current !== undefined) destroy(current, LEFT)
      return open(guildId, channelId).ready
    },
    leave: (guildId) => {
      const session = sessions.get(guildId)
      if (session === undefined) return false
      destroy(session, LEFT)
      return true
    },
    joined: (guildId) => sessions.has(guildId),
    attach: (guildId, socket, format) => {
      const session = sessions.get(guildId)
      if (session === undefined) return false
      attach(session, socket, format)
      return true
    },
    streaming: () => [...sessions.values()].some((session) => session.socket !== undefined),
    close: () => {
      for (const session of sessions.values()) destroy(session, OFFLINE)
    },
  }
}
