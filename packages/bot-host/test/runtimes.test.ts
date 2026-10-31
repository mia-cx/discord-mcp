import type { Storage } from '@discord-mcp/storage'
import { inMemoryStorage } from '@discord-mcp/storage/testing'
import { expect, it, vi } from 'vitest'
import { shardOwner } from '../src/assign.ts'
import type { Clock } from '../src/clock.ts'
import {
  type BotRuntimesOptions,
  createBotRuntimes,
  DISCORD_API_URL,
  IDLE_TIMEOUT_MS,
  RECONCILE_MS,
} from '../src/runtimes.ts'
import { fakeGateway, manualClock } from '../src/testing.ts'
import { createTokenVault } from '../src/vault.ts'

/** `GUILDS` and `GUILD_VOICE_STATES`, which every bot identifies with for voice. */
const VOICE_INTENTS = 129
const BOT_ID = '345678901234567890'
const OTHER_BOT_ID = '456789012345678901'
const KEY = Buffer.alloc(32, 1)
const HOUR = 60 * 60 * 1000
/** Discord's five seconds between Identifies in a bucket, plus a second kept in hand. */
const TURN_MS = 6_000
const ACTOR_ID = '234567890123456789'

/** Enable a workflow declaring `intents` for the bot, as the workflow tools store it. */
const enableWorkflow = async (storage: Storage, name: string, intents: number) => {
  await storage.publishWorkflow({
    botId: BOT_ID,
    name,
    source: '',
    grants: { operations: [], families: [], hosts: [] },
    events: [],
    intents,
    actorId: ACTOR_ID,
  })
  await storage.setEnabledRevision(BOT_ID, name, 1, ACTOR_ID)
}

type Gateway = Awaited<ReturnType<typeof fakeGateway>>
const identifyShard = (gateway: Gateway) =>
  gateway.connections.map(
    (connection) =>
      (connection.received.find((p) => p.op === 2)?.d as { shard: number[] } | undefined)?.shard,
  )

/** Each Identify's shard as `id/count`, sorted, since shards connect concurrently. */
const identified = (gateway: Gateway) =>
  identifyShard(gateway)
    .filter((shard) => shard !== undefined)
    .map(([id, count]) => `${id}/${count}`)
    .sort()

/** The connection that identified as shard `shardId`. */
const shardConnection = (gateway: Gateway, shardId: number) =>
  gateway.connections[identifyShard(gateway).findIndex((shard) => shard?.[0] === shardId)]

/** The sequence number stored for each of the bot's shards. */
const storedSequences = async (storage: Storage) => {
  const [bot] = await createTokenVault(KEY, storage).loadOnline()
  return Object.fromEntries(
    [...(bot?.sessions ?? [])].map(([id, session]) => [id, session.sequence]),
  )
}

/**
 * A bot host named `self` on `storage`. Leases outlast the hours single-host tests jump, since
 * their lapses are proven in the multi-host tests.
 */
const startHost = (
  storage: Storage,
  clock: Clock,
  discordFetch: typeof fetch,
  options: Partial<BotRuntimesOptions> = {},
) =>
  createBotRuntimes({
    vault: createTokenVault(KEY, storage),
    storage,
    clock,
    log: () => {},
    self: 'host-a',
    discordFetch,
    leaseTtlMs: 100 * HOUR,
    ...options,
  })

/** Resolve once `count` bot hosts hold a live membership lease. */
const hostsLive = (storage: Storage, clock: Clock, count: number) =>
  vi.waitFor(async () =>
    expect(await storage.liveLeases('host:', clock.date())).toHaveLength(count),
  )

it('leaves a bot Discord rejected offline until its token changes', async () => {
  const storage = await inMemoryStorage()
  const gateway = await fakeGateway()
  const clock = manualClock()
  const bots = startHost(storage, clock, gateway.discordFetch())

  await bots.use(BOT_ID, 'private-token-a')
  await vi.waitFor(() => expect(gateway.connections[0]?.received[0]?.op).toBe(2))
  // Authentication failed: the token was reset.
  gateway.connections[0]?.close(4004)
  await vi.waitFor(() => expect(gateway.connections[0]?.closeCode).toBe(4004))

  await bots.use(BOT_ID, 'private-token-a')
  await new Promise((resolve) => setTimeout(resolve, 100))
  expect(gateway.connections).toHaveLength(1)

  await bots.use(BOT_ID, 'private-token-b')
  // It waits out the turn of the last Identify.
  clock.advance(TURN_MS)
  await vi.waitFor(() => expect(gateway.connections[1]?.received[0]).toMatchObject({ op: 2 }))

  await bots.close()
  await gateway.close()
  await storage.close()
})

it('keeps trying to take a rejected bot offline until storage answers', async () => {
  const storage = await inMemoryStorage()
  const gateway = await fakeGateway(100 * HOUR)
  const clock = manualClock()
  const setBotOffline = vi
    .fn(storage.setBotOffline)
    .mockRejectedValueOnce(new Error('Connection terminated unexpectedly'))
  const bots = startHost({ ...storage, setBotOffline }, clock, gateway.discordFetch())

  await bots.use(BOT_ID, 'private-token-a')
  await vi.waitFor(() => expect(gateway.connections[0]?.received[0]?.op).toBe(2))
  gateway.connections[0]?.close(4004)
  await vi.waitFor(() => expect(setBotOffline).toHaveBeenCalledTimes(1))
  clock.advance(RECONCILE_MS)
  await vi.waitFor(async () => expect((await storage.loadBot(BOT_ID))?.rejectedCode).toBe(4004))
  expect(gateway.connections).toHaveLength(1)

  await bots.close()
  await gateway.close()
  await storage.close()
})

it('resumes an online bot after a restart without asking Discord first', async () => {
  const storage = await inMemoryStorage()
  const gateway = await fakeGateway()
  const clock = manualClock()
  const before = startHost(storage, clock, gateway.discordFetch())

  await before.use(BOT_ID, 'private-token-a')
  await vi.waitFor(() => expect(gateway.connections[0]?.received[0]?.op).toBe(2))
  gateway.connections[0]?.send({ op: 0, t: 'MESSAGE_CREATE', s: 2, d: {} })
  await vi.waitFor(async () => expect(await storedSequences(storage)).toEqual({ 0: 2 }))
  await before.close()
  // Any close but 1000 or 1001 keeps the session resumable.
  await vi.waitFor(() => expect(gateway.connections[0]?.closeCode).toBe(4000))

  // The next process shares nothing with the last but the database and the vault key, and
  // Discord's REST API is down.
  const down = vi.fn(async () => new Response(null, { status: 503 }))
  const after = startHost(storage, clock, down)
  await vi.waitFor(() =>
    expect(gateway.connections[1]?.received[0]).toEqual({
      op: 6,
      d: { token: 'private-token-a', session_id: 'fake-session', seq: 2 },
    }),
  )
  // Discord replays what happened during the restart.
  gateway.connections[1]?.send({ op: 0, t: 'MESSAGE_CREATE', s: 3, d: {} })
  gateway.connections[1]?.send({ op: 0, t: 'RESUMED', s: 4, d: {} })
  await vi.waitFor(async () => expect(await storedSequences(storage)).toEqual({ 0: 4 }))
  expect(down).not.toHaveBeenCalled()

  await after.close()
  await gateway.close()
  await storage.close()
})

it('brings back a bot whose session Discord invalidated just before a restart', async () => {
  const storage = await inMemoryStorage()
  const gateway = await fakeGateway()
  const clock = manualClock()
  const before = startHost(storage, clock, gateway.discordFetch())

  await before.use(BOT_ID, 'private-token-a')
  await vi.waitFor(async () => expect(await storedSequences(storage)).toEqual({ 0: 1 }))
  // The restart lands while the shard waits to identify afresh.
  gateway.connections[0]?.send({ op: 9, d: false })
  await vi.waitFor(() => expect(gateway.connections[0]?.closeCode).toBe(4000))
  await before.close()

  const after = startHost(storage, clock, gateway.discordFetch())
  // It resumes the stale session; Discord's answer to that is proven in the shard suite.
  await vi.waitFor(() => expect(gateway.connections[1]?.received[0]?.op).toBe(6))

  await after.close()
  await gateway.close()
  await storage.close()
})

it('retries a failed session store, so an online bot still resumes after a restart', async () => {
  const storage = await inMemoryStorage()
  const gateway = await fakeGateway(100 * HOUR)
  const clock = manualClock()
  const vault = createTokenVault(KEY, storage)
  const storeSession = vi
    .fn(vault.storeSession)
    .mockRejectedValueOnce(new Error('Connection terminated unexpectedly'))
  const bots = startHost(storage, clock, gateway.discordFetch(), {
    vault: { ...vault, storeSession },
  })

  // READY is the only dispatch, and storing it fails.
  await bots.use(BOT_ID, 'private-token-a')
  await vi.waitFor(() => expect(storeSession).toHaveBeenCalledTimes(1))
  expect(await storedSequences(storage)).toEqual({})

  clock.advance(60_000)
  await vi.waitFor(async () => expect(await storedSequences(storage)).toEqual({ 0: 1 }))

  await bots.close()
  await gateway.close()
  await storage.close()
})

it('runs every shard Discord recommends, one Identify per concurrency bucket at a time', async () => {
  const storage = await inMemoryStorage()
  const gateway = await fakeGateway(100 * HOUR)
  const clock = manualClock()
  const onDispatch = vi.fn()
  const bots = startHost(storage, clock, gateway.discordFetch({ shards: 4, maxConcurrency: 2 }), {
    onDispatch,
  })

  await bots.use(BOT_ID, 'private-token-a')
  await vi.waitFor(() => expect(gateway.connections).toHaveLength(4))
  // Buckets are shard ID mod 2. Each lets one shard identify, and the other waits a turn.
  await vi.waitFor(() => expect(identified(gateway)).toHaveLength(2))
  await new Promise((resolve) => setTimeout(resolve, 100))
  const buckets = identified(gateway).map((shard) => Number(shard.split('/')[0]) % 2)
  expect(buckets.sort()).toEqual([0, 1])
  clock.advance(TURN_MS)
  await vi.waitFor(() => expect(identified(gateway)).toEqual(['0/4', '1/4', '2/4', '3/4']))

  // Each shard's guilds send their own events, and all of them reach the bot's runtime.
  for (const shardId of [0, 1, 2, 3]) {
    shardConnection(gateway, shardId)?.send({ op: 0, t: 'MESSAGE_CREATE', s: 2, d: { shardId } })
  }
  await vi.waitFor(() => {
    for (const shardId of [0, 1, 2, 3]) {
      expect(onDispatch).toHaveBeenCalledWith(BOT_ID, 'MESSAGE_CREATE', { shardId })
    }
  })

  await bots.close()
  await gateway.close()
  await storage.close()
})

it('identifies no more shards than half the Identifies Discord says remain', async () => {
  const storage = await inMemoryStorage()
  const gateway = await fakeGateway(100 * HOUR)
  const clock = manualClock()
  const bots = startHost(
    storage,
    clock,
    gateway.discordFetch({ shards: 4, maxConcurrency: 4, remaining: 4 }),
  )

  await bots.use(BOT_ID, 'private-token-a')
  await vi.waitFor(() => expect(identified(gateway)).toHaveLength(2))
  clock.advance(HOUR)
  await new Promise((resolve) => setTimeout(resolve, 100))
  expect(identified(gateway)).toHaveLength(2)

  await bots.close()
  await gateway.close()
  await storage.close()
})

it('reconnects a dropped shard on its own, resuming its session', async () => {
  const storage = await inMemoryStorage()
  const gateway = await fakeGateway(100 * HOUR)
  const clock = manualClock()
  const bots = startHost(storage, clock, gateway.discordFetch({ shards: 2, maxConcurrency: 2 }))

  await bots.use(BOT_ID, 'private-token-a')
  await vi.waitFor(() => expect(identified(gateway)).toEqual(['0/2', '1/2']))
  const dropped = shardConnection(gateway, 1)
  dropped?.send({ op: 0, t: 'MESSAGE_CREATE', s: 5, d: {} })
  await vi.waitFor(async () => expect(await storedSequences(storage)).toEqual({ 0: 1, 1: 5 }))

  dropped?.close(4000)
  await vi.waitFor(() => expect(dropped?.closeCode).toBe(4000))
  clock.advance(500)
  await vi.waitFor(() =>
    expect(gateway.connections[2]?.received[0]).toMatchObject({ op: 6, d: { seq: 5 } }),
  )
  expect(shardConnection(gateway, 0)?.closeCode).toBeUndefined()
  expect(identified(gateway)).toEqual(['0/2', '1/2'])

  await bots.close()
  await gateway.close()
  await storage.close()
})

it('resumes a multi-shard bot with its stored shard count, before Discord says its limits', async () => {
  const storage = await inMemoryStorage()
  const gateway = await fakeGateway(100 * HOUR)
  const clock = manualClock()
  const before = startHost(storage, clock, gateway.discordFetch({ shards: 2, maxConcurrency: 2 }))

  await before.use(BOT_ID, 'private-token-a')
  await vi.waitFor(async () => expect(await storedSequences(storage)).toEqual({ 0: 1, 1: 1 }))
  await before.close()
  // Shard 1's session is gone, so it identifies afresh.
  const lease = `shard:${BOT_ID}:1`
  await storage.claimLease(lease, 'test', clock.date(), 1)
  await createTokenVault(KEY, storage).clearSession(BOT_ID, 1, { lease, holder: 'test' })
  await storage.releaseLease(lease, 'test')

  // The bot grew meanwhile, and Discord's REST API answers only after a minute.
  const discordFetch = vi
    .fn(gateway.discordFetch({ shards: 3 }))
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
  const after = startHost(storage, clock, discordFetch)
  await vi.waitFor(() => expect(gateway.connections[2]?.received[0]?.op).toBe(6))
  await new Promise((resolve) => setTimeout(resolve, 100))
  expect(identified(gateway)).toEqual(['0/2', '1/2'])

  clock.advance(60_000)
  await vi.waitFor(() => expect(identified(gateway)).toEqual(['0/2', '1/2', '1/2']))
  expect(gateway.connections).toHaveLength(4)

  await after.close()
  await gateway.close()
  await storage.close()
})

it('brings a bot that outgrew its shards back with Discord’s new count on the next call', async () => {
  const storage = await inMemoryStorage()
  const gateway = await fakeGateway(100 * HOUR)
  const clock = manualClock()
  let shards = 1
  const bots = startHost(storage, clock, (input, init) =>
    gateway.discordFetch({ shards, maxConcurrency: 2 })(input, init),
  )

  await bots.use(BOT_ID, 'private-token-a')
  await vi.waitFor(() => expect(identified(gateway)).toEqual(['0/1']))
  shards = 2
  // Sharding required: the bot is in too many guilds for one shard.
  gateway.connections[0]?.close(4011)
  await vi.waitFor(() => expect(gateway.connections[0]?.closeCode).toBe(4011))

  await bots.use(BOT_ID, 'private-token-a')
  // Shard 0 waits out the turn of the last Identify in its bucket.
  await vi.waitFor(() => expect(identified(gateway)).toEqual(['0/1', '1/2']))
  clock.advance(TURN_MS)
  await vi.waitFor(() => expect(identified(gateway)).toEqual(['0/1', '0/2', '1/2']))

  await bots.close()
  await gateway.close()
  await storage.close()
})

it('keeps asking Discord how to shard a bot until it answers', async () => {
  const storage = await inMemoryStorage()
  const gateway = await fakeGateway(100 * HOUR)
  const clock = manualClock()
  const discordFetch = vi
    .fn(gateway.discordFetch())
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
  const bots = startHost(storage, clock, discordFetch)

  await bots.use(BOT_ID, 'private-token-a')
  await vi.waitFor(() => expect(discordFetch).toHaveBeenCalledTimes(1))
  await new Promise((resolve) => setTimeout(resolve, 100))
  expect(gateway.connections).toHaveLength(0)

  clock.advance(60_000)
  await vi.waitFor(() => expect(identified(gateway)).toEqual(['0/1']))

  await bots.close()
  await gateway.close()
  await storage.close()
})

it("spreads a bot's shards across hosts, and a leaving host's shards resume on the others", async () => {
  const storage = await inMemoryStorage()
  const gateway = await fakeGateway(100 * HOUR)
  const clock = manualClock()
  const discordFetch = gateway.discordFetch({ shards: 8, maxConcurrency: 8 })
  const heard: Array<{ host: string; shardId: unknown }> = []
  const hosts = ['host-a', 'host-b', 'host-c'].map((self) =>
    startHost(storage, clock, discordFetch, {
      self,
      onDispatch: (_, event, data) => {
        if (event === 'MESSAGE_CREATE')
          heard.push({ host: self, ...(data as { shardId: unknown }) })
      },
    }),
  )
  await hostsLive(storage, clock, 3)

  await hosts[0]?.use(BOT_ID, 'private-token-a')
  clock.advance(RECONCILE_MS)
  await vi.waitFor(() => expect(identified(gateway)).toHaveLength(8))
  expect(identified(gateway)).toEqual(['0/8', '1/8', '2/8', '3/8', '4/8', '5/8', '6/8', '7/8'])
  for (let shardId = 0; shardId < 8; shardId += 1) {
    shardConnection(gateway, shardId)?.send({
      op: 0,
      t: 'MESSAGE_CREATE',
      s: 10 + shardId,
      d: { shardId },
    })
  }
  // Each shard runs on exactly one host, and the bot runs on more than one.
  await vi.waitFor(() => expect(heard).toHaveLength(8))
  expect(new Set(heard.map(({ shardId }) => shardId)).size).toBe(8)
  const ran = new Map(heard.map(({ host, shardId }) => [shardId, host]))
  expect(new Set(ran.values()).size).toBeGreaterThan(1)
  await vi.waitFor(async () =>
    expect(Object.values(await storedSequences(storage))).toEqual([10, 11, 12, 13, 14, 15, 16, 17]),
  )

  // Host b leaves. Its shards resume elsewhere from their stored sessions; no shard identifies.
  const leaving = [...ran].filter(([, host]) => host === 'host-b').map(([shardId]) => shardId)
  expect(leaving.length).toBeGreaterThan(0)
  await hosts[1]?.close()
  clock.advance(RECONCILE_MS)
  await vi.waitFor(() => expect(gateway.connections).toHaveLength(8 + leaving.length))
  const resumed = gateway.connections.slice(8)
  await vi.waitFor(() =>
    expect(resumed.map((c) => c.received[0]?.op)).toEqual(leaving.map(() => 6)),
  )
  expect(
    resumed.map((c) => (c.received[0]?.d as { seq?: number } | undefined)?.seq).sort(),
  ).toEqual(leaving.map((shardId) => 10 + Number(shardId)).sort())
  expect(identified(gateway)).toHaveLength(8)

  for (const host of hosts) await host?.close()
  await gateway.close()
  await storage.close()
})

it('moves shards to a joining host, stopping each on its old host before it resumes', async () => {
  const storage = await inMemoryStorage()
  const gateway = await fakeGateway(100 * HOUR)
  const clock = manualClock()
  const discordFetch = gateway.discordFetch({ shards: 4, maxConcurrency: 4 })
  const first = startHost(storage, clock, discordFetch, { self: 'host-a' })
  await hostsLive(storage, clock, 1)
  await first.use(BOT_ID, 'private-token-a')
  await vi.waitFor(() => expect(identified(gateway)).toHaveLength(4))

  const joining = startHost(storage, clock, discordFetch, { self: 'host-b' })
  await hostsLive(storage, clock, 2)
  const moving = [0, 1, 2, 3].filter(
    (id) => shardOwner(['host-a', 'host-b'], BOT_ID, id) === 'host-b',
  )
  expect(moving.length).toBeGreaterThan(0)
  const old = moving.map((shardId) => shardConnection(gateway, shardId))
  // Host a hands them over on its next pass, and host b resumes them by its pass after that.
  clock.advance(RECONCILE_MS)
  await vi.waitFor(() => expect(old.map((c) => c?.closeCode)).toEqual(moving.map(() => 4000)))
  clock.advance(RECONCILE_MS)
  await vi.waitFor(() => expect(gateway.connections).toHaveLength(4 + moving.length))
  await vi.waitFor(() =>
    expect(gateway.connections.slice(4).map((c) => c.received[0]?.op)).toEqual(moving.map(() => 6)),
  )
  expect(identified(gateway)).toHaveLength(4)

  await first.close()
  await joining.close()
  await gateway.close()
  await storage.close()
})

it('stops the shards of a host that cannot renew its leases before another host takes them', async () => {
  const storage = await inMemoryStorage()
  const gateway = await fakeGateway(100 * HOUR)
  const clock = manualClock()
  const discordFetch = gateway.discordFetch({ shards: 4, maxConcurrency: 4 })
  let reachable = true
  const unreliable: Storage = {
    ...storage,
    renewLeases: (...args) =>
      reachable ? storage.renewLeases(...args) : Promise.reject(new Error('Connection refused')),
  }
  const log = vi.fn()
  const hosts = [
    createBotRuntimes({
      vault: createTokenVault(KEY, unreliable),
      storage: unreliable,
      clock,
      log,
      self: 'host-a',
      discordFetch,
    }),
    createBotRuntimes({
      vault: createTokenVault(KEY, storage),
      storage,
      clock,
      log: () => {},
      self: 'host-b',
      discordFetch,
    }),
  ]
  await hostsLive(storage, clock, 2)
  await hosts[0]?.use(BOT_ID, 'private-token-a')
  clock.advance(RECONCILE_MS)
  await vi.waitFor(() => expect(identified(gateway)).toHaveLength(4))
  const stranded = [0, 1, 2, 3].filter(
    (id) => shardOwner(['host-a', 'host-b'], BOT_ID, id) === 'host-a',
  )

  expect(stranded.length).toBeGreaterThan(0)

  // Host a loses Postgres. It stops relying on its leases five seconds before they expire.
  reachable = false
  clock.advance(RECONCILE_MS)
  await new Promise((resolve) => setTimeout(resolve, 100))
  clock.advance(RECONCILE_MS)
  await vi.waitFor(() =>
    expect(stranded.map((id) => shardConnection(gateway, id)?.closeCode)).toEqual(
      stranded.map(() => 4000),
    ),
  )
  expect(log).toHaveBeenCalledWith(expect.stringContaining('could not renew its lease in time'))
  expect(gateway.connections).toHaveLength(4)

  // Only once they expire does host b take the shards, resuming each.
  clock.advance(RECONCILE_MS)
  await vi.waitFor(() => expect(gateway.connections).toHaveLength(4 + stranded.length))
  await vi.waitFor(() =>
    expect(gateway.connections.slice(4).map((c) => c.received[0]?.op)).toEqual(
      stranded.map(() => 6),
    ),
  )

  reachable = true
  for (const host of hosts) await host.close()
  await gateway.close()
  await storage.close()
})

it("serves a bot's REST traffic from one process at a time", async () => {
  const storage = await inMemoryStorage()
  const gateway = await fakeGateway()
  const clock = manualClock()
  const before = startHost(storage, clock, gateway.discordFetch(), { self: 'host-a' })
  // A host still on the old list, and one on the new list that also thinks it owns the bot.
  const after = startHost(storage, clock, gateway.discordFetch(), { self: 'host-b' })

  expect(await before.own(BOT_ID)).toBe(true)
  expect(await after.own(BOT_ID)).toBe(false)
  await before.close()
  expect(await after.own(BOT_ID)).toBe(true)

  await after.close()
  await gateway.close()
  await storage.close()
})

it('paces Identifies in one concurrency bucket across hosts, and splits the budget', async () => {
  const storage = await inMemoryStorage()
  const gateway = await fakeGateway(100 * HOUR)
  const clock = manualClock()
  // Two hosts that each take their share leave half of the 8 Identifies remaining: 4 in all.
  const discordFetch = gateway.discordFetch({ shards: 8, maxConcurrency: 1, remaining: 8 })
  const hosts = ['host-a', 'host-b'].map((self) =>
    startHost(storage, clock, discordFetch, { self, hostCount: 2 }),
  )
  await hostsLive(storage, clock, 2)
  const owners = [0, 1, 2, 3, 4, 5, 6, 7].map((id) => shardOwner(['host-a', 'host-b'], BOT_ID, id))
  expect(owners.filter((host) => host === 'host-a').length).toBeGreaterThanOrEqual(2)
  expect(owners.filter((host) => host === 'host-b').length).toBeGreaterThanOrEqual(2)

  await hosts[0]?.use(BOT_ID, 'private-token-a')
  // One Identify a turn, whichever host sends it.
  for (const count of [1, 2, 3, 4]) {
    await vi.waitFor(() => expect(identified(gateway)).toHaveLength(count))
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(identified(gateway)).toHaveLength(count)
    clock.advance(TURN_MS)
  }
  clock.advance(HOUR)
  await new Promise((resolve) => setTimeout(resolve, 100))
  expect(identified(gateway)).toHaveLength(4)

  for (const host of hosts) await host?.close()
  await gateway.close()
  await storage.close()
})

it('keeps a bot with enabled workflows online from its stored token until they are disabled', async () => {
  const storage = await inMemoryStorage()
  // Heartbeats are proven in the shard suite; keep them out of this window.
  const gateway = await fakeGateway(1000 * HOUR)
  const clock = manualClock()
  // Stored by an earlier agent call, before a restart.
  await createTokenVault(KEY, storage).store(BOT_ID, 'private-token-a')
  const bots = startHost(storage, clock, gateway.discordFetch(), { leaseTtlMs: 1000 * HOUR })

  // Startup holds bots with enabled workflows.
  await enableWorkflow(storage, 'replies', 512)
  await bots.hold(BOT_ID, 512)
  await vi.waitFor(() =>
    expect(gateway.connections[0]?.received[0]).toMatchObject({
      op: 2,
      d: { token: 'private-token-a', intents: 512 | VOICE_INTENTS },
    }),
  )
  clock.advance(2 * IDLE_TIMEOUT_MS)
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(gateway.connections[0]?.closeCode).toBeUndefined()

  // Nothing needs Message events any more, so the bot stops receiving them.
  await storage.setEnabledRevision(BOT_ID, 'replies', null, ACTOR_ID)
  await bots.hold(BOT_ID, undefined)
  clock.advance(TURN_MS)
  await vi.waitFor(() =>
    expect(gateway.connections[1]?.received[0]).toMatchObject({
      op: 2,
      d: { intents: VOICE_INTENTS },
    }),
  )
  clock.advance(IDLE_TIMEOUT_MS - HOUR)
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(gateway.connections[1]?.closeCode).toBeUndefined()
  clock.advance(HOUR)
  await vi.waitFor(() => expect(gateway.connections[1]?.closeCode).toBe(1000))

  await bots.close()
  await gateway.close()
  await storage.close()
})

it("tries again once its workflows change after Discord refused a bot's intents", async () => {
  const storage = await inMemoryStorage()
  const gateway = await fakeGateway(1000 * HOUR)
  const clock = manualClock()
  await createTokenVault(KEY, storage).store(BOT_ID, 'private-token-a')
  const bots = startHost(storage, clock, gateway.discordFetch())
  await enableWorkflow(storage, 'content', 1 << 15)
  await bots.hold(BOT_ID, 1 << 15)
  await vi.waitFor(() => expect(gateway.connections[0]?.received[0]?.op).toBe(2))

  // Message Content is off in the Developer Portal.
  gateway.connections[0]?.close(4014)
  await vi.waitFor(async () => expect((await storage.loadBot(BOT_ID))?.rejectedCode).toBe(4014))
  // An agent call alone doesn't bring it back with the same intents.
  await bots.use(BOT_ID, 'private-token-a')
  // The workflow that needed it was disabled, and one needing less enabled.
  await storage.setEnabledRevision(BOT_ID, 'content', null, ACTOR_ID)
  await enableWorkflow(storage, 'guilds', 1)
  await bots.hold(BOT_ID, 1)
  // It waits out the turn of the last Identify.
  clock.advance(TURN_MS)

  await vi.waitFor(() =>
    expect(gateway.connections[1]?.received[0]).toMatchObject({
      op: 2,
      d: { intents: 1 | VOICE_INTENTS },
    }),
  )
  expect(gateway.connections).toHaveLength(2)
  await bots.close()
  await gateway.close()
  await storage.close()
})

it('sets a presence on every shard of the bot, on every host', async () => {
  const storage = await inMemoryStorage()
  const gateway = await fakeGateway(1000 * HOUR)
  const clock = manualClock()
  const discordFetch = gateway.discordFetch({ shards: 4, maxConcurrency: 4 })
  const hosts = ['host-a', 'host-b'].map((self) =>
    startHost(storage, clock, discordFetch, { self }),
  )
  await hostsLive(storage, clock, 2)
  await hosts[0]?.use(BOT_ID, 'private-token-a')
  clock.advance(RECONCILE_MS)
  await vi.waitFor(() => expect(identified(gateway)).toEqual(['0/4', '1/4', '2/4', '3/4']))

  const idle = { since: null, activities: [], status: 'idle', afk: false }
  await hosts[0]?.updatePresence(BOT_ID, idle)
  // Host b's shards take it up on its next pass.
  clock.advance(RECONCILE_MS)
  for (const shardId of [0, 1, 2, 3]) {
    await vi.waitFor(() =>
      expect(shardConnection(gateway, shardId)?.received).toContainEqual({ op: 3, d: idle }),
    )
  }
  for (const host of hosts) await host?.close()
  await gateway.close()
  await storage.close()
})

it('holds a presence for a shard still waiting to identify, which Discord would close over it', async () => {
  const storage = await inMemoryStorage()
  const gateway = await fakeGateway(1000 * HOUR)
  const clock = manualClock()
  // One Identify a turn: the second shard waits, connected, for its own.
  const bots = startHost(storage, clock, gateway.discordFetch({ shards: 2, maxConcurrency: 1 }))
  await bots.use(BOT_ID, 'private-token-a')
  await vi.waitFor(() => expect(gateway.connections).toHaveLength(2))
  await vi.waitFor(() => expect(identified(gateway)).toHaveLength(1))
  const waiting = gateway.connections.find((c) => !c.received.some((p) => p.op === 2))

  const idle = { since: null, activities: [], status: 'idle', afk: false }
  await bots.updatePresence(BOT_ID, idle)
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(waiting?.received.map((p) => p.op)).not.toContain(3)

  clock.advance(TURN_MS)
  await vi.waitFor(() =>
    expect(waiting?.received.find((p) => p.op === 2)).toMatchObject({ d: { presence: idle } }),
  )
  await bots.close()
  await gateway.close()
  await storage.close()
})

it('skips an Identify turn whose claim answered too late to keep it', async () => {
  const storage = await inMemoryStorage()
  const gateway = await fakeGateway(1000 * HOUR)
  const clock = manualClock()
  let slow = true
  const bots = startHost(
    {
      ...storage,
      // Postgres takes two seconds to grant the first turn, which ends four seconds later.
      claimLease: async (name, ...rest) => {
        if (name.startsWith('identify:') && slow) {
          slow = false
          clock.stall(2_000)
        }
        return storage.claimLease(name, ...rest)
      },
    },
    clock,
    gateway.discordFetch(),
  )

  await bots.use(BOT_ID, 'private-token-a')
  await vi.waitFor(() => expect(gateway.connections).toHaveLength(1))
  await new Promise((resolve) => setTimeout(resolve, 100))
  expect(identified(gateway)).toEqual([])
  // The skipped turn ends six seconds after it was claimed, and the next is taken at once.
  clock.advance(TURN_MS - 2_000)
  await vi.waitFor(() => expect(identified(gateway)).toEqual(['0/1']))

  await bots.close()
  await gateway.close()
  await storage.close()
})

it('keeps a replacement token online when an old shard reports the old one rejected', async () => {
  const storage = await inMemoryStorage()
  const gateway = await fakeGateway(1000 * HOUR)
  const clock = manualClock()
  const bots = startHost(storage, clock, gateway.discordFetch())
  await bots.use(BOT_ID, 'private-token-a')
  await vi.waitFor(() => expect(identified(gateway)).toEqual(['0/1']))

  // The token was reset and the new one stored before the old shard hears it is gone.
  await createTokenVault(KEY, storage).store(BOT_ID, 'private-token-b')
  gateway.connections[0]?.close(4004)
  await vi.waitFor(() => expect(gateway.connections[0]?.closeCode).toBe(4004))
  await new Promise((resolve) => setTimeout(resolve, 100))

  expect((await storage.loadBot(BOT_ID))?.rejectedCode).toBeNull()
  await bots.close()
  await gateway.close()
  await storage.close()
})

it('identifies afresh instead of resuming a session identified with other intents', async () => {
  const storage = await inMemoryStorage()
  const gateway = await fakeGateway(1000 * HOUR)
  const clock = manualClock()
  const before = startHost(storage, clock, gateway.discordFetch())
  await before.use(BOT_ID, 'private-token-a')
  await vi.waitFor(async () => expect(await storedSequences(storage)).toEqual({ 0: 1 }))
  // Its host dies right after a workflow needing more intents is enabled.
  await before.close()
  await enableWorkflow(storage, 'replies', 512)

  const after = startHost(storage, clock, gateway.discordFetch())
  clock.advance(TURN_MS)
  await vi.waitFor(() =>
    expect(gateway.connections[1]?.received[0]).toMatchObject({
      op: 2,
      d: { intents: 512 | VOICE_INTENTS },
    }),
  )
  await after.close()
  await gateway.close()
  await storage.close()
})

it('lets a bot go idle once its last workflow is disabled, even if no host released it', async () => {
  const storage = await inMemoryStorage()
  const gateway = await fakeGateway(1000 * HOUR)
  const clock = manualClock()
  const bots = startHost(storage, clock, gateway.discordFetch(), { leaseTtlMs: 1000 * HOUR })
  await bots.use(BOT_ID, 'private-token-a')
  await enableWorkflow(storage, 'replies', 0)
  await vi.waitFor(() => expect(identified(gateway)).toEqual(['0/1']))

  // The owner died between disabling the workflow and releasing the bot.
  await storage.setEnabledRevision(BOT_ID, 'replies', null, ACTOR_ID)
  clock.advance(IDLE_TIMEOUT_MS)
  await vi.waitFor(() => expect(gateway.connections[0]?.closeCode).toBe(1000))

  await bots.close()
  await gateway.close()
  await storage.close()
})

it('keeps renewing its leases while Discord takes its time over a new token', async () => {
  const storage = await inMemoryStorage()
  const gateway = await fakeGateway(1000 * HOUR)
  const clock = manualClock()
  let hang = false
  // Discord's answer for the new token never comes.
  const discordFetch: typeof fetch = (input, init) =>
    hang ? new Promise(() => {}) : gateway.discordFetch()(input, init)
  const bots = startHost(storage, clock, discordFetch, { leaseTtlMs: undefined })
  await bots.use(BOT_ID, 'private-token-a')
  await vi.waitFor(() => expect(identified(gateway)).toEqual(['0/1']))

  hang = true
  void bots.use(BOT_ID, 'private-token-b')
  // The old token's shard ends on the next pass, which must not wait for Discord.
  for (let pass = 0; pass < 6; pass += 1) {
    clock.advance(RECONCILE_MS)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  expect(gateway.connections[0]?.closeCode).toBe(1000)
  expect(await storage.liveLeases('host:', clock.date())).toEqual(['host:host-a'])

  await bots.close()
  await gateway.close()
  await storage.close()
})

it('keeps the REST lease of a bot its list gives it, once the previous holder lets go', async () => {
  const storage = await inMemoryStorage()
  const gateway = await fakeGateway(1000 * HOUR)
  const clock = manualClock()
  const before = startHost(storage, clock, gateway.discordFetch(), { self: 'host-a' })
  // Host b's list makes it the owner, but host a still serves the bot.
  const after = startHost(storage, clock, gateway.discordFetch(), { self: 'host-b' })
  expect(await before.own(BOT_ID)).toBe(true)
  await before.use(BOT_ID, 'private-token-a')
  clock.advance(RECONCILE_MS)
  await new Promise((resolve) => setTimeout(resolve, 100))
  expect(after.serves(BOT_ID)).toBe(false)

  // No agent call needed: host b's next pass takes the bot, so its schedules can run there.
  await before.close()
  clock.advance(RECONCILE_MS)
  await vi.waitFor(() => expect(after.serves(BOT_ID)).toBe(true))

  await after.close()
  await gateway.close()
  await storage.close()
})

it('leaves the next host’s sessions alone when Discord answers after this host closed', async () => {
  const storage = await inMemoryStorage()
  const gateway = await fakeGateway(1000 * HOUR)
  const clock = manualClock()
  let answer = (_: Response) => {}
  const late: typeof fetch = () =>
    new Promise((resolve) => {
      answer = resolve
    })
  const before = startHost(storage, clock, late, { self: 'host-a' })
  void before.use(BOT_ID, 'private-token-a')
  await vi.waitFor(async () => expect(await storage.loadBot(BOT_ID)).toBeDefined())
  await before.close()

  // The next host brings the bot online, and its shard saves a session.
  const after = startHost(storage, clock, gateway.discordFetch(), { self: 'host-b' })
  await after.use(BOT_ID, 'private-token-a')
  await vi.waitFor(async () => expect(await storedSequences(storage)).toEqual({ 0: 1 }))

  answer(await gateway.discordFetch()(`${DISCORD_API_URL}/gateway/bot`))
  await new Promise((resolve) => setTimeout(resolve, 100))
  expect(await storedSequences(storage)).toEqual({ 0: 1 })

  await after.close()
  await gateway.close()
  await storage.close()
})

it('names the token its shards start with, even one stored during the pass', async () => {
  const storage = await inMemoryStorage()
  const gateway = await fakeGateway(1000 * HOUR)
  const clock = manualClock()
  const vault = createTokenVault(KEY, storage)
  const online = (token: string) =>
    vault.setOnline(BOT_ID, token, { shardCount: 1, gatewayUrl: gateway.url, until: HOUR })
  await vault.store(BOT_ID, 'private-token-a')
  await online('private-token-a')
  // Another host resets the token, and brings the bot back, while this host's pass is under way.
  let reset = true
  const racing: Storage = {
    ...storage,
    loadOnlineBots: async () => {
      const bots = await storage.loadOnlineBots()
      if (reset) {
        reset = false
        await vault.store(BOT_ID, 'private-token-b')
        await online('private-token-b')
      }
      return bots
    },
  }
  const bots = startHost(racing, clock, gateway.discordFetch())

  await vi.waitFor(() =>
    expect(gateway.connections[0]?.received[0]).toMatchObject({
      op: 2,
      d: { token: 'private-token-b' },
    }),
  )
  expect(bots.tokenOf(BOT_ID)).toBe('private-token-b')

  await bots.close()
  await gateway.close()
  await storage.close()
})

it('takes a bot offline once for a shard Discord closed, even if that pass fails', async () => {
  const storage = await inMemoryStorage()
  const gateway = await fakeGateway(100 * HOUR)
  const clock = manualClock()
  let shards = 1
  let failRead = false
  const flaky: Storage = {
    ...storage,
    loadOnlineBots: () => {
      if (!failRead) return storage.loadOnlineBots()
      failRead = false
      return Promise.reject(new Error('Connection terminated unexpectedly'))
    },
  }
  const bots = startHost(flaky, clock, (input, init) =>
    gateway.discordFetch({ shards, maxConcurrency: 2 })(input, init),
  )
  await bots.use(BOT_ID, 'private-token-a')
  await vi.waitFor(() => expect(identified(gateway)).toEqual(['0/1']))

  // Sharding required; the pass that takes the bot offline fails after doing so.
  shards = 2
  failRead = true
  gateway.connections[0]?.close(4011)
  await vi.waitFor(() => expect(failRead).toBe(false))
  await bots.use(BOT_ID, 'private-token-a')
  clock.advance(RECONCILE_MS)

  await vi.waitFor(() => expect(identified(gateway)).toEqual(['0/1', '1/2']))
  expect((await storage.loadBot(BOT_ID))?.online).toMatchObject({ shardCount: 2 })

  await bots.close()
  await gateway.close()
  await storage.close()
})

it('starts a bot’s shards while another bot’s session write is slow', async () => {
  const storage = await inMemoryStorage()
  const gateway = await fakeGateway(100 * HOUR)
  const clock = manualClock()
  const vault = createTokenVault(KEY, storage)
  let slow: Promise<void> | undefined
  let waiting = 0
  const bots = startHost(storage, clock, gateway.discordFetch(), {
    vault: {
      ...vault,
      storeSession: async (botId, ...rest) => {
        if (botId === BOT_ID && slow !== undefined) {
          waiting += 1
          await slow
        }
        return vault.storeSession(botId, ...rest)
      },
    },
  })
  await bots.use(BOT_ID, 'private-token-a')
  await vi.waitFor(async () => expect(await storedSequences(storage)).toEqual({ 0: 1 }))
  let answer = () => {}
  slow = new Promise((resolve) => {
    answer = resolve
  })
  gateway.connections[0]?.send({ op: 0, t: 'MESSAGE_CREATE', s: 2, d: {} })
  await vi.waitFor(() => expect(waiting).toBe(1))

  await bots.use(OTHER_BOT_ID, 'private-token-other')
  await vi.waitFor(() =>
    expect(gateway.connections[1]?.received[0]).toMatchObject({
      op: 2,
      d: { token: 'private-token-other' },
    }),
  )

  answer()
  await bots.close()
  await gateway.close()
  await storage.close()
})

it('takes a bot offline once for all the shards Discord closed, even if that pass fails', async () => {
  const storage = await inMemoryStorage()
  const gateway = await fakeGateway(100 * HOUR)
  const clock = manualClock()
  let shards = 2
  /** Holds the next pass at its first storage call until `resume`. */
  let paused: Promise<void> | undefined
  let resume = () => {}
  const pause = () => {
    paused = new Promise((resolve) => {
      resume = () => {
        paused = undefined
        resolve()
      }
    })
  }
  let offlineCalls = 0
  const flaky: Storage = {
    ...storage,
    renewLeases: async (...args) => {
      await paused
      return storage.renewLeases(...args)
    },
    setBotOffline: (...args) => {
      offlineCalls += 1
      if (offlineCalls !== 2) return storage.setBotOffline(...args)
      // Postgres drops the connection after the first write, and the next pass waits on it.
      pause()
      return Promise.reject(new Error('Connection terminated unexpectedly'))
    },
  }
  const bots = startHost(flaky, clock, (input, init) =>
    gateway.discordFetch({ shards, maxConcurrency: 2 })(input, init),
  )
  await bots.use(BOT_ID, 'private-token-a')
  await vi.waitFor(() => expect(identified(gateway)).toEqual(['0/2', '1/2']))

  // Sharding required, on both shards, before the next pass.
  pause()
  shards = 4
  for (const connection of gateway.connections) connection.close(4011)
  await vi.waitFor(() => expect(gateway.connections.map((c) => c.closeCode)).toEqual([4011, 4011]))
  // The bot host hears both closes.
  await new Promise((resolve) => setTimeout(resolve, 100))
  resume()
  clock.advance(RECONCILE_MS)
  await vi.waitFor(async () => expect((await storage.loadBot(BOT_ID))?.online).toBeUndefined())
  await new Promise((resolve) => setTimeout(resolve, 100))

  // An agent call brings the bot back with Discord's new count before the next pass.
  const using = bots.use(BOT_ID, 'private-token-a')
  await vi.waitFor(async () =>
    expect((await storage.loadBot(BOT_ID))?.online).toMatchObject({ shardCount: 4 }),
  )
  resume()
  await using

  await vi.waitFor(() => {
    clock.advance(1_000)
    expect(identified(gateway)).toContain('0/4')
  })
  expect((await storage.loadBot(BOT_ID))?.online).toMatchObject({ shardCount: 4 })

  await bots.close()
  await gateway.close()
  await storage.close()
})

it('takes a bot offline once when Discord closes its shards one at a time', async () => {
  const storage = await inMemoryStorage()
  const gateway = await fakeGateway(100 * HOUR)
  const clock = manualClock()
  let shards = 2
  let releasing: { readonly fail: () => void } | undefined
  let armed = false
  let offlineCalls = 0
  const flaky: Storage = {
    ...storage,
    setBotOffline: (...args) => {
      offlineCalls += 1
      return storage.setBotOffline(...args)
    },
    releaseLease: (...args) => {
      if (!armed) return storage.releaseLease(...args)
      armed = false
      // Postgres hangs on the release, then drops the connection.
      return new Promise((_, reject) => {
        releasing = { fail: () => reject(new Error('Connection terminated unexpectedly')) }
      })
    },
  }
  const bots = startHost(flaky, clock, (input, init) =>
    gateway.discordFetch({ shards, maxConcurrency: 2 })(input, init),
  )
  await bots.use(BOT_ID, 'private-token-a')
  await vi.waitFor(() => expect(identified(gateway)).toEqual(['0/2', '1/2']))

  // Sharding required: shard 0 first, and shard 1 while the pass that took the bot offline is
  // still giving shard 0's lease back.
  shards = 4
  armed = true
  shardConnection(gateway, 0)?.close(4011)
  await vi.waitFor(() => expect(releasing).toBeDefined())
  shardConnection(gateway, 1)?.close(4011)
  await new Promise((resolve) => setTimeout(resolve, 100))

  // An agent call brings the bot back with Discord's new count, then the stuck pass fails.
  const using = bots.use(BOT_ID, 'private-token-a')
  await vi.waitFor(async () =>
    expect((await storage.loadBot(BOT_ID))?.online).toMatchObject({ shardCount: 4 }),
  )
  releasing?.fail()
  await using

  await vi.waitFor(() => {
    clock.advance(1_000)
    expect(identified(gateway)).toContain('0/4')
  })
  expect((await storage.loadBot(BOT_ID))?.online).toMatchObject({ shardCount: 4 })
  expect(offlineCalls).toBe(1)

  await bots.close()
  await gateway.close()
  await storage.close()
})

it('takes a shard back from the session its last owner saved, not a write that failed before', async () => {
  const storage = await inMemoryStorage()
  const gateway = await fakeGateway(100 * HOUR)
  const clock = manualClock()
  const vault = createTokenVault(KEY, storage)
  const lease = `shard:${BOT_ID}:0`
  let failSave = false
  let handOver = false
  const bots = startHost(
    {
      ...storage,
      renewLeases: async (holder, names, ...rest) => {
        if (!handOver) return storage.renewLeases(holder, names, ...rest)
        handOver = false
        // Another host takes the shard, resumes it, and saves a newer sequence, then lets go.
        const renewed = await storage.renewLeases(
          holder,
          names.filter((name) => name !== lease),
          ...rest,
        )
        await storage.releaseLease(lease, holder)
        await storage.claimLease(lease, 'host-b', clock.date(), HOUR)
        const [bot] = await vault.loadOnline()
        const session = bot?.sessions.get(0)
        if (session === undefined) throw new Error('no stored session')
        await vault.storeSession(
          BOT_ID,
          0,
          { ...session, sequence: 9 },
          { lease, holder: 'host-b' },
        )
        await storage.releaseLease(lease, 'host-b')
        return renewed
      },
    },
    clock,
    gateway.discordFetch(),
    {
      vault: {
        ...vault,
        storeSession: async (...args) => {
          if (!failSave) return vault.storeSession(...args)
          failSave = false
          throw new Error('Connection terminated unexpectedly')
        },
      },
    },
  )
  await bots.use(BOT_ID, 'private-token-a')
  await vi.waitFor(async () => expect(await storedSequences(storage)).toEqual({ 0: 1 }))
  // Saving sequence 2 fails, and waits a minute to retry.
  failSave = true
  gateway.connections[0]?.send({ op: 0, t: 'MESSAGE_CREATE', s: 2, d: {} })
  await vi.waitFor(() => expect(failSave).toBe(false))

  handOver = true
  clock.advance(RECONCILE_MS)

  await vi.waitFor(() =>
    expect(gateway.connections[1]?.received[0]).toMatchObject({ op: 6, d: { seq: 9 } }),
  )

  await bots.close()
  await gateway.close()
  await storage.close()
})

it('leaves a bot another host brought back online when a shard here closed before', async () => {
  const storage = await inMemoryStorage()
  const gateway = await fakeGateway(100 * HOUR)
  const clock = manualClock()
  let shards = 4
  const discordFetch: typeof fetch = (input, init) =>
    gateway.discordFetch({ shards, maxConcurrency: 4 })(input, init)
  let paused: Promise<void> | undefined
  let resume = () => {}
  let offlineCalls = 0
  const slow: Storage = {
    ...storage,
    renewLeases: async (...args) => {
      await paused
      return storage.renewLeases(...args)
    },
    setBotOffline: async (...args) => {
      const changed = await storage.setBotOffline(...args)
      offlineCalls += 1
      return changed
    },
  }
  const hosts = ['host-a', 'host-b']
  const a = startHost(storage, clock, discordFetch, { self: 'host-a' })
  const b = startHost(slow, clock, discordFetch, { self: 'host-b' })
  await hostsLive(storage, clock, 2)
  await a.use(BOT_ID, 'private-token-a')
  clock.advance(RECONCILE_MS)
  await vi.waitFor(() => expect(identified(gateway)).toHaveLength(4))
  const onA = [0, 1, 2, 3].find((id) => shardOwner(hosts, BOT_ID, id) === 'host-a')
  const onB = [0, 1, 2, 3].find((id) => shardOwner(hosts, BOT_ID, id) === 'host-b')
  if (onA === undefined || onB === undefined) throw new Error('the shards did not spread')

  // Sharding required on both hosts, while host b's pass is slow to start.
  paused = new Promise((resolve) => {
    resume = resolve
  })
  shards = 8
  shardConnection(gateway, onB)?.close(4011)
  shardConnection(gateway, onA)?.close(4011)
  await vi.waitFor(async () => expect((await storage.loadBot(BOT_ID))?.online).toBeUndefined())
  // An agent call brings the bot back with Discord's new count.
  await a.use(BOT_ID, 'private-token-a')
  expect((await storage.loadBot(BOT_ID))?.online).toMatchObject({ shardCount: 8 })

  paused = undefined
  resume()
  await vi.waitFor(() => expect(offlineCalls).toBe(1))
  expect((await storage.loadBot(BOT_ID))?.online).toMatchObject({ shardCount: 8 })

  await a.close()
  await b.close()
  await gateway.close()
  await storage.close()
})

it('retries no session write that fails after the host took its shard back', async () => {
  const storage = await inMemoryStorage()
  const gateway = await fakeGateway(100 * HOUR)
  const clock = manualClock()
  const vault = createTokenVault(KEY, storage)
  const lease = `shard:${BOT_ID}:0`
  let failing: { readonly fail: () => void } | undefined
  let holdSave = false
  let handOver = false
  const bots = startHost(
    {
      ...storage,
      renewLeases: async (holder, names, ...rest) => {
        if (!handOver) return storage.renewLeases(holder, names, ...rest)
        handOver = false
        // Another host takes the shard, resumes it, and saves a newer sequence, then lets go.
        const renewed = await storage.renewLeases(
          holder,
          names.filter((name) => name !== lease),
          ...rest,
        )
        await storage.releaseLease(lease, holder)
        await storage.claimLease(lease, 'host-b', clock.date(), HOUR)
        const [bot] = await vault.loadOnline()
        const session = bot?.sessions.get(0)
        if (session === undefined) throw new Error('no stored session')
        await vault.storeSession(
          BOT_ID,
          0,
          { ...session, sequence: 9 },
          { lease, holder: 'host-b' },
        )
        await storage.releaseLease(lease, 'host-b')
        return renewed
      },
    },
    clock,
    gateway.discordFetch(),
    {
      vault: {
        ...vault,
        storeSession: (...args) => {
          if (!holdSave) return vault.storeSession(...args)
          holdSave = false
          // Postgres takes its time over this write, then drops the connection.
          return new Promise((_, reject) => {
            failing = { fail: () => reject(new Error('Connection terminated unexpectedly')) }
          })
        },
      },
    },
  )
  await bots.use(BOT_ID, 'private-token-a')
  await vi.waitFor(async () => expect(await storedSequences(storage)).toEqual({ 0: 1 }))
  holdSave = true
  gateway.connections[0]?.send({ op: 0, t: 'MESSAGE_CREATE', s: 2, d: {} })
  await vi.waitFor(() => expect(failing).toBeDefined())

  // The shard moves away and back while the write of sequence 2 is still out, then it fails.
  handOver = true
  clock.advance(RECONCILE_MS)
  await vi.waitFor(() => expect(handOver).toBe(false))
  await new Promise((resolve) => setTimeout(resolve, 100))
  failing?.fail()

  await vi.waitFor(() =>
    expect(gateway.connections[1]?.received[0]).toMatchObject({ op: 6, d: { seq: 9 } }),
  )

  await bots.close()
  await gateway.close()
  await storage.close()
})

it('takes a bot Discord rejected the token of offline, even if its workflows changed since', async () => {
  const storage = await inMemoryStorage()
  const gateway = await fakeGateway(100 * HOUR)
  const clock = manualClock()
  let paused: Promise<void> | undefined
  let resume = () => {}
  const bots = startHost(
    {
      ...storage,
      renewLeases: async (...args) => {
        await paused
        return storage.renewLeases(...args)
      },
    },
    clock,
    gateway.discordFetch(),
  )
  await bots.use(BOT_ID, 'private-token-a')
  await vi.waitFor(() => expect(gateway.connections[0]?.received[0]?.op).toBe(2))

  // The token is reset, and a workflow is enabled before the next pass.
  paused = new Promise((resolve) => {
    resume = resolve
  })
  gateway.connections[0]?.close(4004)
  await vi.waitFor(() => expect(gateway.connections[0]?.closeCode).toBe(4004))
  await enableWorkflow(storage, 'greeter', 512)
  paused = undefined
  resume()
  clock.advance(RECONCILE_MS)

  await vi.waitFor(async () => expect((await storage.loadBot(BOT_ID))?.rejectedCode).toBe(4004))
  expect((await storage.loadBot(BOT_ID))?.online).toBeUndefined()

  await bots.close()
  await gateway.close()
  await storage.close()
})
