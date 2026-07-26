import { DiscordGateway, type NormalizedEvent } from '@discord-mcp/discord-gateway'
import { EventLog, WorkflowDispatcher } from '@discord-mcp/workflow-runtime'
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

/**
 * Record one event durably, then offer it to every workflow that wants it.
 *
 * Recorded first and best-effort: a workflow that fails must not lose the event that caused it, and
 * a full disk must not stop the bot reacting.
 */
const handleEvent = (
  event: NormalizedEvent,
  log: EventLog['Service'],
  dispatcher: WorkflowDispatcher['Service'],
) =>
  Effect.gen(function* () {
    yield* Effect.ignore(
      log.append({
        type: event.type,
        correlationId: event.correlationId,
        receivedAt: Date.parse(event.receivedAt),
        payload: event.payload,
        ...(event.discordEventId === undefined ? {} : { discordEventId: event.discordEventId }),
        ...(event.shardId === undefined ? {} : { shardId: event.shardId }),
        ...(event.guildId === undefined ? {} : { guildId: event.guildId }),
        ...(event.channelId === undefined ? {} : { channelId: event.channelId }),
        ...(event.causationId === undefined ? {} : { causationId: event.causationId }),
      }),
    )

    yield* dispatcher.onGatewayEvent({
      type: event.type,
      botAuthored: event.botAuthored,
      correlationId: event.correlationId,
      payload: event.payload,
      ...(event.guildId === undefined ? {} : { guildId: event.guildId }),
      ...(event.channelId === undefined ? {} : { channelId: event.channelId }),
      ...(event.causationId === undefined ? {} : { causationId: event.causationId }),
    })
  })

/**
 * Read the Gateway forever, by cursor.
 *
 * Cursor-based rather than callback-based: an event that arrives while a previous batch is being
 * dispatched is still delivered rather than dropped.
 */
const gatewayLoop = (
  gateway: DiscordGateway['Service'],
  log: EventLog['Service'],
  dispatcher: WorkflowDispatcher['Service'],
) =>
  Effect.gen(function* () {
    yield* gateway.ensureConnected
    let cursor = (yield* gateway.status).latestCursor

    while (true) {
      const batch = yield* gateway.waitFor(
        // `includeBotAuthored` so the dispatcher sees them and the *grant* decides. Filtering here
        // would make `includeBotAuthoredEvents` unenforceable rather than default-off.
        { cursor, limit: 100, includeBotAuthored: true },
        30_000,
      )

      for (const event of batch.events) {
        cursor = Math.max(cursor, event.sequence)
        yield* handleEvent(event, log, dispatcher)
      }
    }
  })

export const startAutomation = Effect.gen(function* () {
  const dispatcher = yield* WorkflowDispatcher
  const log = yield* EventLog

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
  // Runs whenever the Gateway is on, not only when some workflow subscribes: the durable log is
  // what `events_tail` reads, and it is useful with no workflows at all.
  if (gateway._tag === 'Some') {
    yield* Effect.forkDetach(
      Effect.catchCause(gatewayLoop(gateway.value, log, dispatcher), (cause) =>
        Effect.logError(`The Gateway dispatch loop stopped: ${cause}`),
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
