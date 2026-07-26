import { DiscordGateway } from '@discord-mcp/discord-gateway'
import { WorkflowDispatcher } from '@discord-mcp/workflow-runtime'
import { Effect, Schedule } from 'effect'

/**
 * The background loops that make enabled workflows actually run.
 *
 * Three of them, deliberately separate: the Gateway feeds events in, the clock feeds schedules in,
 * and the pump takes work out. Combining them would mean a slow handler delaying event intake,
 * which is the failure that makes a bot look dead while its queue quietly fills.
 *
 * Each loop is supervised and restarts on failure. An automation subsystem that dies quietly is
 * worse than one that never started, because nobody notices.
 */

/** How often the pump looks for work. Fast enough to feel immediate, slow enough to be free. */
const PUMP_INTERVAL_MS = 250

/** Schedules have minute resolution, so anything finer is wasted work. */
const TICK_INTERVAL_MS = 30_000

export const startAutomation = Effect.gen(function* () {
  const dispatcher = yield* WorkflowDispatcher

  // Enabled means enabled: whatever an operator turned on before the restart is running after it.
  const restored = yield* dispatcher.restore()
  yield* Effect.log(
    restored.length === 0
      ? 'No enabled workflows to restore.'
      : `Restored ${restored.length} enabled workflow(s): ${restored.map((w) => w.slug).join(', ')}`,
  )

  // Gateway events. Subscribing here rather than inside the dispatcher keeps the runtime package
  // free of any Gateway dependency — it states what it needs and the application supplies it.
  const gateway = yield* Effect.serviceOption(DiscordGateway)
  if (gateway._tag === 'Some' && restored.some((w) => w.manifest.gatewayEventTypes.length > 0)) {
    yield* Effect.forkDetach(
      Effect.catchCause(
        Effect.gen(function* () {
          yield* gateway.value.ensureConnected

          // Cursor-based rather than callback-based, so an event that arrives while a previous
          // batch is being dispatched is still delivered rather than dropped.
          let cursor = (yield* gateway.value.status).latestCursor

          while (true) {
            const batch = yield* gateway.value.waitFor(
              // `includeBotAuthored` so the dispatcher sees them and the *grant* decides. Filtering
              // here would make `includeBotAuthoredEvents` unenforceable rather than default-off.
              { cursor, limit: 100, includeBotAuthored: true },
              30_000,
            )

            for (const event of batch.events) {
              cursor = Math.max(cursor, event.sequence)
              yield* dispatcher.onGatewayEvent({
                type: event.type,
                botAuthored: event.botAuthored,
                correlationId: event.correlationId,
                payload: event.payload,
                ...(event.guildId === undefined ? {} : { guildId: event.guildId }),
                ...(event.channelId === undefined ? {} : { channelId: event.channelId }),
                ...(event.causationId === undefined ? {} : { causationId: event.causationId }),
              })
            }
          }
        }),
        (cause) => Effect.logError(`The Gateway dispatch loop stopped: ${cause}`),
      ),
    )
  }

  yield* Effect.forkDetach(
    Effect.repeat(
      Effect.catchCause(
        Effect.flatMap(
          Effect.clockWith((clock) => clock.currentTimeMillis),
          (now) => dispatcher.tick(new Date(now)),
        ),
        (cause) => Effect.logError(`A schedule tick failed: ${cause}`),
      ),
      Schedule.spaced(TICK_INTERVAL_MS),
    ),
  )

  yield* Effect.forkDetach(
    Effect.repeat(
      Effect.catchCause(dispatcher.pump(), (cause) =>
        Effect.logError(`The workflow pump failed: ${cause}`),
      ),
      Schedule.spaced(PUMP_INTERVAL_MS),
    ),
  )
})
