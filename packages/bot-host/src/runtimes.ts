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

  const start = async (botId: string, runtime: Runtime) => {
    try {
      await vault.store(botId, runtime.token)
    } catch (cause) {
      log(`Bot ${botId} stays offline: storing its token failed: ${String(cause)}`)
      return stop(botId, runtime)
    }
    // Idle, closed, or replaced by a new token while storing.
    if (running.get(botId) !== runtime) return
    runtime.shard = startShard({
      token: runtime.token,
      gatewayUrl,
      clock,
      onReady: () => log(`Bot ${botId} is online.`),
      onFatal: (code) => {
        log(`Bot ${botId} is offline: Discord closed its Gateway session with code ${code}.`)
        stop(botId, runtime)
      },
    })
  }

  return {
    use: (botId, token) => {
      const current = running.get(botId)
      if (current?.token === token) {
        keepAlive(botId, current)
        return Promise.resolve()
      }
      // A reset token invalidates the old session, so start over with the new one.
      if (current !== undefined) stop(botId, current)
      const runtime: Runtime = { token, cancelIdle: () => {} }
      running.set(botId, runtime)
      keepAlive(botId, runtime)
      return start(botId, runtime)
    },
    close: () => {
      for (const [botId, runtime] of running) stop(botId, runtime)
    },
  }
}
