import { type IncomingMessage, STATUS_CODES } from 'node:http'
import type { Duplex } from 'node:stream'
import {
  type BotRuntimes,
  type BotVoice,
  MAX_VOICE_MESSAGE_BYTES,
  PCM_SAMPLE_RATES,
  parseAudioFormat,
} from '@discord-mcp/bot-host'
import { DiscordGatewayError, defineTool, Snowflake } from '@discord-mcp/core'
import { Effect, Schema } from 'effect'
import { WebSocketServer } from 'ws'

/** Where agents open the voice WebSocket, on the same origin as `/mcp`. */
export const VOICE_PATH = '/voice'

const SNOWFLAKE = /^\d{17,20}$/
const KEEPALIVE_MS = 30_000

/**
 * Voice sockets only carry audio in, so TCP keepalive is what notices a peer that vanished without
 * closing, whose socket would otherwise keep its bot online for good.
 */
export const keepAlive = (request: IncomingMessage) =>
  request.socket.setKeepAlive(true, KEEPALIVE_MS)

const offline = () =>
  new DiscordGatewayError({
    message: 'The bot is offline: Discord refused its Gateway session.',
    suggestion: 'Voice needs the bot online. Reset its token if Discord rejected it.',
  })

const GuildId = Snowflake.annotate({ description: 'The server (guild) of the voice channel.' })

/** The request bot's voice tools. `voice` finds the bot's voice at call time. */
export const voiceTools = (voice: () => BotVoice | undefined) => [
  defineTool({
    name: 'discord_voice_join',
    title: 'Join a voice channel',
    description: [
      'Join this bot to a voice channel so it can play audio there, and with receive: true, hear it. The bot needs View Channel, Connect, and Speak.',
      'Joining another channel in the same server moves the bot and closes its open voice socket. Joining the same channel again switches receiving on or off.',
      '',
      `Then open a WebSocket to the returned socket path, on the same host as /mcp (wss: for https:), with the same Authorization and X-Discord-Bot-Token headers, adding codec=opus, or codec=pcm16&sample_rate=<${PCM_SAMPLE_RATES.join('|')}>&channels=<1|2>.`,
      'Send audio as binary messages: one 20 ms, 48 kHz stereo Opus packet per message, or little-endian 16-bit PCM, interleaved when stereo.',
      'The bot speaks while audio arrives and stops when it pauses.',
      '',
      "With receive: true, the bot first posts a notice in the voice channel's chat whose buttons let anyone opt out of being relayed; it needs Send Messages there. The result's receiving says whether it worked, and reason why not.",
      'While receiving, each binary message the socket sends is one speaker: their user ID as 8 bytes, big-endian, then one packet in your codec. Text messages are JSON events: {"type":"join"|"leave","user_id"} and {"type":"speaking","user_id","speaking":true|false}.',
      'People who opted out never appear. Receiving is unsupported by Discord and best-effort: packets may be lost or arrive out of order, and a speaker is heard only once Discord names them.',
    ].join('\n'),
    toolset: 'api',
    risk: 'write',
    scopes: [],
    annotations: { idempotentHint: true, openWorldHint: true },
    input: Schema.Struct({
      guildId: GuildId,
      channelId: Snowflake.annotate({ description: 'The voice channel to join.' }),
      receive: Schema.optional(Schema.Boolean).annotate({
        description: 'Relay what people say to the voice socket, after posting a notice.',
      }),
    }),
    handler: ({
      guildId,
      channelId,
      receive = false,
    }: {
      guildId: string
      channelId: string
      receive?: boolean | undefined
    }) =>
      Effect.gen(function* () {
        const bot = voice()
        if (bot === undefined) return yield* Effect.fail(offline())
        const joined = yield* Effect.tryPromise({
          try: () => bot.join(guildId, channelId, receive),
          catch: (cause) =>
            new DiscordGatewayError({
              message: cause instanceof Error ? cause.message : String(cause),
              suggestion: 'Call discord_permissions_explain for the channel, then try again.',
            }),
        })
        return { socket: `${VOICE_PATH}?guild_id=${guildId}`, ...joined }
      }),
  }),
  defineTool({
    name: 'discord_voice_leave',
    title: 'Leave a voice channel',
    description:
      "Disconnect this bot from the server's voice channel and close its voice socket. Returns left: false when the bot was not in one.",
    toolset: 'api',
    risk: 'write',
    scopes: [],
    annotations: { idempotentHint: true, openWorldHint: true },
    input: Schema.Struct({ guildId: GuildId }),
    handler: ({ guildId }: { guildId: string }) =>
      Effect.sync(() => ({ left: voice()?.leave(guildId) ?? false })),
  }),
]

/** The upgrade request as a fetch `Request`, for the relay's credential checks. */
export const upgradeRequest = (request: IncomingMessage): Request =>
  new Request(new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`), {
    headers: Object.entries(request.headers).flatMap(([name, value]) =>
      value === undefined ? [] : [[name, Array.isArray(value) ? value.join(', ') : value]],
    ),
  })

/** Answer an upgrade request with an ordinary HTTP response and close the connection. */
export const refuseUpgrade = async (socket: Duplex, response: Response) => {
  const body = await response.text()
  const head = [
    `HTTP/1.1 ${response.status} ${STATUS_CODES[response.status] ?? ''}`,
    ...[...response.headers].map(([name, value]) => `${name}: ${value}`),
    `content-length: ${Buffer.byteLength(body)}`,
    'connection: close',
  ]
  socket.end(`${head.join('\r\n')}\r\n\r\n${body}`)
}

/**
 * Takes over a voice socket upgrade whose relay login was already checked. `botId` is the bot the
 * token names; whoever accepts the socket still checks the token with Discord.
 */
export type VoiceUpgrade = (
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  credential: string,
  botId: string,
) => void

export interface VoiceUpgradeOptions {
  readonly bots: Pick<BotRuntimes, 'use' | 'voice'>
  /** Checks the token with Discord: a refusal, or `undefined` once Discord accepts it as `botId`. */
  readonly checkToken: (credential: string, botId: string) => Promise<Response | undefined>
}

/**
 * Accepts voice sockets for this process's bots: the query names a server where the bot is in a
 * voice channel and the codec, and Discord accepts the token.
 */
export const createVoiceUpgrade = ({ bots, checkToken }: VoiceUpgradeOptions): VoiceUpgrade => {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_VOICE_MESSAGE_BYTES })

  const admit = async (request: IncomingMessage, credential: string, botId: string) => {
    // The path and query only: central already checked the host.
    const query = new URL(request.url ?? '/', 'http://voice').searchParams
    const guildId = query.get('guild_id') ?? ''
    const format = parseAudioFormat(query)
    const invalid = (description: string) =>
      Response.json(
        { error: 'invalid_request', error_description: description },
        { status: 400, headers: { 'cache-control': 'no-store' } },
      )
    if (!SNOWFLAKE.test(guildId)) return invalid('guild_id must be a server ID.')
    if (typeof format === 'string') return invalid(format)
    const refused = await checkToken(credential, botId)
    if (refused !== undefined) return refused
    // Opening the socket counts as an agent call.
    void bots.use(botId, credential)
    const voice = bots.voice(botId)
    if (voice?.joined(guildId) !== true) {
      return Response.json(
        {
          error: 'not_joined',
          error_description: 'Join a voice channel in this server with discord_voice_join first.',
        },
        { status: 409, headers: { 'cache-control': 'no-store' } },
      )
    }
    return { voice, guildId, format }
  }

  return (request, socket, head, credential, botId) => {
    keepAlive(request)
    admit(request, credential, botId).then(
      (admitted) => {
        if (admitted instanceof Response) return refuseUpgrade(socket, admitted)
        sockets.handleUpgrade(request, socket, head, (ws) => {
          const { voice, guildId, format } = admitted
          if (!voice.attach(guildId, ws, format)) ws.close(1000, 'The bot left the voice channel.')
        })
      },
      () => socket.destroy(),
    )
  }
}
