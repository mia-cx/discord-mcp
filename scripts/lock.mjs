import { randomBytes } from 'node:crypto'
import { link, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'

// Every holder finishes well within this (a bridge's refresh gives up after 30 seconds), so an
// older lock belongs to a crashed process.
const LOCK_STALE_MS = 60_000

/**
 * Remove `lock` if its holder crashed. The waiter that hard-links it to a name derived from its
 * owner claims it; nobody else can create that name, so two waiters never both remove it, and a
 * waiter that judged an older lock stale never removes the lock that replaced it.
 */
const reclaim = async (lock) => {
  const stale = await readFile(lock, 'utf8')
  if (Date.now() - (await stat(lock)).mtimeMs <= LOCK_STALE_MS) return
  const claim = `${lock}.${stale}`
  await link(lock, claim)
  try {
    if ((await readFile(claim, 'utf8')) === stale) await rm(lock)
  } finally {
    await rm(claim, { force: true })
  }
}

/** Run `task` holding `${file}.lock`, which every bridge and `login.mjs --replace` share. */
export const locked = async (file, task) => {
  const lock = `${file}.lock`
  const owner = randomBytes(16).toString('hex')
  for (;;) {
    try {
      await writeFile(lock, owner, { flag: 'wx', mode: 0o600 })
      break
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      // A failed claim means the lock is live, gone, or another waiter is reclaiming it.
      await reclaim(lock).catch(() => {})
      await delay(50)
    }
  }
  try {
    return await task()
  } finally {
    if ((await readFile(lock, 'utf8').catch(() => '')) === owner) await rm(lock, { force: true })
  }
}
