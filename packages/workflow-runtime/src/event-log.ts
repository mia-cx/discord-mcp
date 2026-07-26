import type { PersistenceError } from '@discord-mcp/core'
import { Database } from '@discord-mcp/persistence'
import { Context, Effect, Layer } from 'effect'

/**
 * The persistent event log.
 *
 * The Gateway's in-memory ring is bounded and dies with the process. This is the durable copy, and
 * it is what makes a cursor mean something across a restart: an agent that read up to sequence
 * 4,120 yesterday can ask for what came after it today.
 *
 * Separate from `workflow_executions`, which records what the system *did*. This records what it
 * *saw*, including events no workflow was subscribed to.
 */

export interface LoggedEvent {
  readonly sequence: number
  readonly type: string
  readonly guildId: string | null
  readonly channelId: string | null
  readonly correlationId: string
  readonly causationId: string | null
  readonly receivedAt: number
  readonly payload: unknown
}

export interface EventQuery {
  /** Strictly after this sequence. Absent means from the beginning of what is retained. */
  readonly cursor?: number
  readonly eventTypes?: ReadonlyArray<string>
  readonly guildId?: string
  readonly limit: number
}

export class EventLog extends Context.Service<
  EventLog,
  {
    readonly append: (event: {
      readonly type: string
      readonly discordEventId?: string
      readonly shardId?: number
      readonly guildId?: string
      readonly channelId?: string
      readonly correlationId: string
      readonly causationId?: string
      readonly receivedAt: number
      readonly payload: unknown
    }) => Effect.Effect<number, PersistenceError>
    readonly read: (
      query: EventQuery,
    ) => Effect.Effect<
      { readonly events: ReadonlyArray<LoggedEvent>; readonly cursor: number },
      PersistenceError
    >
    readonly latestCursor: Effect.Effect<number, PersistenceError>
  }
>()('workflow-runtime/EventLog') {
  static readonly layer = Layer.effect(EventLog)(
    Effect.gen(function* () {
      const db = yield* Database

      const latestCursor = Effect.map(
        db.query<{ latest: number | null }>('SELECT MAX(sequence) AS latest FROM gateway_events'),
        (rows) => rows[0]?.latest ?? 0,
      )

      return {
        append: (event) =>
          Effect.gen(function* () {
            yield* db.execute(
              `INSERT INTO gateway_events
                 (event_type, discord_event_id, shard_id, guild_id, channel_id, payload_json,
                  correlation_id, causation_id, received_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                event.type,
                event.discordEventId ?? null,
                event.shardId ?? null,
                event.guildId ?? null,
                event.channelId ?? null,
                JSON.stringify(event.payload),
                event.correlationId,
                event.causationId ?? null,
                event.receivedAt,
              ],
            )

            // The row's own sequence, not a counter this process keeps: after a restart a local
            // counter would start again and hand out sequences that already exist.
            return yield* latestCursor
          }),

        read: (query) =>
          Effect.gen(function* () {
            const types = query.eventTypes ?? []
            const rows = yield* db.query<{
              sequence: number
              event_type: string
              guild_id: string | null
              channel_id: string | null
              payload_json: string
              correlation_id: string
              causation_id: string | null
              received_at: number
            }>(
              `SELECT * FROM gateway_events
               WHERE sequence > ?
                 AND (? = 0 OR event_type IN (${types.map(() => '?').join(',') || "''"}))
                 AND (? IS NULL OR guild_id = ?)
               ORDER BY sequence ASC
               LIMIT ?`,
              [
                query.cursor ?? 0,
                types.length,
                ...types,
                query.guildId ?? null,
                query.guildId ?? null,
                query.limit,
              ],
            )

            const events = rows.map((row) => ({
              sequence: row.sequence,
              type: row.event_type,
              guildId: row.guild_id,
              channelId: row.channel_id,
              correlationId: row.correlation_id,
              causationId: row.causation_id,
              receivedAt: row.received_at,
              payload: JSON.parse(row.payload_json) as unknown,
            }))

            // The caller's cursor when nothing matched, so an empty read does not rewind them to
            // the beginning of the log.
            return { events, cursor: events.at(-1)?.sequence ?? query.cursor ?? 0 }
          }),

        latestCursor,
      }
    }),
  )
}
