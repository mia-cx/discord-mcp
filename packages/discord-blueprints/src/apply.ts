import { randomUUID } from 'node:crypto'
import { Schema } from 'effect'
import { BlueprintError } from './errors.js'
import type { BlueprintAction, BlueprintPlan } from './types.js'

export type JournalActionStatus = 'pending' | 'running' | 'completed' | 'failed'

export interface JournalAction {
  readonly index: number
  readonly action: BlueprintAction
  readonly status: JournalActionStatus
  readonly result?: unknown
  readonly error?: string
}

export interface BlueprintExecution {
  readonly id: string
  readonly blueprintDigest: string
  readonly snapshotDigest: string
  readonly actionsDigest: string
  readonly status: 'running' | 'completed' | 'partial'
  readonly actions: ReadonlyArray<JournalAction>
}

export interface BlueprintJournal {
  create(plan: BlueprintPlan): BlueprintExecution
  get(executionId: string): BlueprintExecution | undefined
  update(execution: BlueprintExecution): void
}

export interface BlueprintActionExecutor {
  execute(action: BlueprintAction, execution: BlueprintExecution): Promise<unknown>
}

const JsonValueSchema: Schema.Codec<unknown, unknown> = Schema.suspend(() =>
  Schema.Union([
    Schema.Null,
    Schema.Boolean,
    Schema.Finite,
    Schema.String,
    Schema.Array(JsonValueSchema),
    Schema.Record(Schema.String, JsonValueSchema),
  ]),
)

const BlueprintExecutionSchema = Schema.Struct({
  id: Schema.String,
  blueprintDigest: Schema.String,
  snapshotDigest: Schema.String,
  actionsDigest: Schema.String,
  status: Schema.Literals(['running', 'completed', 'partial']),
  actions: Schema.Array(
    Schema.Struct({
      index: Schema.Number,
      action: JsonValueSchema,
      status: Schema.Literals(['pending', 'running', 'completed', 'failed']),
      result: Schema.optionalKey(JsonValueSchema),
      error: Schema.optionalKey(Schema.String),
    }),
  ),
})

export class BlueprintApplyError extends Schema.TaggedErrorClass<BlueprintApplyError>()(
  'BlueprintApplyError',
  {
    message: Schema.String,
    execution: BlueprintExecutionSchema,
  },
) {
  constructor(
    message: string,
    readonly execution: BlueprintExecution,
  ) {
    super({ message, execution })
  }
}

const actionsDigest = (plan: BlueprintPlan): string => {
  const value = JSON.stringify(plan.actions)
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

export class MemoryBlueprintJournal implements BlueprintJournal {
  readonly #executions = new Map<string, BlueprintExecution>()

  create(plan: BlueprintPlan): BlueprintExecution {
    const execution: BlueprintExecution = {
      id: randomUUID(),
      blueprintDigest: plan.blueprintDigest,
      snapshotDigest: plan.snapshotDigest,
      actionsDigest: actionsDigest(plan),
      status: 'running',
      actions: plan.actions.map((action, index) => ({ index, action, status: 'pending' })),
    }
    this.update(execution)
    return execution
  }

  get(executionId: string): BlueprintExecution | undefined {
    return this.#executions.get(executionId)
  }

  update(execution: BlueprintExecution): void {
    this.#executions.set(execution.id, structuredClone(execution))
  }
}

export class BlueprintApplier {
  constructor(
    readonly journal: BlueprintJournal,
    readonly executor: BlueprintActionExecutor,
  ) {}

  async apply(plan: BlueprintPlan, resumeExecutionId?: string): Promise<BlueprintExecution> {
    let execution =
      resumeExecutionId === undefined
        ? this.journal.create(plan)
        : this.journal.get(resumeExecutionId)
    if (!execution)
      throw new BlueprintError(`Blueprint execution ${resumeExecutionId} does not exist`)
    if (
      execution.blueprintDigest !== plan.blueprintDigest ||
      execution.snapshotDigest !== plan.snapshotDigest ||
      execution.actionsDigest !== actionsDigest(plan)
    ) {
      throw new BlueprintError(
        'Blueprint plan changed; a partial execution cannot resume against new state',
      )
    }
    for (const entry of execution.actions) {
      if (entry.status === 'completed') continue
      execution = replaceAction(execution, entry.index, { ...entry, status: 'running' })
      this.journal.update(execution)
      try {
        const result = await this.executor.execute(entry.action, execution)
        execution = replaceAction(execution, entry.index, {
          ...entry,
          status: 'completed',
          result,
        })
        this.journal.update(execution)
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause)
        execution = {
          ...replaceAction(execution, entry.index, {
            ...entry,
            status: 'failed',
            error: message,
          }),
          status: 'partial',
        }
        this.journal.update(execution)
        throw new BlueprintApplyError(
          `Blueprint apply stopped at action ${entry.index}: ${message}`,
          execution,
        )
      }
    }
    execution = { ...execution, status: 'completed' }
    this.journal.update(execution)
    return execution
  }
}

const replaceAction = (
  execution: BlueprintExecution,
  index: number,
  replacement: JournalAction,
): BlueprintExecution => ({
  ...execution,
  status: 'running',
  actions: execution.actions.map((entry) => (entry.index === index ? replacement : entry)),
})
