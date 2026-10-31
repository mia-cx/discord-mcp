import { Readable } from 'node:stream'
import opus from '@discordjs/opus'
import {
  type AudioPlayer,
  type AudioReceiveStream,
  type AudioResource,
  createAudioPlayer,
  createAudioResource,
  type DiscordGatewayAdapterLibraryMethods,
  joinVoiceChannel,
  StreamType,
  type VoiceConnection,
  VoiceConnectionStatus,
  type VoiceReceiver,
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
/** Audio waiting to reach a slow agent before newer audio is dropped: a few seconds' worth. */
const MAX_BUFFERED_BYTES = 1024 * 1024
/** Voice gateway opcodes for people connecting to and leaving the channel. */
const CLIENTS_CONNECT = 11
const CLIENT_DISCONNECT = 13

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

/**
 * What the bot hears, sent to the agent's socket: each person's audio as a binary message of their
 * user ID (8 bytes, big-endian) then one packet in the socket's codec, and events as JSON text.
 * `pcm16` decodes each person separately, at the socket's rate and channels. Audio a slow agent
 * hasn't read past `MAX_BUFFERED_BYTES` is dropped rather than queued.
 */
const createRelay = (socket: WebSocket, format: AudioFormat, log: (message: string) => void) => {
  const decoders = new Map<string, opus.OpusEncoder>()
  const decode = (userId: string, packet: Buffer) => {
    if (format.codec === 'opus') return packet
    let decoder = decoders.get(userId)
    if (decoder === undefined) {
      decoder = new opus.OpusEncoder(format.sampleRate, format.channels)
      decoders.set(userId, decoder)
    }
    return decoder.decode(packet)
  }
  return {
    audio: (userId, packet) => {
      if (socket.bufferedAmount > MAX_BUFFERED_BYTES) return
      let payload: Buffer
      try {
        payload = decode(userId, packet)
      } catch (error) {
        return log(`Dropped a corrupt Opus packet: ${(error as Error).message}`)
      }
      const speaker = Buffer.alloc(8)
      speaker.writeBigUInt64BE(BigInt(userId))
      socket.send(Buffer.concat([speaker, payload]))
    },
    event: (event) => socket.send(JSON.stringify(event)),
    forget: (userId) => decoders.delete(userId),
  } satisfies Relay
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
  /** The shard that carries a server's Gateway events, once the bot's shards have started. */
  readonly shardOf: (guildId: string) => number | undefined
  /** Send a payload on one of the bot's shards. False until that shard's session has started. */
  readonly send: (shardId: number, payload: VoicePayload) => boolean
  readonly consent: VoiceConsent
  readonly clock: Clock
  readonly log: (message: string) => void
}

/** What receiving voice needs from the people it relays, for this bot. */
export interface VoiceConsent {
  /**
   * Post the notice in a voice channel's chat. Resolves to why it could not be posted, or
   * `undefined` once it is up.
   */
  readonly notice: (channelId: string) => Promise<string | undefined>
  /** Whether a person opted out of this bot in this server, or of every bot. */
  readonly optedOut: (guildId: string, userId: string) => Promise<boolean>
}

/** Whether a joined session relays the channel's voice, and if it can't, why not. */
export type Joined =
  | { readonly receiving: true }
  | { readonly receiving: false; readonly reason?: string }

/** What the agent hears about people in the channel, as text messages on its voice socket. */
export type VoiceEvent =
  | { readonly type: 'join' | 'leave'; readonly user_id: string }
  | { readonly type: 'speaking'; readonly user_id: string; readonly speaking: boolean }

/** What an agent's calls can do with a bot's voice. */
export interface BotVoice {
  /**
   * Join a voice channel, resolving once audio can flow. Joining the channel the bot is in does
   * nothing; joining another channel in that server leaves the current one first. Rejects with a
   * message for the agent when Discord does not connect the bot in time.
   *
   * With `receive`, the bot posts its notice in the channel's chat, then relays everyone who hasn't
   * opted out to the voice socket. When the notice can't be posted, the session only sends audio.
   * Without it, a session that was receiving stops.
   */
  readonly join: (guildId: string, channelId: string, receive?: boolean) => Promise<Joined>
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
  /** Feed every Gateway dispatch each of the bot's shards receives. */
  readonly dispatch: (shardId: number, event: string, data: unknown) => void
  /** A shard lost its connection: joins in its servers wait for its next `READY` or `RESUMED`. */
  readonly dropped: (shardId: number) => void
  /** Whether an agent's voice socket is open, which keeps the bot online. */
  readonly streaming: () => boolean
  /**
   * A person's opt-out changed, in one server or in every one: check them again, so the change
   * reaches the agent at once.
   */
  readonly reconsider: (guildId: string | undefined, userId: string) => void
  /**
   * Leave every voice channel and close every socket, as the bot goes offline. Returns the shards
   * whose leaves could not reach Discord, whose sessions would keep the bot in those channels.
   */
  readonly close: () => ReadonlySet<number>
}

/** Sends what the agent hears to its socket, in the codec it chose. */
interface Relay {
  readonly audio: (userId: string, packet: Buffer) => void
  readonly event: (event: VoiceEvent) => void
  /** The person left the agent's hearing; drop their decoder. */
  readonly forget: (userId: string) => void
}

/** Someone in the bot's voice channel. */
interface Person {
  /** Whether they may be relayed: undefined until their opt-out is checked. */
  allowed: boolean | undefined
  /** Bumped by each opt-out check, so only the newest answer counts. */
  checks: number
  /** Their audio, while it may reach the agent. Unsubscribed audio is dropped undecrypted. */
  stream: AudioReceiveStream | undefined
  /** Whether the agent was told they joined. */
  shown: boolean
}

interface Session {
  readonly guildId: string
  readonly connection: VoiceConnection
  readonly player: AudioPlayer
  ready: Promise<void>
  socket: WebSocket | undefined
  /** The socket's side of what the bot hears, while one is attached. */
  relay: Relay | undefined
  /** The channel whose chat shows the notice, while the bot relays it. */
  receiving: string | undefined
  /** The notice being posted, so concurrent joins post it once. */
  noticing: Promise<string | undefined> | undefined
  /** People in the channel besides the bot, by user ID. */
  readonly people: Map<string, Person>
  /** How to close the socket once the connection is destroyed. */
  ending: { readonly code: number; readonly reason: string }
  cancelGrace: () => void
}

const JOIN_FAILED =
  'Discord did not connect the bot to the voice channel. Check that the bot can view the channel, Connect, and Speak, then try again.'
const LEFT = { code: VoiceClose.Left, reason: 'The bot left the voice channel.' }
const OFFLINE = { code: VoiceClose.Offline, reason: 'The bot went offline.' }

/**
 * One bot's voice connections, one per server, each over the bot's Gateway shard for that server:
 * `@discordjs/voice` carries the audio and `@snazzah/davey` its DAVE end-to-end encryption.
 *
 * Receiving is best-effort: Discord neither documents nor supports it. Opcode 5 names the user
 * behind each SSRC, and DAVE keys each sender's audio to their user ID, so audio from an SSRC not
 * yet named is dropped. People reach the agent only while the notice is up and they haven't opted
 * out; anyone else's audio is never decrypted.
 */
export const createVoice = ({ botId, shardOf, send, consent, clock, log }: VoiceOptions): Voice => {
  const sessions = new Map<string, Session>()
  const adapters = new Map<string, DiscordGatewayAdapterLibraryMethods>()
  /**
   * Leaves the shard could not send while reconnecting, by server. A resumed session still has
   * the bot in those channels, so they go out once it resumes.
   */
  const unsentLeaves = new Map<string, VoicePayload>()
  /** Shards whose session has started and not dropped since. */
  const online = new Set<number>()
  /** Joins waiting for their server's shard to come online. */
  let waiting: Array<{ readonly guildId: string; readonly ready: () => void }> = []

  const onlineFor = (guildId: string) => {
    const shardId = shardOf(guildId)
    return shardId !== undefined && online.has(shardId)
  }
  const sendFor = (guildId: string, payload: VoicePayload) => {
    const shardId = shardOf(guildId)
    return shardId !== undefined && send(shardId, payload)
  }

  const destroy = (session: Session, ending: Session['ending']) => {
    session.ending = ending
    if (session.connection.state.status !== VoiceConnectionStatus.Destroyed) {
      session.connection.destroy()
    }
  }

  const untilOnline = (guildId: string) =>
    onlineFor(guildId)
      ? Promise.resolve()
      : new Promise<void>((resolve, reject) => {
          const cancel = clock.schedule(() => {
            waiting = waiting.filter((waiter) => waiter.ready !== ready)
            reject(new Error('The bot is still connecting to Discord. Try again shortly.'))
          }, JOIN_TIMEOUT_MS)
          const ready = () => {
            cancel()
            resolve()
          }
          waiting.push({ guildId, ready })
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

  /** Listen to a person, so their audio is decrypted and reaches the agent. */
  const subscribe = (session: Session, userId: string, person: Person) => {
    const stream = session.connection.receiver.subscribe(userId)
    stream.on('data', (packet: Buffer) => session.relay?.audio(userId, packet))
    stream.on('error', (error) => log(`Bot ${botId} lost a speaker's audio: ${error.message}`))
    // Ended by us, or by a packet that failed transport decryption: listen again if still wanted.
    stream.once('close', () => {
      if (person.stream === stream) person.stream = undefined
      if (session.people.get(userId) === person) sync(session, userId)
    })
    return stream
  }

  /** Bring what the agent hears of a person in line with whether they may reach it. */
  const sync = (session: Session, userId: string) => {
    const person = session.people.get(userId)
    const { relay, connection } = session
    if (person === undefined) return
    if (person.allowed !== true || session.receiving === undefined || relay === undefined) {
      const { stream } = person
      person.stream = undefined
      stream?.destroy()
      if (!person.shown) return
      person.shown = false
      relay?.event({ type: 'leave', user_id: userId })
      relay?.forget(userId)
      return
    }
    if (!person.shown) {
      person.shown = true
      relay.event({ type: 'join', user_id: userId })
      if (connection.receiver.speaking.users.has(userId)) {
        relay.event({ type: 'speaking', user_id: userId, speaking: true })
      }
    }
    // A stream still closing can't be replaced yet; its close syncs again.
    if (person.stream === undefined && !connection.receiver.subscriptions.has(userId)) {
      person.stream = subscribe(session, userId, person)
    }
  }

  /** Look up a person's opt-out; until it answers, they keep their last answer. */
  const check = (session: Session, userId: string) => {
    const person = session.people.get(userId)
    if (person === undefined || session.receiving === undefined) return
    const asked = ++person.checks
    consent
      .optedOut(session.guildId, userId)
      .then(
        (optedOut) => !optedOut,
        (cause) => {
          // Without an answer, nobody is relayed.
          log(`Bot ${botId} could not check a speaker's voice opt-out: ${String(cause)}`)
          return false
        },
      )
      .then((allowed) => {
        if (session.people.get(userId) !== person || person.checks !== asked) return
        person.allowed = allowed
        sync(session, userId)
      })
  }

  const arrive = (session: Session, userId: string) => {
    if (userId === botId || session.people.has(userId)) return
    session.people.set(userId, { allowed: undefined, checks: 0, stream: undefined, shown: false })
    check(session, userId)
  }

  const depart = (session: Session, userId: string) => {
    const person = session.people.get(userId)
    if (person === undefined) return
    person.allowed = false
    sync(session, userId)
    session.people.delete(userId)
  }

  /** Hand what the bot hears to another socket, or to none. */
  const switchRelay = (session: Session, relay: Relay | undefined) => {
    session.relay = relay
    for (const person of session.people.values()) person.shown = false
    for (const userId of session.people.keys()) sync(session, userId)
  }

  /** Post the notice, then relay everyone who hasn't opted out. */
  const listen = async (session: Session): Promise<Joined> => {
    const channelId = session.connection.joinConfig.channelId
    if (channelId === null) return { receiving: false }
    if (session.receiving === channelId) return { receiving: true }
    session.noticing ??= consent.notice(channelId)
    const noticing = session.noticing
    const refused = await noticing
    if (session.noticing === noticing) session.noticing = undefined
    if (refused !== undefined) return { receiving: false, reason: refused }
    if (sessions.get(session.guildId) !== session) throw new Error(LEFT.reason)
    if (session.receiving !== channelId) {
      session.receiving = channelId
      // Joined deafened, so the bot is seen to listen only once the notice is up.
      session.connection.rejoin({ channelId, selfDeaf: false, selfMute: false })
      for (const userId of session.people.keys()) check(session, userId)
    }
    return { receiving: true }
  }

  /** Stop relaying anyone, deafened in `channelId`; the session only sends audio. */
  const deafen = (
    session: Session,
    channelId = session.connection.joinConfig.channelId,
  ): Joined => {
    if (session.receiving === undefined) return { receiving: false }
    session.receiving = undefined
    if (channelId !== null)
      session.connection.rejoin({ channelId, selfDeaf: true, selfMute: false })
    for (const userId of session.people.keys()) sync(session, userId)
    return { receiving: false }
  }

  const open = (guildId: string, channelId: string): Session => {
    const connection = joinVoiceChannel({
      guildId,
      channelId,
      // `@discordjs/voice` keeps one connection per group and server, process-wide.
      group: botId,
      // Deafened until the bot relays the channel, which `listen` changes.
      selfDeaf: true,
      selfMute: false,
      adapterCreator: (methods) => {
        adapters.set(guildId, methods)
        return {
          sendPayload: (payload: VoicePayload) => {
            const sent = sendFor(guildId, payload)
            if (sent) unsentLeaves.delete(guildId)
            else if ((payload.d as { channel_id: string | null }).channel_id === null) {
              unsentLeaves.set(guildId, payload)
            }
            return sent
          },
          destroy: () => {
            if (adapters.get(guildId) === methods) adapters.delete(guildId)
          },
        }
      },
    })
    const player = createAudioPlayer()
    connection.subscribe(player)
    const session: Session = {
      guildId,
      connection,
      player,
      ready: Promise.resolve(),
      socket: undefined,
      relay: undefined,
      receiving: undefined,
      noticing: undefined,
      people: new Map(),
      ending: LEFT,
      cancelGrace: () => {},
    }
    sessions.set(guildId, session)
    connection.on('error', (error) => log(`Bot ${botId} voice error: ${error.message}`))
    player.on('error', (error) => log(`Bot ${botId} audio error: ${error.message}`))

    // The voice gateway names who connects and leaves; the receiver tracks only who speaks.
    const { receiver } = connection
    const onWsPacket = receiver.onWsPacket
    receiver.onWsPacket = (packet: Parameters<VoiceReceiver['onWsPacket']>[0]) => {
      onWsPacket(packet)
      if (packet.op === CLIENTS_CONNECT) {
        for (const userId of (packet.d as { user_ids: string[] }).user_ids) arrive(session, userId)
      }
      if (packet.op === CLIENT_DISCONNECT) {
        depart(session, (packet.d as { user_id: string }).user_id)
      }
    }
    receiver.speaking.on('start', (userId: string) => {
      arrive(session, userId)
      const person = session.people.get(userId)
      if (person?.shown) session.relay?.event({ type: 'speaking', user_id: userId, speaking: true })
      // Each time someone starts speaking, an opt-out made through another bot host applies.
      check(session, userId)
    })
    receiver.speaking.on('end', (userId: string) => {
      if (session.people.get(userId)?.shown) {
        session.relay?.event({ type: 'speaking', user_id: userId, speaking: false })
      }
    })

    connection.on('stateChange', (_, state) => {
      session.cancelGrace()
      if (state.status === VoiceConnectionStatus.Disconnected) {
        session.cancelGrace = clock.schedule(() => destroy(session, LEFT), RECONNECT_GRACE_MS)
      }
      if (state.status !== VoiceConnectionStatus.Destroyed) return
      if (sessions.get(guildId) === session) sessions.delete(guildId)
      player.stop(true)
      session.receiving = undefined
      switchRelay(session, undefined)
      const { socket } = session
      // Detached first, so messages still buffered on it never restart the stopped player.
      session.socket = undefined
      if (socket !== undefined) closeSocket(socket, session.ending.code, session.ending.reason)
    })
    session.ready = connected(connection)
    session.ready.catch(() => {})
    return session
  }

  /** A shard's session started: a new one, or a resumed one with its voice state intact. */
  const started = (shardId: number, resumed: boolean) => {
    const onShard = (guildId: string) => shardOf(guildId) === shardId
    if (!resumed) {
      for (const [guildId, session] of sessions) if (onShard(guildId)) destroy(session, OFFLINE)
      for (const guildId of unsentLeaves.keys()) {
        if (onShard(guildId)) unsentLeaves.delete(guildId)
      }
    }
    for (const [guildId, leave] of unsentLeaves) {
      if (onShard(guildId) && send(shardId, leave)) unsentLeaves.delete(guildId)
    }
    online.add(shardId)
    const ready = waiting.filter((waiter) => onlineFor(waiter.guildId))
    waiting = waiting.filter((waiter) => !ready.includes(waiter))
    for (const waiter of ready) waiter.ready()
  }

  const attach = (session: Session, socket: WebSocket, format: AudioFormat) => {
    const replaced = session.socket
    session.socket = socket
    if (replaced !== undefined) {
      closeSocket(replaced, VoiceClose.Replaced, 'Another voice socket replaced this one.')
    }
    switchRelay(session, createRelay(socket, format, log))
    const detach = () => {
      session.socket = undefined
      switchRelay(session, undefined)
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
      detach()
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
      if (session.socket === socket) detach()
      // Queued audio plays out.
      spurt?.stream.push(null)
    })
  }

  return {
    dispatch: (shardId, event, data) => {
      if (event === 'READY' || event === 'RESUMED') return started(shardId, event === 'RESUMED')
      const voice = data as { guild_id?: string; user_id?: string; channel_id?: string | null }
      if (voice.guild_id === undefined) return
      const adapter = adapters.get(voice.guild_id)
      if (event === 'VOICE_STATE_UPDATE' && voice.user_id === botId) {
        const session = sessions.get(voice.guild_id)
        // Moved to a channel whose chat has no notice: the agent must join it to receive again.
        if (session?.receiving !== undefined && voice.channel_id !== session.receiving) {
          deafen(session, voice.channel_id ?? null)
          for (const userId of [...session.people.keys()]) depart(session, userId)
        }
        adapter?.onVoiceStateUpdate(data as Parameters<typeof adapter.onVoiceStateUpdate>[0])
      }
      if (event === 'VOICE_SERVER_UPDATE') {
        adapter?.onVoiceServerUpdate(data as Parameters<typeof adapter.onVoiceServerUpdate>[0])
      }
    },
    dropped: (shardId) => {
      online.delete(shardId)
    },
    join: async (guildId, channelId, receive = false) => {
      await untilOnline(guildId)
      let session = sessions.get(guildId)
      if (session?.connection.joinConfig.channelId !== channelId) {
        if (session !== undefined) destroy(session, LEFT)
        session = open(guildId, channelId)
      }
      await session.ready
      return receive ? listen(session) : deafen(session)
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
    reconsider: (guildId, userId) => {
      for (const session of sessions.values()) {
        if (guildId === undefined || session.guildId === guildId) check(session, userId)
      }
    },
    close: () => {
      for (const session of sessions.values()) destroy(session, OFFLINE)
      return new Set([...unsentLeaves.keys()].flatMap((guildId) => shardOf(guildId) ?? []))
    },
  }
}
