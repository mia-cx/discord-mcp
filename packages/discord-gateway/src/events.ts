import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { Database } from '@discord-mcp/persistence'

export interface GatewayEvent {
  readonly sequence: number
  readonly discordEventId?: string
  readonly eventType: string
  readonly payload: unknown
  readonly correlationId: string
  readonly causationId?: string
  readonly causalDepth: number
  readonly receivedAt: string
}

export interface EventFilter {
  readonly types?: ReadonlyArray<string>
  readonly cursor?: string
  readonly limit?: number
  readonly predicate?: (event: GatewayEvent) => boolean
}

const encodeCursor = (sequence: number): string =>
  Buffer.from(JSON.stringify({ sequence })).toString('base64url')

const decodeCursor = (cursor: string | undefined): number => {
  if (!cursor) return 0
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as { sequence?: unknown }
    if (typeof parsed.sequence !== 'number' || !Number.isInteger(parsed.sequence)) throw new Error()
    return parsed.sequence
  } catch {
    throw new Error('Invalid Gateway event cursor')
  }
}

export class GatewayEventStore {
  readonly #events = new EventEmitter()

  constructor(
    readonly database: Database,
    readonly maximumPersisted = 10_000,
    readonly maximumWaitMs = 120_000,
  ) {
    this.#events.setMaxListeners(1_000)
  }

  subscribe(listener: (event: GatewayEvent) => void): () => void {
    this.#events.on('event', listener)
    return () => this.#events.off('event', listener)
  }

  publish(input: {
    readonly eventType: string
    readonly payload: unknown
    readonly discordEventId?: string
    readonly correlationId?: string
    readonly causationId?: string
    readonly causalDepth?: number
  }): GatewayEvent {
    const receivedAt = new Date().toISOString()
    const result = this.database.run(
      `INSERT OR IGNORE INTO gateway_events
       (discord_event_id, event_type, payload_json, correlation_id, causation_id, causal_depth,
        received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      input.discordEventId ?? null,
      input.eventType,
      JSON.stringify(input.payload),
      input.correlationId ?? randomUUID(),
      input.causationId ?? null,
      input.causalDepth ?? 0,
      receivedAt,
    )
    const sequence =
      result.changes === 1
        ? Number(result.lastInsertRowid)
        : input.discordEventId === undefined
          ? undefined
          : this.database.get<{ sequence: number }>(
              'SELECT sequence FROM gateway_events WHERE discord_event_id = ?',
              input.discordEventId,
            )?.sequence
    if (sequence === undefined) {
      throw new Error('Gateway event insert did not return a durable sequence')
    }
    const event = this.get(sequence)
    if (result.changes === 0) return event
    this.database.run(
      `DELETE FROM gateway_events WHERE sequence <=
       (SELECT MAX(sequence) - ? FROM gateway_events)`,
      this.maximumPersisted,
    )
    this.#events.emit('event', event)
    return event
  }

  get(sequence: number): GatewayEvent {
    const row = this.database.get<{
      sequence: number
      discord_event_id: string | null
      event_type: string
      payload_json: string
      correlation_id: string
      causation_id: string | null
      causal_depth: number
      received_at: string
    }>('SELECT * FROM gateway_events WHERE sequence = ?', sequence)
    if (!row) throw new Error(`Gateway event ${sequence} does not exist`)
    return mapRow(row)
  }

  recent(filter: EventFilter = {}): {
    readonly events: ReadonlyArray<GatewayEvent>
    readonly cursor: string
  } {
    const after = decodeCursor(filter.cursor)
    const limit = Math.max(1, Math.min(filter.limit ?? 50, 200))
    const types = [...new Set(filter.types ?? [])]
    const batchSize = Math.max(limit, 200)
    const events: Array<GatewayEvent> = []
    let scannedThrough = after
    for (;;) {
      const rows = this.database.all<{
        sequence: number
        discord_event_id: string | null
        event_type: string
        payload_json: string
        correlation_id: string
        causation_id: string | null
        causal_depth: number
        received_at: string
      }>(
        `SELECT * FROM gateway_events WHERE sequence > ?
         ${types.length === 0 ? '' : `AND event_type IN (${types.map(() => '?').join(', ')})`}
         ORDER BY sequence LIMIT ?`,
        scannedThrough,
        ...types,
        batchSize,
      )
      if (rows.length === 0) break
      for (const row of rows) {
        scannedThrough = row.sequence
        const event = mapRow(row)
        if (filter.predicate === undefined || filter.predicate(event)) events.push(event)
        if (events.length >= limit) break
      }
      if (events.length >= limit || rows.length < batchSize) break
    }
    const latest =
      events.at(-1)?.sequence ??
      this.database.get<{ sequence: number | null }>(
        `SELECT MAX(sequence) AS sequence FROM gateway_events WHERE sequence > ?
         ${types.length === 0 ? '' : `AND event_type IN (${types.map(() => '?').join(', ')})`}`,
        after,
        ...types,
      )?.sequence ??
      after
    return { events, cursor: encodeCursor(latest) }
  }

  async wait(
    filter: EventFilter & { readonly waitMs?: number },
    signal?: AbortSignal,
  ): Promise<{
    readonly events: ReadonlyArray<GatewayEvent>
    readonly cursor: string
    readonly timedOut: boolean
  }> {
    const waitMs = Math.max(0, Math.min(filter.waitMs ?? 25_000, this.maximumWaitMs))
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (timedOut: boolean) => {
        if (settled) return
        settled = true
        cleanup()
        const result = this.recent(filter)
        resolve({ ...result, timedOut: timedOut && result.events.length === 0 })
      }
      const onEvent = (event: GatewayEvent) => {
        if (
          event.sequence > decodeCursor(filter.cursor) &&
          (filter.types === undefined || filter.types.includes(event.eventType)) &&
          (filter.predicate === undefined || filter.predicate(event))
        ) {
          finish(false)
        }
      }
      const onAbort = () => {
        if (settled) return
        settled = true
        cleanup()
        reject(signal?.reason ?? new Error('aborted'))
      }
      const timer = setTimeout(() => finish(true), waitMs)
      const cleanup = () => {
        clearTimeout(timer)
        this.#events.off('event', onEvent)
        signal?.removeEventListener('abort', onAbort)
      }
      // Subscribe first, then drain persistence: this closes the action→wait race.
      this.#events.on('event', onEvent)
      signal?.addEventListener('abort', onAbort, { once: true })
      const persisted = this.recent(filter)
      if (persisted.events.length > 0 || waitMs === 0) finish(false)
    })
  }
}

const mapRow = (row: {
  readonly sequence: number
  readonly discord_event_id: string | null
  readonly event_type: string
  readonly payload_json: string
  readonly correlation_id: string
  readonly causation_id: string | null
  readonly causal_depth: number
  readonly received_at: string
}): GatewayEvent => ({
  sequence: row.sequence,
  ...(row.discord_event_id === null ? {} : { discordEventId: row.discord_event_id }),
  eventType: row.event_type,
  payload: JSON.parse(row.payload_json),
  correlationId: row.correlation_id,
  ...(row.causation_id === null ? {} : { causationId: row.causation_id }),
  causalDepth: row.causal_depth,
  receivedAt: row.received_at,
})
