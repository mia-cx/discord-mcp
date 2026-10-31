import { manualClock } from '@discord-mcp/bot-host/testing'
import { connectStorage, type Storage } from '@discord-mcp/storage'
import { inMemoryStorage, postgresTestDatabase } from '@discord-mcp/storage/testing'
import { OperationCatalog } from '@mia-cx/discord-catalog'
import { Effect } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IsolateHost, ScriptExecution } from '../src/isolate-host.ts'
import { makeIsolateHost } from '../src/isolate-host.ts'
import { makeWorkflowHost } from '../src/workflows.ts'

const BOT = { id: '345678901234567890', username: 'textile', discriminator: '0', bot: true }
const HUMAN = '234567890123456789'
const caller = { botId: BOT.id, botUser: BOT, actorId: HUMAN }
const grants = { operations: [], families: ['message'], hosts: [] }
const MINUTE = 60_000
/** A Monday, 90 seconds before 09:00 UTC. */
const START = Date.parse('2026-11-02T08:58:30.000Z')

const catalog = await Effect.runPromise(Effect.provide(OperationCatalog, OperationCatalog.layer))
/** Real Postgres, for the lock PGlite's one session can't contend for. CI provides it. */
const database = await postgresTestDatabase()
const cleanup: Array<() => unknown> = []
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})

/**
 * One bot host's workflow host on `storage`. Unless given real ones, its isolates only record what
 * each run was handed. `nextMinute` moves its clock to the next minute and waits for that minute's
 * sync.
 */
const botHost = (
  storage: Storage,
  {
    clock = manualClock(0.5, START),
    isolates,
  }: { clock?: ReturnType<typeof manualClock>; isolates?: IsolateHost } = {},
) => {
  const runs: ScriptExecution[] = []
  const recording: IsolateHost = {
    run: async (execution) => {
      runs.push(execution)
      return { outcome: 'completed', result: null, logs: [] }
    },
  }
  let armed = 0
  let online = true
  const host = makeWorkflowHost({
    storage,
    isolates: isolates ?? recording,
    bots: {
      hold: async () => {},
      updatePresence: () => {},
      tokenOf: () => (online ? 'private-bot-token' : undefined),
    },
    clock: {
      date: clock.date,
      schedule: (callback, ms) => {
        armed += 1
        return clock.schedule(callback, ms)
      },
    },
    operations: catalog.all,
    rest: () => ({
      client: { raw: undefined as never, request: () => Effect.succeed(BOT) },
      release: () => {},
    }),
    log: () => {},
  })
  cleanup.push(() => host.close())
  /** The scheduler re-arms its timer once each sync finishes. */
  const synced = async (times: number) =>
    vi.waitFor(() => expect(armed).toBe(times), { interval: 1 })
  return {
    host,
    clock,
    /** Whether the bot is online, as when its stored session has resumed. */
    setOnline: (value: boolean) => {
      online = value
    },
    /** Start the host as the server does, and wait for its first sync. */
    start: async () => {
      await host.restore()
      await synced(1)
    },
    nextMinute: async () => {
      const before = armed
      clock.advance(MINUTE - (clock.date() % MINUTE))
      await synced(before + 1)
    },
    /** Each tick handed to an isolate, in order. */
    ticks: () => runs.map(({ input }) => input),
  }
}

/** Publish and enable `schedules` for the bot, as an agent's tool calls do. */
const enableSchedules = async (
  storage: Storage,
  host: ReturnType<typeof botHost>['host'],
  schedules: ReadonlyArray<string>,
) => {
  await storage.publishWorkflow({
    botId: BOT.id,
    name: 'digest',
    source: '',
    grants,
    events: ['schedule'],
    intents: 0,
    schedules,
    actorId: HUMAN,
  })
  await host.enable(caller, 'digest', undefined, 0)
}

const tick = (cron: string, at: string) => ({ tick: { cron, scheduledAt: at } })

describe('workflow schedules', () => {
  it('fire each tick once from when they are enabled, until disabled', async () => {
    const storage = await inMemoryStorage()
    cleanup.push(() => storage.close())
    const host = botHost(storage)
    await host.start()
    // 08:58:30, so the 08:55 tick is before the workflow ran.
    await enableSchedules(storage, host.host, ['*/5 * * * *'])

    // Through 09:10, then through 09:15 disabled.
    for (let minute = 0; minute < 12; minute += 1) await host.nextMinute()
    const fired = [
      tick('*/5 * * * *', '2026-11-02T09:00:00.000Z'),
      tick('*/5 * * * *', '2026-11-02T09:05:00.000Z'),
      tick('*/5 * * * *', '2026-11-02T09:10:00.000Z'),
    ]
    await vi.waitFor(() => expect(host.ticks()).toEqual(fired))
    await host.host.disable(caller, 'digest')
    for (let minute = 0; minute < 5; minute += 1) await host.nextMinute()

    expect(host.ticks()).toEqual(fired)
  })

  it('run a tick missed while no bot host ran them once, late, when one starts', async () => {
    const storage = await inMemoryStorage()
    cleanup.push(() => storage.close())
    const before = botHost(storage)
    await before.start()
    await enableSchedules(storage, before.host, ['0 * * * *', '30 9 * * *'])
    await before.nextMinute()
    await before.nextMinute()
    await vi.waitFor(() =>
      expect(before.ticks()).toEqual([tick('0 * * * *', '2026-11-02T09:00:00.000Z')]),
    )
    await before.host.close()

    // Down from 09:00:00 to 12:20: the 09:30, 10:00, 11:00, and 12:00 ticks were missed.
    const after = botHost(storage, {
      clock: manualClock(0.5, Date.parse('2026-11-02T12:20:00.000Z')),
    })
    await after.start()
    for (let minute = 0; minute < 40; minute += 1) await after.nextMinute()

    await vi.waitFor(() =>
      expect(after.ticks()).toEqual([
        tick('30 9 * * *', '2026-11-02T09:30:00.000Z'),
        tick('0 * * * *', '2026-11-02T12:00:00.000Z'),
        tick('0 * * * *', '2026-11-02T13:00:00.000Z'),
      ]),
    )
  })

  it('fire a tick that fell before the first sync or while the bot was offline, once it is online', async () => {
    const storage = await inMemoryStorage()
    cleanup.push(() => storage.close())
    const host = botHost(storage)
    // Enabled at 08:58:30, before the host's first sync, as when that sync fails, or before
    // startup resumes the bot's session.
    await enableSchedules(storage, host.host, ['0 9 * * *'])
    host.setOnline(false)
    host.clock.advance(150_000)
    await host.start()
    await host.nextMinute()
    host.setOnline(true)
    await host.nextMinute()

    // Offline at 09:01 and 09:02, online at 09:03.
    await vi.waitFor(() =>
      expect(host.ticks()).toEqual([tick('0 9 * * *', '2026-11-02T09:00:00.000Z')]),
    )
  })

  it('run the revision another bot host enabled', async () => {
    const storage = await inMemoryStorage()
    cleanup.push(() => storage.close())
    const host = botHost(storage)
    await host.start()
    await enableSchedules(storage, host.host, ['0 9 * * *'])
    // Revision 2, published and enabled through a host that also believes it owns the bot.
    await storage.publishWorkflow({
      botId: BOT.id,
      name: 'digest',
      source: '',
      grants,
      events: ['schedule'],
      intents: 0,
      schedules: ['0 9 * * *'],
      actorId: HUMAN,
    })
    await storage.setEnabledRevision(BOT.id, 'digest', 2, HUMAN, new Date(host.clock.date()))
    await host.nextMinute()
    await host.nextMinute()

    await vi.waitFor(() =>
      expect(host.ticks()).toEqual([tick('0 9 * * *', '2026-11-02T09:00:00.000Z')]),
    )
  })

  it.each([
    ['a malformed cron', "schedules: ['0 9 * *']", 'has 4'],
    ['a cron under five minutes apart', "schedules: ['*/2 * * * *']", 'more often than every 5'],
    ['schedules nobody hears', "schedules: ['0 9 * * *']", 'nothing listens', 'messageCreate'],
    [
      'schedules one client declares and another hears',
      "schedules: ['0 9 * * *']",
      'nothing listens',
      'messageCreate',
      "new Client({ intents: [] }).on('schedule', () => {})",
    ],
    ['a schedules string', "schedules: '0 9 * * *'", 'must be an array'],
    [
      'schedules that together fire every minute',
      "schedules: ['*/5 * * * *', '1-59/5 * * * *', '2-59/5 * * * *', '3-59/5 * * * *', '4-59/5 * * * *']",
      'more often than every 5',
    ],
    [
      'one schedule twice, spaced differently',
      "schedules: ['*/5 * * * *', '*/5 * * * * ']",
      'more often than every 5',
    ],
    // Each takes a search for its next firing, every minute.
    [
      'more than ten schedules',
      "schedules: Array.from({ length: 11 }, (_, i) => '0 0 31 2 *' + ' '.repeat(i))",
      'more than 10',
    ],
  ])('refuse to publish %s', async (_case, options, error, event = 'schedule', other = '') => {
    const storage = await inMemoryStorage()
    cleanup.push(() => storage.close())
    const { host } = botHost(storage, { isolates: makeIsolateHost() })
    const source = `import { Client } from 'discord.js'
      const client = new Client({ intents: [], ${options} })
      client.on('${event}', () => {})
      ${other}`

    await expect(host.publish(caller, { name: 'digest', source, grants })).rejects.toMatchObject({
      message: expect.stringContaining(error),
    })
  })

  it.skipIf(database === undefined)(
    'fire on the one bot host that holds the bot’s lock, and move when it stops',
    async () => {
      if (database === undefined) return
      cleanup.push(database.drop)
      // Both hosts believe they own the bot, as when their BOT_HOSTS lists disagree.
      const storageA = await connectStorage(database.url, () => {})
      const storageB = await connectStorage(database.url, () => {})
      let stopped = false
      cleanup.push(
        () => storageB.close(),
        () => stopped || storageA.close(),
      )
      const a = botHost(storageA)
      const b = botHost(storageB)
      await a.start()
      await enableSchedules(storageA, a.host, ['*/5 * * * *'])
      // A's 08:59 sync takes the bot's lock.
      await a.nextMinute()
      await b.start()

      // B reaches 09:00 first, but A holds the bot's lock.
      for (let minute = 0; minute < 3; minute += 1) await b.nextMinute()
      for (let minute = 0; minute < 2; minute += 1) await a.nextMinute()
      await vi.waitFor(() =>
        expect(a.ticks()).toEqual([tick('*/5 * * * *', '2026-11-02T09:00:00.000Z')]),
      )
      // A stops; its session ends and Postgres releases its lock.
      await a.host.close()
      await storageA.close()
      stopped = true
      for (let minute = 0; minute < 5; minute += 1) await b.nextMinute()

      await vi.waitFor(() =>
        expect(b.ticks()).toEqual([tick('*/5 * * * *', '2026-11-02T09:05:00.000Z')]),
      )
      expect(a.ticks()).toHaveLength(1)
    },
  )
})
