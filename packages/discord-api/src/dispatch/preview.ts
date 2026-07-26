import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { Context, Effect, Layer, Ref, Schema } from 'effect'

/**
 * Preview tokens make a destructive call a two-step act: describe exactly what will happen, then
 * execute *that* — not something adjacent to it.
 *
 * The binding is the point. A token names the principal, the operation, a hash of the normalized
 * arguments, the auth profile, and the resolved targets, so a model cannot preview a harmless
 * deletion and then execute a different one with the same token. Sixty seconds is long enough for
 * one turn and short enough that a token cannot outlive the reasoning that produced it.
 */
export const PREVIEW_TOKEN_TTL_MS = 60_000

export class PreviewTokenError extends Schema.TaggedErrorClass<PreviewTokenError>()(
  'PreviewTokenError',
  { message: Schema.String, suggestion: Schema.String },
) {}

export interface PreviewBinding {
  readonly principalId: string
  readonly operationId: string
  readonly authProfile: string
  /** SHA-256 over the canonicalised arguments. */
  readonly argumentHash: string
  /** Guild, channel, role, or user IDs the call will affect. */
  readonly targets: ReadonlyArray<string>
}

/**
 * Canonical JSON: keys sorted at every level, so argument order cannot change the hash.
 *
 * Without this, `{a:1,b:2}` and `{b:2,a:1}` would produce different hashes and a valid token would
 * be rejected for no reason a user could understand.
 */
const canonicalise = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalise)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, canonicalise(v)]),
  )
}

export const hashArguments = (args: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify(canonicalise(args)))
    .digest('hex')

interface StoredToken extends PreviewBinding {
  readonly expiresAt: number
}

const constantTimeEquals = (a: string, b: string): boolean => {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

export class PreviewTokens extends Context.Service<
  PreviewTokens,
  {
    readonly issue: (binding: PreviewBinding) => Effect.Effect<{ token: string; expiresAt: number }>
    /** Consumes the token: a preview authorises exactly one execution. */
    readonly redeem: (
      token: string,
      binding: PreviewBinding,
    ) => Effect.Effect<void, PreviewTokenError>
  }
>()('discord-api/PreviewTokens') {
  static readonly layer = Layer.effect(PreviewTokens)(
    Effect.gen(function* () {
      const store = yield* Ref.make<ReadonlyMap<string, StoredToken>>(new Map())

      const now = Effect.clockWith((c) => c.currentTimeMillis)

      const fail = (message: string, suggestion: string) =>
        Effect.fail(new PreviewTokenError({ message, suggestion }))

      return {
        issue: (binding) =>
          Effect.gen(function* () {
            const issuedAt = yield* now
            const token = randomBytes(32).toString('base64url')
            const expiresAt = issuedAt + PREVIEW_TOKEN_TTL_MS

            yield* Ref.update(store, (current) => {
              // Expired entries are dropped on write rather than on a timer: the store is small,
              // and a sweep that only runs when something is added cannot leak unboundedly.
              const next = new Map([...current].filter(([, v]) => v.expiresAt > issuedAt))
              next.set(token, { ...binding, expiresAt })
              return next
            })
            return { token, expiresAt }
          }),

        redeem: (token, binding) =>
          Effect.gen(function* () {
            const current = yield* Ref.get(store)
            const at = yield* now

            // Find by constant-time comparison so a token cannot be discovered by timing.
            const entry = [...current.entries()].find(([k]) => constantTimeEquals(k, token))
            if (entry === undefined) {
              return yield* fail(
                'The preview token is unknown, already used, or expired.',
                'Do not retry with the same token. Call the matching discord_api_preview again and use the token it returns within 60 seconds.',
              )
            }

            const [key, stored] = entry
            yield* Ref.update(store, (c) => {
              const next = new Map(c)
              next.delete(key)
              return next
            })

            if (stored.expiresAt <= at) {
              return yield* fail(
                'The preview token has expired.',
                'Preview tokens last 60 seconds. Call discord_api_preview again and execute promptly.',
              )
            }

            const mismatches: string[] = []
            if (stored.principalId !== binding.principalId) mismatches.push('principal')
            if (stored.operationId !== binding.operationId) mismatches.push('operation')
            if (stored.authProfile !== binding.authProfile) mismatches.push('auth profile')
            if (stored.argumentHash !== binding.argumentHash) mismatches.push('arguments')
            if (stored.targets.join(',') !== binding.targets.join(',')) mismatches.push('targets')

            return mismatches.length === 0
              ? undefined
              : yield* fail(
                  `The preview token was issued for a different ${mismatches.join(', ')}.`,
                  'A preview authorises exactly the call it described. Preview the call you actually intend to make, then execute that one unchanged.',
                )
          }),
      }
    }),
  )
}
