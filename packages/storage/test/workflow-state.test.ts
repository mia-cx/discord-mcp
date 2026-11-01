import { afterEach, describe, expect, it } from 'vitest'
import type { Storage, WorkflowRun } from '../src/index.ts'
import { inMemoryStorage } from '../src/testing.ts'

const BOT = '345678901234567890'
const OTHER_BOT = '345678901234567891'
const HUMAN = '234567890123456789'
const DAY = 24 * 60 * 60 * 1000
const KEEP = 1000
const grants = { operations: [], families: [], hosts: [] }

const cleanup: Array<() => unknown> = []
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})

const setup = async () => {
  const storage = await inMemoryStorage()
  cleanup.push(() => storage.close())
  const publish = async (name: string, botId = BOT) =>
    (
      await storage.publishWorkflow({
        botId,
        name,
        source: '',
        grants,
        events: ['messageCreate'],
        intents: 0,
        actorId: HUMAN,
      })
    ).workflowId
  return { storage, publish }
}

describe('workflow state', () => {
  it('belongs to one workflow, lasts across revisions, and goes with the workflow', async () => {
    const { storage, publish } = await setup()
    const counter = await publish('counter')
    const other = await publish('other')

    await storage.storeWorkflowValue(counter, 'count', '1', 1024)
    expect(await storage.loadWorkflowValue(counter, 'count')).toBe('1')
    expect(await storage.loadWorkflowValue(other, 'count')).toBeUndefined()

    expect(await publish('counter')).toBe(counter)
    expect(await storage.loadWorkflowValue(counter, 'count')).toBe('1')

    await storage.deleteWorkflow(BOT, 'counter', HUMAN)
    const republished = await publish('counter')
    expect(await storage.loadWorkflowValue(republished, 'count')).toBeUndefined()
  })

  it('refuses a write past the limit and keeps what was stored', async () => {
    const { storage, publish } = await setup()
    const id = await publish('counter')

    // "a" and "1234" take five bytes; replacing a value counts only the new one.
    expect(await storage.storeWorkflowValue(id, 'a', '1234', 10)).toEqual({
      stored: true,
      bytes: 5,
    })
    expect(await storage.storeWorkflowValue(id, 'a', '123456789', 10)).toEqual({
      stored: true,
      bytes: 10,
    })
    expect(await storage.storeWorkflowValue(id, 'b', '1', 10)).toEqual({ stored: false, bytes: 12 })
    expect(await storage.loadWorkflowValue(id, 'a')).toBe('123456789')
    expect(await storage.loadWorkflowValue(id, 'b')).toBeUndefined()

    await storage.deleteWorkflowValue(id, 'a')
    expect((await storage.storeWorkflowValue(id, 'b', '1', 10)).stored).toBe(true)
  })

  it('lets concurrent writes fill the limit but never pass it', async () => {
    const { storage, publish } = await setup()
    const id = await publish('counter')

    // Each write takes ten bytes; only ten of them fit in a hundred.
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        storage.storeWorkflowValue(id, `k${String(i).padStart(2, '0')}`, '1234567', 100),
      ),
    )

    expect(results.filter((result) => result.stored)).toHaveLength(10)
  })
})

describe('workflow runs', () => {
  const run = (workflowId: string, at: number, overrides: Partial<WorkflowRun> = {}) => ({
    workflowId,
    revision: 1,
    event: 'MESSAGE_CREATE',
    outcome: 'completed' as const,
    error: null,
    logs: [],
    receivedAt: new Date(at),
    finishedAt: new Date(at),
    ...overrides,
  })
  const names = async (storage: Storage, botId: string, query = {}) =>
    (await storage.workflowRuns(botId, { since: new Date(0), limit: 10, ...query })).map(
      ({ workflowName, outcome }) => `${workflowName}:${outcome}`,
    )

  it("are read back newest first, only for the asking bot's workflows", async () => {
    const { storage, publish } = await setup()
    const a = await publish('a')
    const b = await publish('b')
    const foreign = await publish('a', OTHER_BOT)
    await storage.recordWorkflowRun(run(a, 1, { logs: ['hi'] }), KEEP)
    await storage.recordWorkflowRun(run(b, 2, { outcome: 'threw', error: 'Error: no' }), KEEP)
    await storage.recordWorkflowRun(run(foreign, 3), KEEP)

    expect(await names(storage, BOT)).toEqual(['b:threw', 'a:completed'])
    expect(await names(storage, BOT, { name: 'a' })).toEqual(['a:completed'])
    expect(await names(storage, BOT, { failed: true })).toEqual(['b:threw'])
    expect(await names(storage, BOT, { limit: 1 })).toEqual(['b:threw'])
    expect(await names(storage, OTHER_BOT)).toEqual(['a:completed'])
    expect(
      (await storage.workflowRuns(BOT, { name: 'a', since: new Date(0), limit: 1 }))[0],
    ).toMatchObject({ revision: 1, event: 'MESSAGE_CREATE', logs: ['hi'], error: null })
  })

  it('keep only the newest of each workflow, and stay readable until they expire', async () => {
    const { storage, publish } = await setup()
    const busy = await publish('busy')
    const quiet = await publish('quiet')
    const now = 10 * DAY
    await storage.recordWorkflowRun(run(quiet, now - 8 * DAY), 3)
    await storage.recordWorkflowRun(run(quiet, now - 6 * DAY), 3)
    // The oldest failure falls out of the newest three, so a failures-only read can't find it.
    await storage.recordWorkflowRun(run(busy, now - 4, { outcome: 'threw' }), 3)
    for (let i = 3; i >= 0; i -= 1) await storage.recordWorkflowRun(run(busy, now - i), 3)

    const kept = await storage.workflowRuns(BOT, { name: 'busy', since: new Date(0), limit: 10 })
    expect(kept.map((r) => r.finishedAt.getTime())).toEqual([now, now - 1, now - 2])
    expect(await names(storage, BOT, { name: 'busy', failed: true })).toEqual([])

    const since = new Date(now - 7 * DAY)
    expect(await names(storage, BOT, { name: 'quiet', since })).toEqual(['quiet:completed'])
    expect(await storage.pruneWorkflowRuns(since)).toBe(1)
    expect(await names(storage, BOT, { name: 'quiet' })).toHaveLength(1)
  })
})
