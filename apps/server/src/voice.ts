import { type IncomingMessage, STATUS_CODES } from 'node:http'
import type { Duplex } from 'node:stream'
import { type BotVoice, PCM_SAMPLE_RATES } from '@discord-mcp/bot-host'
import { DiscordGatewayError, defineTool, Snowflake } from '@discord-mcp/core'
import { Effect, Schema } from 'effect'

/** Where agents open the voice WebSocket. */
export const VOICE_PATH = '/voice'

const offline = () =>
  new DiscordGatewayError({
    message: 'The bot is offline: Discord refused its Gateway session.',
    suggestion: 'Voice needs the bot online. Reset its token if Discord rejected it.',
  })

const GuildId = Snowflake.annotate({ description: 'The server (guild) of the voice channel.' })

/**
 * The request bot's voice tools. `voice` finds the bot's voice at call time; `socketUrl` is the
 * voice WebSocket's public URL.
 */
export const voiceTools = (voice: () => BotVoice | undefined, socketUrl: string) => [
  defineTool({
    name: 'discord_voice_join',
    title: 'Join a voice channel',
    description: [
      'Join this bot to a voice channel so it can play audio there. The bot needs View Channel, Connect, and Speak.',
      'Joining another channel in the same server moves the bot and closes its open voice socket.',
      '',
      `Then open a WebSocket to the returned socket URL with the same Authorization and X-Discord-Bot-Token headers, adding codec=opus, or codec=pcm16&sample_rate=<${PCM_SAMPLE_RATES.join('|')}>&channels=<1|2>.`,
      'Send audio as binary messages: one 20 ms, 48 kHz stereo Opus packet per message, or little-endian 16-bit PCM, interleaved when stereo.',
      'The bot speaks while audio arrives and stops when it pauses. The socket only sends audio; it receives none.',
    ].join('\n'),
    toolset: 'api',
    risk: 'write',
    scopes: [],
    annotations: { idempotentHint: true, openWorldHint: true },
    input: Schema.Struct({
      guildId: GuildId,
      channelId: Snowflake.annotate({ description: 'The voice channel to join.' }),
    }),
    handler: ({ guildId, channelId }: { guildId: string; channelId: string }) =>
      Effect.gen(function* () {
        const bot = voice()
        if (bot === undefined) return yield* Effect.fail(offline())
        yield* Effect.tryPromise({
          try: () => bot.join(guildId, channelId),
          catch: (cause) =>
            new DiscordGatewayError({
              message: cause instanceof Error ? cause.message : String(cause),
              suggestion: 'Call discord_permissions_explain for the channel, then try again.',
            }),
        })
        return { socket: `${socketUrl}?guild_id=${guildId}` }
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
