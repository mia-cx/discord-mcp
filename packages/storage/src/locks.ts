/** One Postgres session, the one that holds the locks. */
export interface LockSession {
  readonly query: (
    text: string,
    values: ReadonlyArray<unknown>,
  ) => Promise<ReadonlyArray<Record<string, unknown>>>
  readonly close: () => Promise<void>
}

export interface AdvisoryLocks {
  readonly lock: (key: string) => Promise<boolean>
  readonly unlock: (key: string) => Promise<void>
  readonly close: () => Promise<void>
}

/**
 * Session advisory locks, keyed by name, on a session of their own. A pooled connection would hand
 * the session holding them to other queries, and a transaction pooler such as PgBouncer can't hold
 * them at all. `connect` opens the session and calls `onLost` when it ends, which releases every
 * lock it held; the next `lock` opens a new one.
 *
 * Postgres counts repeated locks by one session, so each key is taken at most once.
 */
export const advisoryLocks = (
  connect: (onLost: () => void) => Promise<LockSession>,
): AdvisoryLocks => {
  let current: { readonly session: Promise<LockSession>; readonly held: Set<string> } | undefined
  const open = () => {
    if (current !== undefined) return current
    const opened = {
      session: connect(() => {
        if (current === opened) current = undefined
      }),
      held: new Set<string>(),
    }
    opened.session.catch(() => {
      if (current === opened) current = undefined
    })
    current = opened
    return opened
  }
  return {
    lock: async (key) => {
      const { session, held } = open()
      if (held.has(key)) return true
      const [row] = await (await session).query(
        'select pg_try_advisory_lock(hashtextextended($1, 0)) as locked',
        [key],
      )
      if (row?.locked === true) held.add(key)
      return held.has(key)
    },
    unlock: async (key) => {
      const opened = current
      if (opened === undefined || !opened.held.delete(key)) return
      await (await opened.session).query('select pg_advisory_unlock(hashtextextended($1, 0))', [
        key,
      ])
    },
    close: async () => {
      const opened = current
      current = undefined
      await (await opened?.session.catch(() => undefined))?.close()
    },
  }
}
