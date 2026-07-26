import { Schema } from 'effect'

/**
 * Normalized Gateway events.
 *
 * Nothing from a library crosses a boundary here: every event is plain serializable data with a
 * persistent monotonic sequence number, so it can go into SQLite, out over MCP, and into a
 * sandboxed workflow without any of those needing to know what produced it.
 */

export const NormalizedEvent = Schema.Struct({
  /** Persistent and monotonic. This is what a cursor addresses. */
  sequence: Schema.Int,
  type: Schema.String,
  /** Discord's own event ID where the payload carries one; otherwise absent. */
  discordEventId: Schema.optionalKey(Schema.String),
  shardId: Schema.optionalKey(Schema.Int),
  guildId: Schema.optionalKey(Schema.String),
  channelId: Schema.optionalKey(Schema.String),
  /** Whether this bot authored the thing that produced the event. */
  botAuthored: Schema.Boolean,
  receivedAt: Schema.String,
  correlationId: Schema.String,
  causationId: Schema.optionalKey(Schema.String),
  payload: Schema.Unknown,
})
export type NormalizedEvent = typeof NormalizedEvent.Type

interface RawDispatch {
  readonly t?: string | null
  readonly d?: unknown
}

const idOf = (payload: Record<string, unknown>, key: string): string | undefined => {
  const value = payload[key]
  return typeof value === 'string' ? value : undefined
}

/**
 * Discord puts the interesting IDs in different places per event, and a workflow grant is checked
 * against guild and channel, so pulling them out here is what makes grants enforceable at all.
 */
export const normalizeEvent = (input: {
  readonly dispatch: RawDispatch
  readonly shardId: number
  readonly sequence: number
  readonly receivedAt: number
  readonly correlationId: string
  readonly botUserId: string | undefined
  readonly causationId?: string
}): NormalizedEvent => {
  const data = (input.dispatch.d ?? {}) as Record<string, unknown>
  const author = data.author as { id?: string; bot?: boolean } | undefined
  const member = data.member as { user?: { id?: string } } | undefined

  // Self-authored events are the loop hazard: a workflow that posts a message and reacts to
  // MESSAGE_CREATE would otherwise trigger itself forever.
  const actorId = author?.id ?? idOf(data, 'user_id') ?? member?.user?.id
  const botAuthored = input.botUserId !== undefined && actorId === input.botUserId

  return {
    sequence: input.sequence,
    type: input.dispatch.t ?? 'UNKNOWN',
    ...(idOf(data, 'id') === undefined ? {} : { discordEventId: idOf(data, 'id') as string }),
    shardId: input.shardId,
    ...(idOf(data, 'guild_id') === undefined ? {} : { guildId: idOf(data, 'guild_id') as string }),
    ...(idOf(data, 'channel_id') === undefined
      ? {}
      : { channelId: idOf(data, 'channel_id') as string }),
    botAuthored,
    receivedAt: new Date(input.receivedAt).toISOString(),
    correlationId: input.correlationId,
    ...(input.causationId === undefined ? {} : { causationId: input.causationId }),
    payload: input.dispatch.d ?? {},
  }
}

/**
 * Gateway close codes mapped to something an operator can act on.
 *
 * 4014 is the most common new-bot failure by a wide margin, and the raw code tells nobody
 * anything, so it names the exact page to open.
 */
export const CLOSE_CODE_GUIDANCE: Record<number, string> = {
  4000: 'Unknown error. Discord will usually let the shard resume; no action needed unless it repeats.',
  4001: 'An invalid opcode was sent. This is a bug in discord-mcp, not a configuration problem.',
  4002: 'An invalid payload was sent. This is a bug in discord-mcp.',
  4003: 'A payload was sent before identifying. This is a bug in discord-mcp.',
  4004: 'Authentication failed: the bot token is invalid or was reset. Check DISCORD_TOKEN against the Developer Portal; the Gateway will not reconnect until it is corrected.',
  4005: 'Already authenticated. This is a bug in discord-mcp.',
  4007: 'Invalid resume sequence. The shard will re-identify automatically.',
  4008: 'Rate limited on the Gateway. Slow the rate of outbound payloads.',
  4009: 'Session timed out. The shard will reconnect automatically.',
  4010: 'Invalid shard configuration.',
  4011: 'Sharding required: this bot is in too many guilds for a single shard.',
  4012: 'Invalid API version. This is a bug in discord-mcp.',
  4013: 'An intent name in DISCORD_MCP_GATEWAY_INTENTS is not a real Discord intent. Check the spelling.',
  4014: 'Disallowed privileged intent. The bot requested MESSAGE_CONTENT, GUILD_MEMBERS, or GUILD_PRESENCES without enabling it. Turn it on at discord.com/developers/applications/<application-id>/bot, then restart. Discord will keep refusing the connection until you do.',
}

export const describeCloseCode = (code: number): string =>
  CLOSE_CODE_GUIDANCE[code] ??
  `Gateway closed with code ${code}. Discord does not document this code; if it repeats, check the Developer Portal for bot status.`
