import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import type { Database } from '@discord-mcp/persistence'
import { Cause, Effect, Fiber, Schedule } from 'effect'

const redactValue = (value: unknown, key = ''): unknown => {
  if (/token|secret|authorization|credential|content|body|base64/i.test(key)) return '[redacted]'
  if (Array.isArray(value)) return value.map((item) => redactValue(item))
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, child]) => [childKey, redactValue(child, childKey)]),
    )
  }
  if (typeof value === 'string') {
    return value
      .replaceAll(/\b(?:Bot|Bearer)\s+[A-Za-z0-9._~+/-]{12,}/gi, '[redacted]')
      .replaceAll(/\bdcmcp_[A-Za-z0-9_-]+/g, '[redacted]')
  }
  return value
}

export interface StructuredLogInput {
  readonly level: 'debug' | 'info' | 'warning' | 'error'
  readonly event: string
  readonly requestId?: string
  readonly principalId?: string
  readonly workflowId?: string
  readonly revision?: number
  readonly executionId?: string
  readonly operationId?: string
  readonly correlationId?: string
  readonly causationId?: string
  readonly durationMs?: number
  readonly outcome?: 'success' | 'failure'
  readonly detail?: unknown
}

export const structuredLogRecord = (
  input: StructuredLogInput,
  now = new Date(),
): Readonly<Record<string, unknown>> => ({
  timestamp: now.toISOString(),
  level: input.level,
  event: input.event,
  ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
  ...(input.principalId === undefined ? {} : { principalId: input.principalId }),
  ...(input.workflowId === undefined ? {} : { workflowId: input.workflowId }),
  ...(input.revision === undefined ? {} : { revision: input.revision }),
  ...(input.executionId === undefined ? {} : { executionId: input.executionId }),
  ...(input.operationId === undefined ? {} : { operationId: input.operationId }),
  ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
  ...(input.causationId === undefined ? {} : { causationId: input.causationId }),
  ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
  ...(input.outcome === undefined ? {} : { outcome: input.outcome }),
  ...(input.detail === undefined ? {} : { detail: redactValue(input.detail) }),
})

export const writeStructuredLog = (input: StructuredLogInput): void => {
  process.stderr.write(`${JSON.stringify(structuredLogRecord(input))}\n`)
}

export class AuditLog {
  constructor(readonly database: Database) {}

  record(input: {
    readonly principalId?: string
    readonly action: string
    readonly targetType?: string
    readonly targetId?: string
    readonly requestId?: string
    readonly detail?: unknown
    readonly outcome: 'success' | 'failure'
  }): string {
    const id = randomUUID()
    this.database.run(
      `INSERT INTO audit_log
       (id, principal_id, action, target_type, target_id, request_id,
        detail_json, outcome, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.principalId ?? null,
      input.action,
      input.targetType ?? null,
      input.targetId ?? null,
      input.requestId ?? null,
      JSON.stringify(redactValue(input.detail ?? {})),
      input.outcome,
      new Date().toISOString(),
    )
    return id
  }
}

export class MetricsRegistry {
  readonly #counters = new Map<string, number>()
  readonly #gauges = new Map<string, number>()

  increment(name: string, labels: Readonly<Record<string, string>> = {}, amount = 1): void {
    const key = metricKey(name, labels)
    this.#counters.set(key, (this.#counters.get(key) ?? 0) + amount)
  }

  gauge(name: string, value: number, labels: Readonly<Record<string, string>> = {}): void {
    this.#gauges.set(metricKey(name, labels), value)
  }

  observe(name: string, value: number, labels: Readonly<Record<string, string>> = {}): void {
    this.increment(`${name}_count`, labels)
    this.increment(`${name}_sum`, labels, value)
  }

  initialize(names: ReadonlyArray<string>): void {
    for (const name of names) this.increment(name, {}, 0)
  }

  snapshot(): MetricsSnapshot {
    const samples = (entries: Iterable<readonly [string, number]>): ReadonlyArray<MetricSample> =>
      [...entries]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([series, value]) => ({ series, value }))
    return {
      counters: samples(this.#counters),
      gauges: samples(this.#gauges),
    }
  }

  render(): string {
    return [...this.#counters, ...this.#gauges]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key} ${value}`)
      .join('\n')
      .concat('\n')
  }
}

export interface MetricSample {
  readonly series: string
  readonly value: number
}

export interface MetricsSnapshot {
  readonly counters: ReadonlyArray<MetricSample>
  readonly gauges: ReadonlyArray<MetricSample>
}

export class RetentionManager {
  #fiber: Fiber.Fiber<unknown, never> | undefined

  constructor(
    readonly database: Database,
    readonly intervalMs = 60 * 60_000,
    readonly gatewayRetentionDays = 7,
    readonly workflowRetentionDays = 30,
    readonly auditRetentionDays = 90,
  ) {}

  start(): void {
    if (this.#fiber !== undefined) return
    const cleanup = Effect.sync(() => this.run()).pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() =>
          writeStructuredLog({
            level: 'error',
            event: 'retention.cleanup',
            outcome: 'failure',
            detail: { cause: Cause.pretty(cause) },
          }),
        ),
      ),
    )
    this.#fiber = Effect.runFork(cleanup.pipe(Effect.repeat(Schedule.spaced(this.intervalMs))))
  }

  async close(): Promise<void> {
    if (this.#fiber === undefined) return
    const fiber = this.#fiber
    this.#fiber = undefined
    await Effect.runPromise(Fiber.interrupt(fiber))
  }

  run(now = Date.now()): Readonly<Record<string, number>> {
    const expired = new Date(now).toISOString()
    const gatewayBefore = new Date(now - this.gatewayRetentionDays * 86_400_000).toISOString()
    const workflowEventBefore = new Date(now - 7 * 86_400_000).toISOString()
    const auditBefore = new Date(now - this.auditRetentionDays * 86_400_000).toISOString()
    return {
      oauthStates: Number(
        this.database.run(
          'DELETE FROM discord_oauth_authorization_states WHERE expires_at <= ?',
          expired,
        ).changes,
      ),
      interactionDeduplication: Number(
        this.database.run('DELETE FROM interaction_deduplication WHERE expires_at <= ?', expired)
          .changes,
      ),
      webhookReplays: Number(
        this.database.run('DELETE FROM webhook_replay_protection WHERE expires_at <= ?', expired)
          .changes,
      ),
      previewTokens: Number(
        this.database.run('DELETE FROM preview_tokens WHERE expires_at <= ?', expired).changes,
      ),
      gatewayEvents: Number(
        this.database.run('DELETE FROM gateway_events WHERE received_at < ?', gatewayBefore)
          .changes,
      ),
      workflowEvents: Number(
        this.database.run(
          `DELETE FROM workflow_events WHERE received_at < ? OR sequence IN (
             SELECT sequence FROM (
               SELECT sequence,
               ROW_NUMBER() OVER (PARTITION BY workflow_id ORDER BY sequence DESC) AS rank
               FROM workflow_events
             ) WHERE rank > 10000
           )`,
          workflowEventBefore,
        ).changes,
      ),
      componentEvents: Number(
        this.database.run(
          `DELETE FROM component_events WHERE received_at < ? OR sequence IN (
             SELECT sequence FROM (
               SELECT sequence,
               ROW_NUMBER() OVER (
                 PARTITION BY owner_type, owner_id ORDER BY sequence DESC
               ) AS rank
               FROM component_events
             ) WHERE rank > 10000
           )`,
          workflowEventBefore,
        ).changes,
      ),
      componentBindings: Number(
        this.database.run(
          `DELETE FROM component_bindings
           WHERE expires_at IS NOT NULL AND expires_at <= ?
           AND NOT EXISTS (
             SELECT 1 FROM component_events
             WHERE component_events.binding_handle = component_bindings.handle
           )`,
          expired,
        ).changes,
      ),
      workflowActionCausality: Number(
        this.database.run(
          'DELETE FROM workflow_action_causality WHERE created_at < ?',
          workflowEventBefore,
        ).changes,
      ),
      executionLogs: Number(
        this.database.run(
          `UPDATE workflow_executions SET logs = ''
           WHERE finished_at IS NOT NULL AND finished_at < ? AND logs != ''`,
          workflowEventBefore,
        ).changes,
      ),
      auditEntries: Number(
        this.database.run('DELETE FROM audit_log WHERE created_at < ?', auditBefore).changes,
      ),
      blobs: this.#deleteExpiredBlobs(expired),
    }
  }

  #deleteExpiredBlobs(expired: string): number {
    const rows = this.database.all<{ id: string; storage_path: string }>(
      `SELECT id, storage_path FROM stored_blobs
       WHERE reference_count = 0 AND delete_after IS NOT NULL AND delete_after <= ?`,
      expired,
    )
    for (const row of rows) {
      rmSync(row.storage_path, { force: true })
      this.database.run('DELETE FROM stored_blobs WHERE id = ?', row.id)
    }
    return rows.length
  }
}

const metricKey = (name: string, labels: Readonly<Record<string, string>>): string => {
  const rendered = Object.entries(labels)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}="${value.replaceAll('"', '\\"')}"`)
    .join(',')
  return rendered.length === 0 ? name : `${name}{${rendered}}`
}
