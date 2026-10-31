import type { Clock } from './clock.ts'
import { type Shard, startShard } from './shard.ts'
import type { TokenVault } from './vault.ts'

export const IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1000
export const DISCORD_GATEWAY_URL = 'wss://gateway.discord.gg'

export interface BotRuntimesOptions {
  readonly vault: TokenVault
  readonly clock: Clock
  /** Operator-facing lifecycle messages and failures. Never receives a token. */
  readonly log: (message: string) => void
  readonly gatewayUrl?: string
}

export interface BotRuntimes {
  /**
   * Record an agent call for a bot Discord has verified. The first call stores its token and
   * brings it online; each call restarts its 24-hour idle timer. Resolves once the token is
   * stored. Failures are logged rather than thrown, so they never fail the agent's call.
   */
  readonly use: (botId: string, token: string) => Promise<void>
  /** Take every bot offline. */
  readonly close: () => void
}

interface Runtime {
  readonly token: string
  /** Settles once this runtime's token write has finished or failed. */
  stored: Promise<void>
  shard?: Shard
  cancelIdle: () => void
}

/** The bots this process keeps online, one runtime per bot. */
export const createBotRuntimes = ({
  vault,
  clock,
  log,
  gatewayUrl = DISCORD_GATEWAY_URL,
}: BotRuntimesOptions): BotRuntimes => {
  const running = new Map<string, Runtime>()
  /** Tokens Discord rejected for good, by bot. Retrying them only spends Identifies. */
  const rejected = new Map<string, string>()

  const stop = (botId: string, runtime: Runtime) => {
    if (running.get(botId) !== runtime) return
    running.delete(botId)
    runtime.cancelIdle()
    runtime.shard?.stop()
  }

  const keepAlive = (botId: string, runtime: Runtime) => {
    runtime.cancelIdle()
    runtime.cancelIdle = clock.schedule(() => {
      log(`Bot ${botId} went offline after 24 hours without an agent call.`)
      stop(botId, runtime)
    }, IDLE_TIMEOUT_MS)
  }

  const start = async (botId: string, runtime: Runtime, previous: Promise<void>) => {
    // Writes for one bot run in order, so a replaced token never overwrites its successor.
    await previous
    try {
      await vault.store(botId, runtime.token)
    } catch (cause) {
      log(`Bot ${botId} stays offline: ${cause instanceof Error ? cause.message : String(cause)}`)
      return stop(botId, runtime)
    }
    // Idle, closed, or replaced by a new token while storing.
    if (running.get(botId) !== runtime) return
    runtime.shard = startShard({
      token: runtime.token,
      gatewayUrl,
      clock,
      onReady: () => log(`Bot ${botId} is online.`),
      onIdentifyBudgetSpent: (waitMs) =>
        log(
          `Bot ${botId} is offline: it spent its daily Gateway Identify budget. Reconnecting in ${Math.ceil(waitMs / 60_000)} minutes.`,
        ),
      onFatal: (code) => {
        log(
          `Bot ${botId} is offline: Discord closed its Gateway session with code ${code}. It stays offline until its token changes or the server restarts.`,
        )
        rejected.set(botId, runtime.token)
        stop(botId, runtime)
      },
    })
  }

  return {
    use: (botId, token) => {
      if (rejected.get(botId) === token) return Promise.resolve()
      const current = running.get(botId)
      if (current?.token === token) {
        keepAlive(botId, current)
        return Promise.resolve()
      }
      // A reset token invalidates the old session, so start over with the new one.
      if (current !== undefined) stop(botId, current)
      const runtime: Runtime = { token, stored: Promise.resolve(), cancelIdle: () => {} }
      running.set(botId, runtime)
      keepAlive(botId, runtime)
      runtime.stored = start(botId, runtime, current?.stored ?? Promise.resolve())
      return runtime.stored
    },
    close: () => {
      for (const [botId, runtime] of running) stop(botId, runtime)
    },
  }
}
