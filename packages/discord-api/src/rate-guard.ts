import { Schema } from 'effect'

export interface RateGuardOptions {
  readonly threshold?: number
  readonly windowMs?: number
}

export class RateGuardTrippedError extends Schema.TaggedErrorClass<RateGuardTrippedError>()(
  'RateGuardTrippedError',
  {
    message: Schema.String,
    profile: Schema.String,
    family: Schema.String,
  },
) {
  constructor(
    readonly profile: string,
    readonly family: string,
  ) {
    super({
      message: `RateGuard stopped Discord calls for ${profile}/${family}; diagnose credentials or permissions before retrying.`,
      profile,
      family,
    })
  }
}

/** Rolling guard far below Discord's invalid-request IP-ban threshold. */
export class RateGuard {
  readonly #threshold: number
  readonly #windowMs: number
  readonly #failures = new Map<string, Array<number>>()

  constructor(options: RateGuardOptions = {}) {
    this.#threshold = options.threshold ?? 25
    this.#windowMs = options.windowMs ?? 10 * 60_000
  }

  check(profile: string, family: string, now = Date.now()): void {
    const failures = this.#recent(profile, family, now)
    if (failures.length >= this.#threshold) {
      throw new RateGuardTrippedError(profile, family)
    }
  }

  record(profile: string, family: string, status: number, now = Date.now()): void {
    if (status !== 401 && status !== 403 && status !== 429) return
    const key = `${profile}\0${family}`
    const failures = this.#recent(profile, family, now)
    failures.push(now)
    this.#failures.set(key, failures)
  }

  clear(profile: string, family: string): void {
    this.#failures.delete(`${profile}\0${family}`)
  }

  #recent(profile: string, family: string, now: number): Array<number> {
    const key = `${profile}\0${family}`
    const cutoff = now - this.#windowMs
    const recent = (this.#failures.get(key) ?? []).filter((timestamp) => timestamp >= cutoff)
    this.#failures.set(key, recent)
    return recent
  }
}
