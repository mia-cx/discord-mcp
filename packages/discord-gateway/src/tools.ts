import { defineTool, McpRequestContext, Snowflake } from '@discord-mcp/core'
import { Effect, Schema } from 'effect'
import { DiscordGateway } from './gateway.ts'

/** Inside every MCP client's 60-second default, so a wait cannot look like a hung server. */
const DEFAULT_WAIT_MS = 25_000
const MAX_WAIT_MS = 120_000
const PROGRESS_INTERVAL_MS = 5_000

const StatusInput = Schema.Struct({})

export const gatewayStatus = defineTool<typeof StatusInput.Type, unknown, DiscordGateway>({
  name: 'discord_gateway_status',
  title: 'Gateway connection status',
  description: [
    'Report whether the Gateway is connected, which intents are configured, the latest event',
    'cursor, and — if the connection dropped — what the close code means and what to do about it.',
    '',
    'Does not connect. Use this first when a Gateway-dependent tool is failing.',
  ].join('\n'),
  toolset: 'operator',
  gate: 'gateway',
  risk: 'read',
  scopes: ['mcp:read'],
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: StatusInput,
  handler: () => Effect.flatMap(DiscordGateway, (gw) => gw.status),
})

const eventFilters = {
  types: Schema.optionalKey(
    Schema.Array(Schema.String).annotate({
      description: 'Discord event names, e.g. ["MESSAGE_CREATE","GUILD_MEMBER_ADD"].',
    }),
  ),
  guildId: Schema.optionalKey(Snowflake),
  channelId: Schema.optionalKey(Snowflake),
  includeBotAuthored: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        'Include events this bot caused. Off by default — including them is how an automation ends up triggering itself.',
    }),
  ),
  limit: Schema.optionalKey(
    Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
  ),
  cursor: Schema.optionalKey(
    Schema.Int.annotate({ description: 'Return only events after this sequence number.' }),
  ),
}

const RecentInput = Schema.Struct(eventFilters)

export const gatewayRecentEvents = defineTool<typeof RecentInput.Type, unknown, DiscordGateway>({
  name: 'discord_gateway_recent_events',
  title: 'Read recent Gateway events',
  description: [
    'Read events already received, filtered by type, guild, or channel.',
    '',
    'Returns a cursor. Take a cursor here BEFORE performing an action, then pass it to',
    'discord_gateway_wait_for_event afterwards — that is what makes the observation race-free, since',
    'an MCP call is request/response and cannot subscribe and act at the same time.',
  ].join('\n'),
  toolset: 'operator',
  gate: 'gateway',
  risk: 'read',
  scopes: ['mcp:read'],
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: RecentInput,
  handler: (args) =>
    Effect.gen(function* () {
      const gw = yield* DiscordGateway
      yield* gw.ensureConnected

      const events = yield* gw.recent({
        ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
        ...(args.types === undefined ? {} : { types: args.types }),
        ...(args.guildId === undefined ? {} : { guildId: args.guildId }),
        ...(args.channelId === undefined ? {} : { channelId: args.channelId }),
        ...(args.includeBotAuthored === undefined
          ? {}
          : { includeBotAuthored: args.includeBotAuthored }),
        limit: args.limit ?? 50,
      })

      const status = yield* gw.status
      return {
        events,
        latestCursor: events.at(-1)?.sequence ?? status.latestCursor,
        count: events.length,
      }
    }),
})

const WaitInput = Schema.Struct({
  ...eventFilters,
  waitMs: Schema.optionalKey(
    Schema.Int.pipe(
      Schema.check(Schema.isBetween({ minimum: 100, maximum: MAX_WAIT_MS })),
    ).annotate({
      description: `How long to wait. Defaults to ${DEFAULT_WAIT_MS}ms, which is inside every MCP client's default timeout.`,
    }),
  ),
})

export const gatewayWaitForEvent = defineTool<typeof WaitInput.Type, unknown, DiscordGateway>({
  name: 'discord_gateway_wait_for_event',
  title: 'Wait for a Gateway event',
  description: [
    'Wait for matching events, draining anything that already arrived after the supplied cursor',
    'before blocking. Pass a cursor taken before your action, or an event that landed in between',
    'will be missed.',
    '',
    'A timeout is a SUCCESSFUL empty result with a fresh cursor, not an error — "nothing arrived"',
    'is a legitimate answer and flagging it as a failure would only invite pointless retries.',
    `Defaults to ${DEFAULT_WAIT_MS}ms, maximum ${MAX_WAIT_MS}ms.`,
  ].join('\n'),
  toolset: 'operator',
  gate: 'gateway',
  risk: 'read',
  scopes: ['mcp:read'],
  annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true },
  input: WaitInput,
  handler: (args) =>
    Effect.gen(function* () {
      const gw = yield* DiscordGateway
      const request = yield* Effect.serviceOption(McpRequestContext)
      const waitMs = args.waitMs ?? DEFAULT_WAIT_MS

      // Progress notifications keep a long wait from looking like a hung server, but only when
      // the client asked for them.
      const progressToken = request._tag === 'Some' ? request.value.progressToken : undefined
      const notify = request._tag === 'Some' ? request.value.notify : undefined

      const onProgress =
        progressToken === undefined || notify === undefined
          ? undefined
          : (elapsedMs: number) =>
              Effect.sync(() => {
                void notify({
                  method: 'notifications/progress',
                  params: {
                    progressToken,
                    progress: Math.min(elapsedMs, waitMs),
                    total: waitMs,
                    message: 'Waiting for a matching Gateway event',
                  },
                })
              })

      const result = yield* gw.waitFor(
        {
          ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
          ...(args.types === undefined ? {} : { types: args.types }),
          ...(args.guildId === undefined ? {} : { guildId: args.guildId }),
          ...(args.channelId === undefined ? {} : { channelId: args.channelId }),
          ...(args.includeBotAuthored === undefined
            ? {}
            : { includeBotAuthored: args.includeBotAuthored }),
          limit: args.limit ?? 10,
        },
        waitMs,
        onProgress,
      )

      return {
        events: result.events,
        cursor: result.cursor,
        timedOut: result.events.length === 0,
        ...(result.events.length === 0
          ? {
              note: `No matching event arrived within ${waitMs}ms. This is not an error. Wait again with cursor ${result.cursor} if you still expect one, or check discord_gateway_status if you expected the connection to be live.`,
            }
          : {}),
      }
    }),
})

/** Progress cadence, exported so the interval is stated once. */
export { PROGRESS_INTERVAL_MS }

export const gatewayTools = [gatewayStatus, gatewayRecentEvents, gatewayWaitForEvent]
