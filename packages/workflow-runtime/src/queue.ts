import { randomUUID } from 'node:crypto'
import { WORKFLOW_LIMITS } from '@discord-mcp/workflow-sdk'
import { Context, Effect, Layer, Ref } from 'effect'

/**
 * Per-workflow dispatch queues.
 *
 * One queue per workflow rather than one for the whole server: a workflow that falls behind should
 * degrade itself and nothing else. A shared queue would let one slow handler stall every other
 * workflow's events, which is the failure that makes automation untrustworthy.
 */

export interface QueuedEvent {
  readonly id: string
  readonly workflowId: string
  readonly revision: number
  readonly triggerKind: string
  readonly triggerIndex: number
  readonly payload: unknown
  readonly correlationId: string
  readonly causationId: string | undefined
  readonly causalDepth: number
  readonly queuedAt: number
}

export interface EnqueueRequest {
  readonly workflowId: string
  readonly revision: number
  readonly triggerKind: string
  readonly triggerIndex: number
  readonly payload: unknown
  readonly correlationId?: string
  readonly causationId?: string
  readonly causalDepth?: number
  readonly now: number
}

export type EnqueueOutcome =
  | { readonly accepted: true; readonly event: QueuedEvent }
  | { readonly accepted: false; readonly reason: string; readonly dropped: number }

interface WorkflowQueue {
  readonly pending: ReadonlyArray<QueuedEvent>
  readonly inFlight: number
  /** How many events were refused for overflow, so the loss is reportable rather than silent. */
  readonly dropped: number
}

const empty: WorkflowQueue = { pending: [], inFlight: 0, dropped: 0 }

export class WorkflowQueues extends Context.Service<
  WorkflowQueues,
  {
    readonly enqueue: (request: EnqueueRequest) => Effect.Effect<EnqueueOutcome>
    /** Take the next event a workflow may run, respecting its concurrency limit. */
    readonly take: (input: {
      readonly workflowId: string
      readonly concurrency: number
    }) => Effect.Effect<QueuedEvent | undefined>
    readonly finish: (workflowId: string) => Effect.Effect<void>
    readonly depth: (workflowId: string) => Effect.Effect<{
      readonly pending: number
      readonly inFlight: number
      readonly dropped: number
    }>
    /** Clear a workflow's queue. Disabling should not leave work that resumes on re-enable. */
    readonly drain: (workflowId: string) => Effect.Effect<number>
  }
>()('workflow-runtime/WorkflowQueues') {
  static readonly layer = Layer.effect(WorkflowQueues)(
    Effect.gen(function* () {
      const state = yield* Ref.make<ReadonlyMap<string, WorkflowQueue>>(new Map())

      const update = (workflowId: string, change: (queue: WorkflowQueue) => WorkflowQueue) =>
        Ref.update(state, (queues) => {
          const next = new Map(queues)
          next.set(workflowId, change(queues.get(workflowId) ?? empty))
          return next
        })

      return {
        enqueue: (request) =>
          Effect.gen(function* () {
            const queues = yield* Ref.get(state)
            const queue = queues.get(request.workflowId) ?? empty

            if (queue.pending.length >= WORKFLOW_LIMITS.queuedEventsPerWorkflow) {
              // Refuse the newest rather than evict the oldest: dropping the head would silently
              // reorder a causal chain, and a workflow that cannot keep up should be told so at
              // the point of arrival.
              yield* update(request.workflowId, (q) => ({ ...q, dropped: q.dropped + 1 }))
              return {
                accepted: false as const,
                reason: `This workflow has ${queue.pending.length} events queued, its limit. It is not keeping up; raise runtime.concurrency, make the handler faster, or narrow the events it subscribes to.`,
                dropped: queue.dropped + 1,
              }
            }

            const event: QueuedEvent = {
              id: randomUUID(),
              workflowId: request.workflowId,
              revision: request.revision,
              triggerKind: request.triggerKind,
              triggerIndex: request.triggerIndex,
              payload: request.payload,
              // A new chain when nothing caused this, so every execution is traceable to its root.
              correlationId: request.correlationId ?? randomUUID(),
              causationId: request.causationId,
              causalDepth: request.causalDepth ?? 0,
              queuedAt: request.now,
            }

            yield* update(request.workflowId, (q) => ({ ...q, pending: [...q.pending, event] }))
            return { accepted: true as const, event }
          }),

        take: (input) =>
          Effect.gen(function* () {
            const queues = yield* Ref.get(state)
            const queue = queues.get(input.workflowId) ?? empty

            // Concurrency is per workflow and enforced here rather than at the container, because
            // the cheapest place to not start work is before starting it.
            if (queue.inFlight >= input.concurrency) return undefined

            const [next, ...rest] = queue.pending
            if (next === undefined) return undefined

            yield* update(input.workflowId, (q) => ({
              ...q,
              pending: rest,
              inFlight: q.inFlight + 1,
            }))
            return next
          }),

        finish: (workflowId) =>
          update(workflowId, (q) => ({ ...q, inFlight: Math.max(0, q.inFlight - 1) })),

        depth: (workflowId) =>
          Effect.map(Ref.get(state), (queues) => {
            const queue = queues.get(workflowId) ?? empty
            return {
              pending: queue.pending.length,
              inFlight: queue.inFlight,
              dropped: queue.dropped,
            }
          }),

        drain: (workflowId) =>
          Effect.gen(function* () {
            const queues = yield* Ref.get(state)
            const discarded = (queues.get(workflowId) ?? empty).pending.length
            yield* update(workflowId, (q) => ({ ...q, pending: [] }))
            return discarded
          }),
      }
    }),
  )
}
