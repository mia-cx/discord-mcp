import { RateGuardTrippedError } from '@discord-mcp/core'
import { Context, Layer } from 'effect'

/**
 * Cloudflare bans the source IP after 10,000 401/403/429 responses in 10 minutes. The per-scope
 * threshold is three orders of magnitude below that, because the usual failure is an agent in a
 * tight retry loop, and tripping tells it to stop and diagnose instead.
 */
export const DEFAULT_FAILURE_THRESHOLD = 25
/**
 * The ban guard proper. Every caller shares the IP, so the process stops after 1,000 rejections and
 * never has more than 100 calls awaiting Discord: at most 1,100 can land in one window.
 */
export const DEFAULT_PROCESS_THRESHOLD = 1_000
export const DEFAULT_MAX_IN_FLIGHT = 100
export const DEFAULT_WINDOW_MS = 10 * 60 * 1000

export interface RateGuardConfig {
  readonly threshold: number
  readonly processThreshold: number
  readonly maxInFlight: number
  readonly windowMs: number
}

export const defaultRateGuardConfig: RateGuardConfig = {
  threshold: DEFAULT_FAILURE_THRESHOLD,
  processThreshold: DEFAULT_PROCESS_THRESHOLD,
  maxInFlight: DEFAULT_MAX_IN_FLIGHT,
  windowMs: DEFAULT_WINDOW_MS,
}

/** Rejections are counted per credential and operation family, so one bad call site trips alone. */
export const rateGuardScope = (credential: string, operationFamily: string): string =>
  `${credential}/${operationFamily}`

/** The scope that totals every rejection the process records. */
const PROCESS_SCOPE = 'process'

/** Statuses that count toward the ban budget. 400s are free and must not be recorded. */
export const isCountedRejection = (status: number): boolean =>
  status === 401 || status === 403 || status === 429

/** A refused call carries the error to return; an admitted one must be settled exactly once. */
export type Admission =
  | { readonly refused: RateGuardTrippedError }
  | { readonly settle: (rejected: boolean) => void }

/**
 * Discord's rejections in a rolling window, and the calls still awaiting it. Create one per process
 * and hand it to every `RateGuard.layer` and to the login routes: Cloudflare counts the IP as one.
 */
export const rejectionLog = (
  config: RateGuardConfig = defaultRateGuardConfig,
  now: () => number = Date.now,
) => {
  const rejections = new Map<string, ReadonlyArray<number>>()
  let inFlight = 0
  const live = (scope: string) => {
    const kept = (rejections.get(scope) ?? []).filter((t) => t > now() - config.windowMs)
    if (kept.length === 0) rejections.delete(scope)
    else rejections.set(scope, kept)
    return kept.length
  }
  const refuse = (scope: string, count: number, message: string): Admission => ({
    refused: new RateGuardTrippedError({
      message: `Blocked before sending: ${message}`,
      scope,
      failures: count,
      windowMs: config.windowMs,
    }),
  })
  return {
    failureCount: live,
    /**
     * Admit one Discord call counted in `scopes` and the process. Settle it when Discord answers,
     * not when the caller stops waiting, so the in-flight cap bounds calls Discord can still reject.
     */
    admit: (scopes: ReadonlyArray<string>): Admission => {
      const minutes = Math.round(config.windowMs / 60_000)
      for (const scope of scopes) {
        const count = live(scope)
        if (count >= config.threshold) {
          return refuse(
            scope,
            count,
            `${count} rejected Discord responses for ${scope} within the last ${minutes} minutes.`,
          )
        }
      }
      const total = live(PROCESS_SCOPE)
      if (total >= config.processThreshold) {
        return refuse(
          PROCESS_SCOPE,
          total,
          `${total} rejected Discord responses for this relay within the last ${minutes} minutes.`,
        )
      }
      if (inFlight >= config.maxInFlight) {
        return refuse(PROCESS_SCOPE, total, `${inFlight} Discord calls are already in flight.`)
      }
      inFlight += 1
      let open = true
      return {
        settle: (rejected) => {
          if (!open) return
          open = false
          inFlight -= 1
          if (!rejected) return
          // Pruning every scope keeps the map bounded by the live rejections the thresholds allow.
          for (const known of [...rejections.keys()]) live(known)
          for (const scope of [...scopes, PROCESS_SCOPE]) {
            rejections.set(scope, [...(rejections.get(scope) ?? []), now()])
          }
        },
      }
    },
  }
}

export type RejectionLog = ReturnType<typeof rejectionLog>

/**
 * A rolling circuit breaker over repeated 401/403/429 responses.
 *
 * Tripping stops outbound calls and tells the agent to diagnose permissions or credentials rather
 * than retry. It does not reset on success: a loop that alternates between a working call and a
 * failing one still walks toward the ban.
 */
export class RateGuard extends Context.Service<RateGuard, RejectionLog>()('discord-api/RateGuard') {
  /** Pass a shared `log` to count across runtimes, such as one per HTTP request. */
  static readonly layer = (
    config: RateGuardConfig = defaultRateGuardConfig,
    log: RejectionLog = rejectionLog(config),
  ) => Layer.succeed(RateGuard)(log)
}
