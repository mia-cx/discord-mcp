import { countIfAvailable, DiscordGatewayError } from '@discord-mcp/core'
import { DiscordRest } from '@discord-mcp/discord-api'
import type { REST } from '@discordjs/rest'
import { WebSocketManager, WebSocketShardEvents } from '@discordjs/ws'
import { GatewayIntentBits } from 'discord-api-types/v10'
import { Context, Effect, Layer, PubSub, Ref, Scope } from 'effect'
import { describeCloseCode, type NormalizedEvent, normalizeEvent } from './events.ts'

/**
 * The Gateway connection and the event ring.
 *
 * Mode defaults to `lazy`: REST-only operation opens no WebSocket, so the common case pays
 * nothing. The first Gateway-dependent call connects, through a single-flight latch so two
 * concurrent calls cannot open two sockets.
 */

export type GatewayMode = 'off' | 'lazy' | 'eager'

/** What the service needs from a socket. Narrow on purpose, so it can be doubled. */
export interface ShardConnection {
  readonly connect: () => Promise<void>
  readonly destroy: () => Promise<void>
  readonly onDispatch: (
    handler: (payload: { t?: string | null; d?: unknown }, shardId: number) => void,
  ) => void
  readonly onReady: (handler: (botUserId: string | undefined) => void) => void
  readonly onClosed: (handler: (code: number) => void) => void
}

export interface GatewayConfig {
  readonly mode: GatewayMode
  /** Intent names. Privileged ones are off unless named explicitly. */
  readonly intents: ReadonlyArray<string>
  /** How many recent events stay queryable in memory. */
  readonly bufferSize: number
  readonly maxWaitMs: number
  /**
   * Injectable so the whole event path — ring, cursor, filters, waits — is testable without a
   * socket, the same way `DiscordRest` is layer-swapped for the tool suite.
   */
  readonly createConnection?: (options: { intents: number }) => ShardConnection
}

/** Intents Discord refuses unless they are enabled in the Developer Portal first. */
export const PRIVILEGED_INTENTS = new Set(['GuildMembers', 'GuildPresences', 'MessageContent'])

export const resolveIntents = (
  names: ReadonlyArray<string>,
): Effect.Effect<{ bits: number; privileged: ReadonlyArray<string> }, DiscordGatewayError> => {
  const unknown = names.filter((n) => !(n in GatewayIntentBits))
  if (unknown.length > 0) {
    return Effect.fail(
      new DiscordGatewayError({
        message: `Unknown Gateway intent(s): ${unknown.join(', ')}.`,
        suggestion: `Valid intent names are ${Object.keys(GatewayIntentBits).join(', ')}. Discord closes the connection with code 4013 for an unrecognised intent.`,
      }),
    )
  }

  return Effect.succeed({
    bits: names.reduce(
      (acc, name) => acc | (GatewayIntentBits[name as keyof typeof GatewayIntentBits] as number),
      0,
    ),
    privileged: names.filter((n) => PRIVILEGED_INTENTS.has(n)),
  })
}

export interface EventQuery {
  /** Return events strictly after this sequence. */
  readonly cursor?: number
  readonly types?: ReadonlyArray<string>
  readonly guildId?: string
  readonly channelId?: string
  readonly includeBotAuthored?: boolean
  readonly limit: number
}

const matches = (event: NormalizedEvent, query: EventQuery): boolean => {
  if (query.types !== undefined && !query.types.includes(event.type)) return false
  if (query.guildId !== undefined && event.guildId !== query.guildId) return false
  if (query.channelId !== undefined && event.channelId !== query.channelId) return false
  // Self-authored events are excluded by default; including them is how a workflow loops.
  if (query.includeBotAuthored !== true && event.botAuthored) return false
  return true
}

export interface GatewayStatus {
  readonly mode: GatewayMode
  readonly connected: boolean
  readonly intents: ReadonlyArray<string>
  readonly privilegedIntents: ReadonlyArray<string>
  readonly latestCursor: number
  readonly bufferedEvents: number
  readonly lastCloseCode?: number
  readonly lastCloseGuidance?: string
}

/**
 * The real socket, sharing the REST instance so both transports use one token and one rate-limit
 * pool — which is what stops the Gateway's identify calls competing with tool traffic.
 */
const defaultConnection =
  (rest: REST) =>
  ({ intents }: { intents: number }): ShardConnection => {
    const ws = new WebSocketManager({ rest, intents })
    return {
      connect: async () => {
        await ws.connect()
      },
      destroy: async () => {
        await ws.destroy()
      },
      // ManagerShardEventsMap emits positional arguments, not an object.
      onDispatch: (handler) => {
        ws.on(WebSocketShardEvents.Dispatch, (payload, shardId) => handler(payload, shardId))
      },
      onReady: (handler) => {
        ws.on(WebSocketShardEvents.Ready, (data) => handler(data.user?.id))
      },
      onClosed: (handler) => {
        ws.on(WebSocketShardEvents.Closed, (code) => handler(code))
      },
    }
  }

export class DiscordGateway extends Context.Service<
  DiscordGateway,
  {
    /** Idempotent, single-flight. Safe to call from every Gateway-dependent tool. */
    readonly ensureConnected: Effect.Effect<void, DiscordGatewayError>
    readonly status: Effect.Effect<GatewayStatus>
    /** Events already received, newest last. */
    readonly recent: (query: EventQuery) => Effect.Effect<ReadonlyArray<NormalizedEvent>>
    /**
     * Subscribe first, then drain, then wait.
     *
     * An MCP call is request/response, so "subscribe, act, observe" cannot happen in one call. The
     * cursor closes that race: anything that arrived between the caller's action and this wait is
     * still in the ring and is returned before blocking.
     */
    readonly waitFor: (
      query: EventQuery,
      waitMs: number,
      onProgress?: (elapsedMs: number) => Effect.Effect<void>,
    ) => Effect.Effect<
      { events: ReadonlyArray<NormalizedEvent>; cursor: number },
      DiscordGatewayError
    >
    /** For tests and for the interactions router, which injects synthesized events. */
    readonly publish: (
      dispatch: { t: string; d: unknown },
      shardId?: number,
    ) => Effect.Effect<NormalizedEvent>
  }
>()('discord-gateway/DiscordGateway') {
  static readonly layer = (config: GatewayConfig) =>
    Layer.effect(DiscordGateway)(
      Effect.gen(function* () {
        const rest = yield* DiscordRest
        const { bits, privileged } = yield* resolveIntents(config.intents)

        // The layer's own scope. The socket's finalizer attaches here rather than to whichever
        // tool call happened to trigger the connection, so the connection outlives that call but
        // is still destroyed before the process exits.
        const applicationScope = yield* Effect.scope

        // A bounded ring, not an unbounded log. An automated system attached to a busy guild
        // produces events faster than anything reads them.
        const ring = yield* Ref.make<ReadonlyArray<NormalizedEvent>>([])
        const sequence = yield* Ref.make(0)
        const hub = yield* PubSub.sliding<NormalizedEvent>(config.bufferSize)
        const manager = yield* Ref.make<ShardConnection | undefined>(undefined)
        const connecting = yield* Ref.make(false)
        const lastClose = yield* Ref.make<number | undefined>(undefined)
        const botUserId = yield* Ref.make<string | undefined>(undefined)

        const record = (dispatch: { t?: string | null; d?: unknown }, shardId: number) =>
          Effect.gen(function* () {
            const next = yield* Ref.updateAndGet(sequence, (n) => n + 1)
            const at = yield* Effect.clockWith((c) => c.currentTimeMillis)

            const event = normalizeEvent({
              dispatch,
              shardId,
              sequence: next,
              receivedAt: at,
              correlationId: `gw-${next}`,
              botUserId: yield* Ref.get(botUserId),
            })

            yield* Ref.update(ring, (events) => [...events, event].slice(-config.bufferSize))
            yield* PubSub.publish(hub, event)
            yield* countIfAvailable('gateway.event')
            return event
          })

        const connect = Effect.gen(function* () {
          if (config.mode === 'off') {
            return yield* Effect.fail(
              new DiscordGatewayError({
                message: 'The Gateway is disabled.',
                suggestion:
                  'Set DISCORD_MCP_GATEWAY_MODE to "lazy" or "eager" and restart. Gateway-dependent tools cannot work without a connection.',
              }),
            )
          }

          const existing = yield* Ref.get(manager)
          if (existing !== undefined) return

          // Single-flight. Two concurrent Gateway-dependent calls must not open two sockets.
          const alreadyConnecting = yield* Ref.getAndSet(connecting, true)
          if (alreadyConnecting) {
            yield* Effect.repeat(
              Effect.flatMap(Ref.get(manager), (m) =>
                m === undefined ? Effect.fail('pending' as const) : Effect.void,
              ).pipe(Effect.catch(() => Effect.sleep('50 millis'))),
              { times: 200 },
            )
            return
          }

          const create = config.createConnection ?? defaultConnection(rest.raw)

          const ws = yield* Effect.provideService(
            Effect.acquireRelease(
              Effect.sync(() => create({ intents: bits })),
              (client) => Effect.promise(() => client.destroy()).pipe(Effect.ignore),
            ),
            Scope.Scope,
            applicationScope,
          )

          ws.onDispatch((payload, shardId) => {
            void Effect.runPromise(record(payload, shardId)).catch(() => undefined)
          })
          ws.onReady((id) => {
            void Effect.runPromise(Ref.set(botUserId, id)).catch(() => undefined)
          })
          ws.onClosed((code) => {
            void Effect.runPromise(
              Effect.andThen(Ref.set(lastClose, code), countIfAvailable('gateway.reconnect')),
            ).catch(() => undefined)
          })

          yield* Effect.tryPromise({
            try: () => ws.connect(),
            catch: (cause) =>
              new DiscordGatewayError({
                message: `The Gateway connection failed: ${String(cause)}`,
                suggestion:
                  privileged.length === 0
                    ? 'Check DISCORD_TOKEN and network egress to gateway.discord.gg.'
                    : `This bot requests the privileged intent(s) ${privileged.join(', ')}. Enable them at discord.com/developers/applications/<application-id>/bot, then restart.`,
              }),
          })

          yield* Ref.set(manager, ws)
          yield* Ref.set(connecting, false)
        })

        const currentStatus = Effect.gen(function* () {
          const code = yield* Ref.get(lastClose)
          return {
            mode: config.mode,
            connected: (yield* Ref.get(manager)) !== undefined,
            intents: config.intents,
            privilegedIntents: privileged,
            latestCursor: yield* Ref.get(sequence),
            bufferedEvents: (yield* Ref.get(ring)).length,
            ...(code === undefined
              ? {}
              : { lastCloseCode: code, lastCloseGuidance: describeCloseCode(code) }),
          } satisfies GatewayStatus
        })

        const recent = (query: EventQuery) =>
          Effect.map(Ref.get(ring), (events) =>
            events
              .filter((e) => e.sequence > (query.cursor ?? 0) && matches(e, query))
              .slice(-query.limit),
          )

        const waitFor = (
          query: EventQuery,
          waitMs: number,
          onProgress?: (elapsedMs: number) => Effect.Effect<void>,
        ) =>
          // Scoped so the subscription is released when the wait ends, however it ends. Leaking
          // one per call would slowly starve the sliding hub.
          Effect.scoped(
            Effect.gen(function* () {
              yield* connect

              // Subscribe BEFORE draining. If an event lands between the drain and the subscribe it
              // would be lost, which is exactly the race this ordering exists to close.
              const subscription = yield* PubSub.subscribe(hub)
              const buffered = yield* recent(query)

              if (buffered.length > 0) {
                return {
                  events: buffered,
                  cursor: buffered.at(-1)?.sequence ?? query.cursor ?? 0,
                }
              }

              // Take until the deadline. `Effect.timeout` on the whole loop rather than per take,
              // so the wait ends on time even if events keep arriving that do not match the filter.
              const collected: NormalizedEvent[] = []
              yield* Effect.timeout(
                Effect.gen(function* () {
                  while (collected.length < query.limit) {
                    const event = yield* PubSub.take(subscription)
                    if (event.sequence > (query.cursor ?? 0) && matches(event, query)) {
                      collected.push(event)
                    }
                  }
                }),
                `${waitMs} millis`,
              ).pipe(Effect.ignore)

              if (onProgress !== undefined) yield* onProgress(waitMs)
              const events = collected
              return {
                events,
                // A fresh cursor even when nothing arrived, so the caller can wait again without
                // re-reading everything.
                cursor: events.at(-1)?.sequence ?? (yield* Ref.get(sequence)),
              }
            }),
          )

        if (config.mode === 'eager') yield* connect

        return {
          ensureConnected: connect,
          status: currentStatus,
          recent,
          waitFor,
          publish: (dispatch, shardId = 0) => record(dispatch, shardId),
        }
      }),
    )
}
