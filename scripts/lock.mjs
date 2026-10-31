import { randomBytes } from 'node:crypto'
import { readFile, rm, stat, writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'

// Every holder finishes well within this (a bridge's refresh gives up after 30 seconds), so an
// older lock belongs to a crashed process.
const LOCK_STALE_MS = 60_000

/**
 * Run `task` holding `${file}.lock`, which every bridge and `login.mjs --replace` share.
 *
 * Best effort: after a crash, two waiters can both clear the stale lock and overlap once. Callers
 * keep that harmless rather than impossible. `task` receives `overlapped()`, true when this holder
 * cleared a stale lock or another process has since taken the lock, so only then must it expect a
 * concurrent writer.
 */
export const locked = async (file, task) => {
  const lock = `${file}.lock`
  const owner = randomBytes(16).toString('hex')
  let cleared = false
  for (;;) {
    try {
      await writeFile(lock, owner, { flag: 'wx', mode: 0o600 })
      break
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const stale = await stat(lock).then(
        (lockStat) => Date.now() - lockStat.mtimeMs > LOCK_STALE_MS,
        () => false,
      )
      if (stale) {
        await rm(lock, { force: true })
        cleared = true
      } else await delay(50)
    }
  }
  const held = async () => (await readFile(lock, 'utf8').catch(() => '')) === owner
  try {
    return await task(async () => cleared || !(await held()))
  } finally {
    if (await held()) await rm(lock, { force: true })
  }
}
