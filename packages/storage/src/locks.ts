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
 * Postgres counts repeated locks by one session, so each key is taken at most once. A statement
 * that fails, such as one past its timeout, may still have taken or released its lock, so its
 * session ends too.
 */
export const advisoryLocks = (
  connect: (onLost: () => void) => Promise<LockSession>,
): AdvisoryLocks => {
  type Opened = { readonly session: Promise<LockSession>; readonly held: Set<string> }
  let current: Opened | undefined
  const query = async (opened: Opened, text: string, key: string) => {
    const session = await opened.session
    try {
      return await session.query(text, [key])
    } catch (error) {
      if (current === opened) current = undefined
      await session.close().catch(() => {})
      throw error
    }
  }
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
      const opened = open()
      if (opened.held.has(key)) return true
      const [row] = await query(
        opened,
        'select pg_try_advisory_lock(hashtextextended($1, 0)) as locked',
        key,
      )
      if (row?.locked === true) opened.held.add(key)
      return opened.held.has(key)
    },
    unlock: async (key) => {
      const opened = current
      if (opened === undefined || !opened.held.delete(key)) return
      await query(opened, 'select pg_advisory_unlock(hashtextextended($1, 0))', key)
    },
    close: async () => {
      const opened = current
      current = undefined
      await (await opened?.session.catch(() => undefined))?.close()
    },
  }
}
