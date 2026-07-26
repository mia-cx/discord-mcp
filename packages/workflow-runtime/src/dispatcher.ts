import type { CompiledManifest, WorkflowGrant } from '@discord-mcp/workflow-sdk'
import { Context, Effect, Layer, Ref } from 'effect'
import { CapabilityBroker } from './broker.ts'
import type { CapabilityServer } from './capability-server.ts'
import { CapabilitySockets } from './capability-socket.ts'
import { checkGatewayEvent } from './grants.ts'
import { WorkflowQueues } from './queue.ts'
import { WorkflowRepository } from './repository.ts'
import { SandboxSupervisor } from './sandbox.ts'
import { type CronSchedule, checkScheduleFloor, matches, parseCron } from './schedule.ts'

/**
 * The dispatcher: what turns an enabled workflow into a running one.
 *
 * Everything else in this package decides *whether* something may happen. This is the part that
 * makes it happen — it watches the Gateway, ticks schedules, and pumps each workflow's queue
 * through the sandbox.
 *
 * It holds the set of enabled workflows in memory and rebuilds it from the database on startup, so
 * a control-plane restart does not silently stop every automation an operator turned on.
 */

export interface ActiveWorkflow {
  readonly workflowId: string
  readonly slug: string
  readonly revision: number
  readonly manifest: CompiledManifest
  readonly grant: WorkflowGrant
  readonly schedules: ReadonlyArray<{
    readonly parsed: CronSchedule
    readonly triggerIndex: number
  }>
}

export interface GatewayEventFacts {
  readonly type: string
  readonly guildId?: string
  readonly channelId?: string
  readonly botAuthored: boolean
  readonly correlationId: string
  readonly causationId?: string
  readonly payload: unknown
}

export class WorkflowDispatcher extends Context.Service<
  WorkflowDispatcher,
  {
    /**
     * Rebuild the active set from the database.
     *
     * Called at startup and after any lifecycle change. Enabled means enabled: a workflow an
     * operator turned on before a restart is running after it.
     */
    readonly restore: () => Effect.Effect<ReadonlyArray<ActiveWorkflow>>
    /** Offer a Gateway event to every workflow whose grant and manifest accept it. */
    readonly onGatewayEvent: (
      event: GatewayEventFacts,
    ) => Effect.Effect<ReadonlyArray<{ readonly slug: string; readonly accepted: boolean }>>
    /** Enqueue everything due at this instant. Called once a minute. */
    readonly tick: (at: Date) => Effect.Effect<number>
    /** Run whatever each workflow's queue is ready to run, honouring its concurrency. */
    readonly pump: () => Effect.Effect<number>
    readonly active: () => Effect.Effect<ReadonlyArray<ActiveWorkflow>>
  }
>()('workflow-runtime/WorkflowDispatcher') {
  static readonly layer = Layer.effect(WorkflowDispatcher)(
    Effect.gen(function* () {
      const repository = yield* WorkflowRepository
      const queues = yield* WorkflowQueues
      const broker = yield* CapabilityBroker
      const sockets = yield* CapabilitySockets
      const supervisor = yield* SandboxSupervisor
      // Captured so the pump can run outside any caller's context: it is driven by a background
      // fiber, not by a request.
      const capability = yield* Effect.context<CapabilityServer>()

      const state = yield* Ref.make<ReadonlyArray<ActiveWorkflow>>([])
      // Fired schedules are recorded by minute so a tick that runs twice — a slow pump, a clock
      // adjustment — does not run the same scheduled execution twice.
      const firedMinutes = yield* Ref.make<ReadonlySet<string>>(new Set())

      const restore = () =>
        Effect.gen(function* () {
          const workflows = yield* Effect.orElseSucceed(repository.list(), () => [])
          const restored: ActiveWorkflow[] = []

          for (const workflow of workflows) {
            if (workflow.enabledRevision === null) continue

            const revision = yield* Effect.orElseSucceed(
              repository.getRevision(workflow.id, workflow.enabledRevision),
              () => undefined,
            )
            const grant = yield* Effect.orElseSucceed(
              repository.getGrant(workflow.id, workflow.enabledRevision),
              () => undefined,
            )

            // Both are required. A revision with no manifest has nothing to dispatch to, and one
            // with no grant was never approved — neither should quietly come back after a restart.
            if (revision?.manifest == null || grant === undefined) continue

            const active: ActiveWorkflow = {
              workflowId: workflow.id,
              slug: workflow.slug,
              revision: workflow.enabledRevision,
              manifest: revision.manifest,
              grant,
              schedules: compileSchedules(revision.manifest),
            }
            restored.push(active)

            // The broker's enabled set is in-process, so it has to be told again after a restart or
            // every capability call would be refused.
            yield* broker.setEnabled(workflow.id, workflow.enabledRevision, true)
          }

          yield* Ref.set(state, restored)
          return restored
        })

      const runOne = (input: {
        readonly active: ActiveWorkflow
        readonly triggerIndex: number
        readonly triggerKind: string
        readonly payload: unknown
        readonly correlationId: string
        readonly causationId: string | undefined
        readonly causalDepth: number
      }) =>
        Effect.gen(function* () {
          const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis)

          const executionId = yield* Effect.orElseSucceed(
            repository.recordExecution({
              workflowId: input.active.workflowId,
              revision: input.active.revision,
              triggerKind: input.triggerKind,
              correlationId: input.correlationId,
              causalDepth: input.causalDepth,
              ...(input.causationId === undefined ? {} : { causationId: input.causationId }),
            }),
            () => `${input.active.workflowId}:${now}`,
          )

          const credential = yield* broker.issue({
            workflowId: input.active.workflowId,
            revision: input.active.revision,
            executionId,
            grant: input.active.grant,
            causalDepth: input.causalDepth,
            now,
          })

          const socket = yield* sockets
            .open(credential, { index: input.triggerIndex, input: input.payload })
            .pipe(Effect.provide(capability))

          const outcome = yield* Effect.result(
            Effect.ensuring(
              supervisor.run({
                workflowId: input.active.workflowId,
                revision: input.active.revision,
                executionId,
                capabilityCredential: credential.token,
                payload: { index: input.triggerIndex, input: input.payload },
                timeoutSeconds: input.active.grant.runtime.timeoutSeconds,
              }),
              Effect.andThen(socket.close(), broker.revoke(credential.token)),
            ),
          )

          const status =
            outcome._tag === 'Failure'
              ? 'failed'
              : outcome.success.timedOut
                ? 'timeout'
                : outcome.success.exitCode === 0
                  ? 'succeeded'
                  : 'failed'

          yield* Effect.orElseSucceed(
            repository.finishExecution({
              executionId,
              status,
              logs: `${socket.logs()}${outcome._tag === 'Success' ? outcome.success.logs : ''}`,
              ...(outcome._tag === 'Failure' ? { error: outcome.failure.message } : {}),
            }),
            () => undefined,
          )

          return status
        })

      return {
        restore,
        active: () => Ref.get(state),

        onGatewayEvent: (event) =>
          Effect.gen(function* () {
            const workflows = yield* Ref.get(state)
            const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
            const results: Array<{ slug: string; accepted: boolean }> = []

            for (const active of workflows) {
              // The manifest says which events the code subscribes to; the grant says which it is
              // allowed to see. Both have to agree, and the grant is the one that decides.
              const subscribed = (active.manifest.gatewayEventTypes ?? []).includes(event.type)
              if (!subscribed) continue

              const decision = checkGatewayEvent(active.grant, {
                type: event.type,
                botAuthored: event.botAuthored,
                ...(event.guildId === undefined ? {} : { guildId: event.guildId }),
              })
              if (!decision.allowed) {
                results.push({ slug: active.slug, accepted: false })
                continue
              }

              const triggerIndex = (active.manifest.triggers ?? []).findIndex(
                (trigger) =>
                  trigger.kind === 'gateway' && trigger.identifier.split(',').includes(event.type),
              )
              if (triggerIndex === -1) {
                results.push({ slug: active.slug, accepted: false })
                continue
              }

              const queued = yield* queues.enqueue({
                workflowId: active.workflowId,
                revision: active.revision,
                triggerKind: 'gateway',
                triggerIndex,
                payload: event.payload,
                correlationId: event.correlationId,
                causalDepth: 0,
                now,
                ...(event.causationId === undefined ? {} : { causationId: event.causationId }),
              })

              results.push({ slug: active.slug, accepted: queued.accepted })
            }

            return results
          }),

        tick: (at) =>
          Effect.gen(function* () {
            const workflows = yield* Ref.get(state)
            const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
            const minute = `${at.toISOString().slice(0, 16)}`
            let enqueued = 0

            for (const active of workflows) {
              for (const schedule of active.schedules) {
                if (!matches(schedule.parsed, at)) continue

                // One execution per workflow, per trigger, per minute — whatever the tick does.
                const key = `${active.workflowId}:${schedule.triggerIndex}:${minute}`
                const seen = yield* Ref.get(firedMinutes)
                if (seen.has(key)) continue
                yield* Ref.update(firedMinutes, (s) => new Set(s).add(key))

                const queued = yield* queues.enqueue({
                  workflowId: active.workflowId,
                  revision: active.revision,
                  triggerKind: 'schedule',
                  triggerIndex: schedule.triggerIndex,
                  payload: { firedAt: at.toISOString() },
                  causalDepth: 0,
                  now,
                })
                if (queued.accepted) enqueued += 1
              }
            }

            // Bounded: without this the fired-minute set grows for the life of the process.
            yield* Ref.update(firedMinutes, (seen) =>
              seen.size > 10_000 ? new Set([...seen].slice(-1000)) : seen,
            )

            return enqueued
          }),

        pump: () =>
          Effect.gen(function* () {
            const workflows = yield* Ref.get(state)
            let started = 0

            for (const active of workflows) {
              const event = yield* queues.take({
                workflowId: active.workflowId,
                concurrency: active.grant.runtime.concurrency,
              })
              if (event === undefined) continue

              started += 1
              // Detached so one slow handler does not hold up the pump, and so a handler outlives
              // the tick that started it. `finish` releases the concurrency slot whatever happened,
              // including an interruption.
              yield* Effect.forkDetach(
                Effect.ensuring(
                  runOne({
                    active,
                    triggerIndex: event.triggerIndex,
                    triggerKind: event.triggerKind,
                    payload: event.payload,
                    correlationId: event.correlationId,
                    causationId: event.causationId,
                    causalDepth: event.causalDepth,
                  }),
                  queues.finish(active.workflowId),
                ),
              )
            }

            return started
          }),
      }
    }),
  )
}

/**
 * Parse a manifest's schedules once, at enable time.
 *
 * A schedule that does not parse is dropped rather than failing the restore: it was rejected at
 * enable, so reaching here means the database predates a parser change, and one bad schedule
 * should not stop every other workflow from coming back.
 */
const compileSchedules = (manifest: CompiledManifest): ActiveWorkflow['schedules'] => {
  const compiled: Array<{ parsed: CronSchedule; triggerIndex: number }> = []

  for (const schedule of manifest.schedules ?? []) {
    const parsed = parseCron(schedule.expression)
    if ('reason' in parsed) continue
    if (checkScheduleFloor(parsed, new Date(0)) !== undefined) continue
    compiled.push({ parsed, triggerIndex: schedule.triggerIndex })
  }

  return compiled
}
