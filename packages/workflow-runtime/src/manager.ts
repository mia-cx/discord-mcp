import { randomBytes, randomUUID } from 'node:crypto'
import { createConnection } from 'node:net'
import type { Database } from '@discord-mcp/persistence'
import { Schema } from 'effect'
import type { CapabilityBroker } from './broker.js'
import type { SupervisorClient } from './supervisor-client.js'
import type { CompiledWorkflowManifest, WorkflowGrant } from './types.js'

export interface WorkflowInvocation {
  readonly workflowId: string
  readonly triggerType: string
  readonly triggerKey?: string
  readonly input: unknown
  readonly correlationId?: string
  readonly causationId?: string
  readonly causalDepth?: number
}

export interface WorkflowInvocationResult {
  readonly executionId: string
  readonly result: unknown
}

export interface EnabledWorkflow {
  readonly [key: string]: unknown
  readonly id: string
  readonly revision: number
  readonly manifest_json: string
  readonly grants_json: string
}

export class WorkflowExecutionError extends Schema.TaggedErrorClass<WorkflowExecutionError>()(
  'WorkflowExecutionError',
  {
    message: Schema.String,
    executionId: Schema.optionalKey(Schema.String),
    failureTag: Schema.optionalKey(Schema.String),
    retryable: Schema.Boolean,
    timedOut: Schema.Boolean,
  },
) {
  constructor(
    message: string,
    options: {
      readonly executionId?: string
      readonly failureTag?: string
      readonly retryable?: boolean
      readonly timedOut?: boolean
    } = {},
  ) {
    super({
      message,
      ...(options.executionId === undefined ? {} : { executionId: options.executionId }),
      ...(options.failureTag === undefined ? {} : { failureTag: options.failureTag }),
      retryable: options.retryable ?? false,
      timedOut: options.timedOut ?? false,
    })
  }
}

export interface WorkflowRuntimeObserver {
  readonly queueDepth?: (event: { readonly workflowId: string; readonly depth: number }) => void
  readonly executionFinished?: (event: {
    readonly workflowId: string
    readonly revision: number
    readonly outcome: 'succeeded' | 'failed' | 'timed_out'
    readonly durationMs: number
  }) => void
  readonly runnerKilled?: (event: {
    readonly workflowId: string
    readonly revision: number
    readonly reason: 'timeout' | 'crash'
  }) => void
}

export class WorkflowRuntimeManager {
  readonly #credentials = new Map<string, string>()
  readonly #active = new Map<string, number>()
  #timer: NodeJS.Timeout | undefined
  #scheduleTimer: NodeJS.Timeout | undefined
  #closed = false
  #lastScheduleMinute = ''

  constructor(
    readonly database: Database,
    readonly supervisor: SupervisorClient,
    readonly broker: CapabilityBroker,
    readonly runnerSocketRoot = '/run/discord-mcp/runners',
    readonly onEnabled?: (workflow: EnabledWorkflow) => void | Promise<void>,
    readonly onDisabled?: (workflowId: string, revision: number) => void | Promise<void>,
    readonly observer: WorkflowRuntimeObserver = {},
  ) {}

  async start(): Promise<void> {
    const recoveredAt = new Date().toISOString()
    this.database.run(
      `UPDATE workflow_executions SET status = 'failed', finished_at = ?, error_json = ?
       WHERE status = 'running'`,
      recoveredAt,
      JSON.stringify({
        code: 'CONTROL_PLANE_RESTARTED',
        message:
          'control plane restarted while the workflow was running; inspect prior actions before retrying',
        retryable: true,
      }),
    )
    await this.syncEnabled()
    this.#timer = setInterval(() => void this.#poll(), 250)
    this.#scheduleTimer = setInterval(() => void this.#schedules(), 15_000)
    await this.#poll()
    await this.#schedules()
  }

  async close(): Promise<void> {
    this.#closed = true
    if (this.#timer) clearInterval(this.#timer)
    if (this.#scheduleTimer) clearInterval(this.#scheduleTimer)
    await Promise.allSettled(
      [...this.#credentials.keys()].map(async (key) => {
        const [workflowId, revision] = key.split(':')
        if (workflowId && revision) {
          await this.supervisor.request({
            action: 'stop',
            workflowId,
            revision: Number(revision),
          })
        }
      }),
    )
  }

  async syncEnabled(): Promise<void> {
    const enabled = this.database.all<EnabledWorkflow>(
      `SELECT w.id, w.enabled_revision AS revision, r.manifest_json, g.grants_json
       FROM workflows w
       JOIN workflow_revisions r ON r.workflow_id = w.id AND r.revision = w.enabled_revision
       JOIN workflow_grants g ON g.workflow_id = w.id AND g.revision = w.enabled_revision
       WHERE w.enabled_revision IS NOT NULL AND w.deleted_at IS NULL`,
    )
    const wanted = new Set(enabled.map(({ id, revision }) => `${id}:${revision}`))
    const staleRegistrations = this.database.all<{ workflow_id: string; revision: number }>(
      `SELECT DISTINCT registrations.workflow_id, registrations.revision
       FROM (
         SELECT workflow_id, revision FROM workflow_routes
         UNION SELECT workflow_id, revision FROM workflow_commands
       ) registrations
       LEFT JOIN workflows w ON w.id = registrations.workflow_id
       WHERE w.enabled_revision IS NULL OR w.enabled_revision != registrations.revision
       OR w.deleted_at IS NOT NULL`,
    )
    for (const registration of staleRegistrations) {
      await this.onDisabled?.(registration.workflow_id, registration.revision)
    }
    for (const row of enabled) {
      await this.#ensureRunner(row.id, row.revision)
      await this.onEnabled?.(row)
    }
    for (const key of this.#credentials.keys()) {
      if (wanted.has(key)) continue
      const [workflowId, revision] = key.split(':')
      if (workflowId && revision) {
        if ((this.#active.get(workflowId) ?? 0) > 0) continue
        await this.onDisabled?.(workflowId, Number(revision))
        await this.supervisor
          .request({ action: 'stop', workflowId, revision: Number(revision) })
          .catch(() => undefined)
      }
      this.#credentials.delete(key)
    }
  }

  async invoke(input: WorkflowInvocation): Promise<WorkflowInvocationResult> {
    const queued = this.enqueue(input)
    return this.#run(queued.executionId)
  }

  enqueue(input: WorkflowInvocation): {
    readonly executionId: string
    readonly status: 'queued'
  } {
    const workflow = this.database.get<{ enabled_revision: number | null }>(
      'SELECT enabled_revision FROM workflows WHERE id = ? AND deleted_at IS NULL',
      input.workflowId,
    )
    if (!workflow?.enabled_revision) throw new WorkflowExecutionError('workflow is not enabled')
    const pending =
      this.database.get<{ count: number }>(
        `SELECT COUNT(*) AS count FROM workflow_executions
         WHERE workflow_id = ? AND status IN ('queued', 'running')`,
        input.workflowId,
      )?.count ?? 0
    if (pending >= 1_000) {
      throw new WorkflowExecutionError('workflow execution queue is full', { retryable: true })
    }
    if ((input.causalDepth ?? 0) > 5) {
      throw new WorkflowExecutionError('maximum causal workflow depth exceeded')
    }
    const executionId = randomUUID()
    const correlationId = input.correlationId ?? randomUUID()
    const now = new Date().toISOString()
    this.database.transaction(() => {
      this.database.run(
        `INSERT INTO workflow_executions
         (id, workflow_id, revision, trigger_type, status, correlation_id, causation_id,
          causal_depth, started_at)
         VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?)`,
        executionId,
        input.workflowId,
        workflow.enabled_revision,
        input.triggerType,
        correlationId,
        input.causationId ?? null,
        input.causalDepth ?? 0,
        now,
      )
      this.database.run(
        `INSERT INTO workflow_events
         (workflow_id, event_type, payload_json, correlation_id, causation_id, received_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        input.workflowId,
        input.triggerType,
        JSON.stringify({ key: input.triggerKey, input: input.input }),
        correlationId,
        input.causationId ?? null,
        now,
      )
    })
    this.observer.queueDepth?.({ workflowId: input.workflowId, depth: pending + 1 })
    return { executionId, status: 'queued' }
  }

  async #poll(): Promise<void> {
    if (this.#closed) return
    await this.syncEnabled().catch(() => undefined)
    const rows = this.database.all<{ id: string; workflow_id: string }>(
      `SELECT id, workflow_id FROM workflow_executions WHERE status = 'queued'
       ORDER BY started_at LIMIT 100`,
    )
    for (const row of rows) {
      if ((this.#active.get(row.workflow_id) ?? 0) >= this.#concurrency(row.workflow_id)) continue
      void this.#run(row.id).catch(() => undefined)
    }
  }

  async #run(executionId: string): Promise<WorkflowInvocationResult> {
    const row = this.database.get<{
      workflow_id: string
      revision: number
      trigger_type: string
      correlation_id: string
      causation_id: string | null
      causal_depth: number
      status: string
    }>('SELECT * FROM workflow_executions WHERE id = ?', executionId)
    if (!row) {
      throw new WorkflowExecutionError(`workflow execution ${executionId} does not exist`, {
        executionId,
      })
    }
    const concurrency = this.#concurrency(row.workflow_id, row.revision)
    if ((this.#active.get(row.workflow_id) ?? 0) >= concurrency) {
      await new Promise((resolve) => setTimeout(resolve, 50))
      return this.#run(executionId)
    }
    if (row.status !== 'queued') {
      throw new WorkflowExecutionError(`workflow execution is ${row.status}`, { executionId })
    }
    const started = performance.now()
    this.#active.set(row.workflow_id, (this.#active.get(row.workflow_id) ?? 0) + 1)
    this.database.run(
      "UPDATE workflow_executions SET status = 'running' WHERE id = ? AND status = 'queued'",
      executionId,
    )
    try {
      await this.#ensureRunner(row.workflow_id, row.revision)
      const revision = this.database.get<{
        manifest_json: string
        grants_json: string
      }>(
        `SELECT r.manifest_json, g.grants_json FROM workflow_revisions r
         JOIN workflow_grants g ON g.workflow_id = r.workflow_id AND g.revision = r.revision
         WHERE r.workflow_id = ? AND r.revision = ?`,
        row.workflow_id,
        row.revision,
      )
      if (!revision?.manifest_json) throw new Error('workflow manifest is unavailable')
      const manifest = JSON.parse(revision.manifest_json) as CompiledWorkflowManifest
      const event = this.database.get<{ payload_json: string }>(
        `SELECT payload_json FROM workflow_events WHERE workflow_id = ? AND correlation_id = ?
         ORDER BY sequence DESC LIMIT 1`,
        row.workflow_id,
        row.correlation_id,
      )
      const payload = event ? (JSON.parse(event.payload_json) as Record<string, unknown>) : {}
      const triggerIndex = findTrigger(manifest, row.trigger_type, payload.key)
      const grant = JSON.parse(revision.grants_json) as WorkflowGrant
      const socketPath = `${this.runnerSocketRoot}/${row.workflow_id}/${row.revision}/runner.sock`
      const invocation = {
        executionId,
        triggerIndex,
        input: payload.input,
        correlationId: row.correlation_id,
        ...(row.causation_id === null ? {} : { causationId: row.causation_id }),
        causalDepth: row.causal_depth,
      }
      let result: unknown
      try {
        result = await invokeRunner(socketPath, invocation, grant.runtime.timeoutSeconds * 1_000)
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause)
        if (!/ENOENT|ECONNREFUSED|socket hang up|closed without a response/i.test(message)) {
          throw cause
        }
        await this.supervisor
          .request({
            action: 'destroy',
            workflowId: row.workflow_id,
            revision: row.revision,
          })
          .catch(() => undefined)
        this.observer.runnerKilled?.({
          workflowId: row.workflow_id,
          revision: row.revision,
          reason: 'crash',
        })
        this.#credentials.delete(`${row.workflow_id}:${row.revision}`)
        await this.#ensureRunner(row.workflow_id, row.revision)
        throw new WorkflowExecutionError(
          'workflow runner crashed; the execution was not retried because completion is ambiguous',
          { executionId, retryable: false },
        )
      }
      this.database.run(
        "UPDATE workflow_executions SET status = 'succeeded', finished_at = ? WHERE id = ?",
        new Date().toISOString(),
        executionId,
      )
      this.observer.executionFinished?.({
        workflowId: row.workflow_id,
        revision: row.revision,
        outcome: 'succeeded',
        durationMs: performance.now() - started,
      })
      return { executionId, result }
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause)
      if (/timed out/i.test(error)) {
        await this.supervisor
          .request({
            action: 'destroy',
            workflowId: row.workflow_id,
            revision: row.revision,
          })
          .catch(() => undefined)
        this.observer.runnerKilled?.({
          workflowId: row.workflow_id,
          revision: row.revision,
          reason: 'timeout',
        })
        this.#credentials.delete(`${row.workflow_id}:${row.revision}`)
      }
      const timedOut =
        (cause instanceof WorkflowExecutionError && cause.timedOut) ||
        /tim(?:e|ed)[ -]?out/i.test(error)
      this.database.run(
        `UPDATE workflow_executions SET status = ?, finished_at = ?, error_json = ? WHERE id = ?`,
        timedOut ? 'timed_out' : 'failed',
        new Date().toISOString(),
        JSON.stringify({
          code: timedOut
            ? 'WORKFLOW_EXECUTION_TIMEOUT'
            : cause instanceof WorkflowExecutionError && cause.failureTag !== undefined
              ? cause.failureTag
              : 'WORKFLOW_EXECUTION_FAILED',
          message: error,
          retryable: cause instanceof WorkflowExecutionError ? cause.retryable : true,
        }),
        executionId,
      )
      this.observer.executionFinished?.({
        workflowId: row.workflow_id,
        revision: row.revision,
        outcome: timedOut ? 'timed_out' : 'failed',
        durationMs: performance.now() - started,
      })
      if (cause instanceof WorkflowExecutionError && cause.executionId !== undefined) {
        throw cause
      }
      throw new WorkflowExecutionError(error, {
        executionId,
        ...(cause instanceof WorkflowExecutionError && cause.failureTag !== undefined
          ? { failureTag: cause.failureTag }
          : {}),
        retryable: cause instanceof WorkflowExecutionError ? cause.retryable : true,
        timedOut,
      })
    } finally {
      const remaining = (this.#active.get(row.workflow_id) ?? 1) - 1
      if (remaining <= 0) this.#active.delete(row.workflow_id)
      else this.#active.set(row.workflow_id, remaining)
      const depth =
        this.database.get<{ count: number }>(
          `SELECT COUNT(*) AS count FROM workflow_executions
           WHERE workflow_id = ? AND status IN ('queued', 'running')`,
          row.workflow_id,
        )?.count ?? 0
      this.observer.queueDepth?.({ workflowId: row.workflow_id, depth })
    }
  }

  async #ensureRunner(workflowId: string, revision: number): Promise<void> {
    const key = `${workflowId}:${revision}`
    const artifact = this.database.get<{ artifact_digest: string | null }>(
      `SELECT artifact_digest FROM workflow_revisions
       WHERE workflow_id = ? AND revision = ? AND status = 'published'`,
      workflowId,
      revision,
    )
    if (!artifact?.artifact_digest) {
      throw new WorkflowExecutionError('published workflow artifact is unavailable')
    }
    let credential = this.#credentials.get(key)
    if (!credential) {
      credential = randomBytes(32).toString('base64url')
      this.#credentials.set(key, credential)
      this.broker.register(workflowId, revision, credential)
    }
    try {
      await this.supervisor.request({ action: 'inspect', workflowId, revision })
    } catch {
      await this.supervisor
        .request({ action: 'destroy', workflowId, revision })
        .catch(() => undefined)
      await this.supervisor.request({
        action: 'start',
        workflowId,
        revision,
        capabilityCredential: credential,
        artifactDigest: artifact.artifact_digest,
      })
    }
  }

  #concurrency(workflowId: string, revision?: number): number {
    const row = this.database.get<{ grants_json: string }>(
      revision === undefined
        ? `SELECT g.grants_json FROM workflow_grants g JOIN workflows w
           ON w.id = g.workflow_id AND w.enabled_revision = g.revision WHERE w.id = ?`
        : `SELECT grants_json FROM workflow_grants WHERE workflow_id = ? AND revision = ?`,
      workflowId,
      ...(revision === undefined ? [] : [revision]),
    )
    if (!row) return 1
    const grant = JSON.parse(row.grants_json) as WorkflowGrant
    return Math.max(1, Math.min(grant.runtime.concurrency, 8))
  }

  async #schedules(now = new Date()): Promise<void> {
    if (this.#closed) return
    const minute = now.toISOString().slice(0, 16)
    if (minute === this.#lastScheduleMinute) return
    this.#lastScheduleMinute = minute
    const rows = this.database.all<EnabledWorkflow>(
      `SELECT w.id, w.enabled_revision AS revision, r.manifest_json, g.grants_json
       FROM workflows w JOIN workflow_revisions r
       ON r.workflow_id = w.id AND r.revision = w.enabled_revision
       JOIN workflow_grants g ON g.workflow_id = w.id AND g.revision = w.enabled_revision
       WHERE w.enabled_revision IS NOT NULL AND w.deleted_at IS NULL`,
    )
    for (const row of rows) {
      const manifest = JSON.parse(row.manifest_json) as CompiledWorkflowManifest
      for (const trigger of manifest.triggers) {
        if (trigger.type === 'schedule' && typeof trigger.schedule === 'string') {
          if (cronMatches(trigger.schedule, now)) {
            void this.invoke({
              workflowId: row.id,
              triggerType: 'schedule',
              triggerKey: trigger.schedule,
              input: { scheduledAt: now.toISOString() },
            }).catch(() => undefined)
          }
        }
      }
    }
  }
}

const findTrigger = (manifest: CompiledWorkflowManifest, type: string, key: unknown): number => {
  const match = manifest.triggers.find((trigger) => {
    if (trigger.type !== type) return false
    if (type === 'manual') return trigger.key === key
    if (type === 'schedule') return trigger.schedule === key
    if (type === 'http') return trigger.path === key
    if (type === 'interactionCommand') return trigger.name === key
    if (type === 'interactionComponent' || type === 'interactionModal') {
      return trigger.action === key
    }
    if (type === 'interactionAutocomplete') return trigger.command === key
    if (type === 'gateway') {
      return Array.isArray(trigger.eventTypes) && trigger.eventTypes.includes(key)
    }
    return true
  })
  if (!match || typeof match.index !== 'number') throw new Error(`no ${type} trigger is registered`)
  return match.index
}

export const invokeRunner = (
  socketPath: string,
  invocation: Readonly<Record<string, unknown>>,
  timeoutMs: number,
): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const socket = createConnection(socketPath)
    let buffer = ''
    let settled = false
    const finish = (result: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      result()
    }
    const timer = setTimeout(() => {
      finish(() =>
        reject(
          new WorkflowExecutionError(`workflow handler timed out after ${timeoutMs}ms`, {
            retryable: true,
            timedOut: true,
          }),
        ),
      )
    }, timeoutMs)
    socket.setEncoding('utf8')
    socket.once('connect', () => socket.write(`${JSON.stringify(invocation)}\n`))
    socket.on('data', (chunk) => {
      buffer += chunk
      if (Buffer.byteLength(buffer) > 2 * 1024 * 1024) {
        finish(() => reject(new WorkflowExecutionError('workflow runner response exceeds 2 MiB')))
        return
      }
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      let response: {
        readonly ok: boolean
        readonly result?: unknown
        readonly error?:
          | string
          | {
              readonly tag: string
              readonly message: string
              readonly retryable?: boolean
            }
      }
      try {
        response = JSON.parse(buffer.slice(0, newline)) as typeof response
      } catch {
        finish(() => reject(new WorkflowExecutionError('workflow runner returned invalid JSON')))
        return
      }
      if (response.ok) finish(() => resolve(response.result))
      else {
        const remote =
          typeof response.error === 'object' && response.error !== null
            ? response.error
            : {
                tag: 'WorkflowHandlerError',
                message: response.error ?? 'workflow runner failed',
                retryable: true,
              }
        finish(() =>
          reject(
            new WorkflowExecutionError(remote.message, {
              failureTag: remote.tag,
              retryable: remote.retryable ?? false,
            }),
          ),
        )
      }
    })
    socket.once('error', (error) => finish(() => reject(error)))
    socket.once('end', () => {
      if (!settled) {
        finish(() =>
          reject(
            new WorkflowExecutionError('workflow runner closed without a response', {
              retryable: true,
            }),
          ),
        )
      }
    })
  })

const cronMatches = (expression: string, date: Date): boolean => {
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5) throw new Error(`invalid cron expression: ${expression}`)
  const values = [
    date.getUTCMinutes(),
    date.getUTCHours(),
    date.getUTCDate(),
    date.getUTCMonth() + 1,
    date.getUTCDay(),
  ]
  return fields.every((field, index) => cronField(field ?? '', values[index] ?? -1))
}

const cronField = (field: string, value: number): boolean =>
  field === '*' ||
  field.split(',').some((part) => {
    if (part.startsWith('*/')) return value % Number(part.slice(2)) === 0
    const [start, end] = part.split('-').map(Number)
    return end === undefined ? value === start : value >= (start ?? -1) && value <= end
  })
