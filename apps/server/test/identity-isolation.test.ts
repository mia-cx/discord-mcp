import { AsyncLocalStorage } from 'node:async_hooks'
import { describe, expect, it } from 'vitest'

/**
 * Two concurrent requests must not see each other's principal.
 *
 * The HTTP transport resolves identity per request, but `registerTool`'s callback cannot take extra
 * arguments, so the principal has to reach the handler out of band. The obvious implementation — a
 * single mutable slot on the closure — is wrong under concurrency: request B overwrites the slot
 * between A's authentication and A's authorization, and A then executes as B. A low-scope caller
 * interleaved with an administrator would run with administrator scopes.
 *
 * These assert the property directly, because the tool suite drives one request at a time and would
 * never notice.
 */

interface Principal {
  readonly id: string
}

/** What the fix does: async context, scoped to the request. */
const scoped = new AsyncLocalStorage<Principal>()

/** What a mutable slot does, kept here so the difference is visible rather than asserted. */
let slot: Principal | undefined

const handle = async (
  principal: Principal,
  read: () => Principal | undefined,
  enter: (
    p: Principal,
    use: () => Promise<Principal | undefined>,
  ) => Promise<Principal | undefined>,
) =>
  enter(principal, async () => {
    // Any await between authenticating and reading the principal is enough for another request to
    // interleave — and every real handler has one.
    await new Promise((resolve) => setTimeout(resolve, Math.random() * 5))
    return read()
  })

describe('per-request identity', () => {
  it('keeps each request on its own principal under concurrency', async () => {
    const principals = Array.from({ length: 40 }, (_, i) => ({ id: `principal-${i}` }))

    const seen = await Promise.all(
      principals.map((p) =>
        handle(
          p,
          () => scoped.getStore(),
          (principal, use) => scoped.run(principal, use),
        ),
      ),
    )

    expect(seen.map((s) => s?.id)).toEqual(principals.map((p) => p.id))
  })

  it('demonstrates that a mutable slot does not', async () => {
    const principals = Array.from({ length: 40 }, (_, i) => ({ id: `principal-${i}` }))

    const seen = await Promise.all(
      principals.map((p) =>
        handle(
          p,
          () => slot,
          async (principal, use) => {
            slot = principal
            return use()
          },
        ),
      ),
    )

    // At least one request read someone else's principal. This is the bug, pinned so the reason the
    // production code uses async context is not mistaken for style.
    const crossed = seen.filter((s, i) => s?.id !== principals[i]?.id)
    expect(crossed.length).toBeGreaterThan(0)
  })
})
