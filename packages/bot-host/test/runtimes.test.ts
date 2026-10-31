import { inMemoryStorage } from '@discord-mcp/storage/testing'
import { expect, it, vi } from 'vitest'
import { createBotRuntimes, IDLE_TIMEOUT_MS } from '../src/runtimes.ts'
import { fakeGateway, manualClock } from '../src/testing.ts'
import { createTokenVault } from '../src/vault.ts'

/** `GUILDS` and `GUILD_VOICE_STATES`, which every bot identifies with for voice. */
const VOICE_INTENTS = 129
const BOT_ID = '345678901234567890'
const KEY = Buffer.alloc(32, 1)
const HOUR = 60 * 60 * 1000

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

it('leaves a bot Discord rejected offline until its token changes', async () => {
  const storage = await inMemoryStorage()
  const gateway = await fakeGateway()
  const bots = createBotRuntimes({
    vault: createTokenVault(KEY, storage),
    storage,
    clock: manualClock(),
    log: () => {},
    discordFetch: gateway.discordFetch(),
  })

  await bots.use(BOT_ID, 'private-token-a')
  await vi.waitFor(() => expect(gateway.connections[0]?.received[0]?.op).toBe(2))
  // Authentication failed: the token was reset.
  gateway.connections[0]?.close(4004)
  await vi.waitFor(() => expect(gateway.connections[0]?.closeCode).toBe(4004))

  await bots.use(BOT_ID, 'private-token-a')
  await new Promise((resolve) => setTimeout(resolve, 100))
  expect(gateway.connections).toHaveLength(1)

  await bots.use(BOT_ID, 'private-token-b')
  await vi.waitFor(() => expect(gateway.connections[1]?.received[0]).toMatchObject({ op: 2 }))

  await bots.close()
  await gateway.close()
  await storage.close()
})

it('resumes an online bot after a restart, from what the previous process stored', async () => {
  const storage = await inMemoryStorage()
  const gateway = await fakeGateway()
  const options = { clock: manualClock(), log: () => {}, discordFetch: gateway.discordFetch() }
  const before = createBotRuntimes({ vault: createTokenVault(KEY, storage), storage, ...options })
  const stored = createTokenVault(KEY, storage)

  await before.use(BOT_ID, 'private-token-a')
  await vi.waitFor(() => expect(gateway.connections[0]?.received[0]?.op).toBe(2))
  gateway.connections[0]?.send({ op: 0, t: 'MESSAGE_CREATE', s: 2, d: {} })
  await vi.waitFor(async () => expect((await stored.loadSessions())[0]?.session.sequence).toBe(2))
  await before.close()
  // Any close but 1000 or 1001 keeps the session resumable.
  await vi.waitFor(() => expect(gateway.connections[0]?.closeCode).toBe(4000))

  // The next process shares nothing with the last but the database and the vault key.
  const after = createBotRuntimes({ vault: createTokenVault(KEY, storage), storage, ...options })
  await after.resume()
  await vi.waitFor(() =>
    expect(gateway.connections[1]?.received[0]).toEqual({
      op: 6,
      d: { token: 'private-token-a', session_id: 'fake-session', seq: 2 },
    }),
  )
  // Discord replays what happened during the restart.
  gateway.connections[1]?.send({ op: 0, t: 'MESSAGE_CREATE', s: 3, d: {} })
  gateway.connections[1]?.send({ op: 0, t: 'RESUMED', s: 4, d: {} })
  await vi.waitFor(async () => expect((await stored.loadSessions())[0]?.session.sequence).toBe(4))

  await after.close()
  await gateway.close()
  await storage.close()
})

it('brings back a bot whose session Discord invalidated just before a restart', async () => {
  const storage = await inMemoryStorage()
  const gateway = await fakeGateway()
  const options = { clock: manualClock(), log: () => {}, discordFetch: gateway.discordFetch() }
  const before = createBotRuntimes({ vault: createTokenVault(KEY, storage), storage, ...options })

  await before.use(BOT_ID, 'private-token-a')
  await vi.waitFor(async () =>
    expect(await createTokenVault(KEY, storage).loadSessions()).toHaveLength(1),
  )
  // The restart lands while the shard waits to identify afresh.
  gateway.connections[0]?.send({ op: 9, d: false })
  await vi.waitFor(() => expect(gateway.connections[0]?.closeCode).toBe(4000))
  await before.close()

  const after = createBotRuntimes({ vault: createTokenVault(KEY, storage), storage, ...options })
  await after.resume()
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
  const bots = createBotRuntimes({
    vault: { ...vault, storeSession },
    storage,
    clock,
    log: () => {},
    discordFetch: gateway.discordFetch(),
  })

  // READY is the only dispatch, and storing it fails.
  await bots.use(BOT_ID, 'private-token-a')
  await vi.waitFor(() => expect(storeSession).toHaveBeenCalledTimes(1))
  expect(await vault.loadSessions()).toEqual([])

  clock.advance(60_000)
  await vi.waitFor(async () => expect(await vault.loadSessions()).toHaveLength(1))

  await bots.close()
  await gateway.close()
  await storage.close()
})

it('clears an idle bot’s session even when the clear fails during shutdown', async () => {
  const storage = await inMemoryStorage()
  const gateway = await fakeGateway(100 * HOUR)
  const clock = manualClock()
  const vault = createTokenVault(KEY, storage)
  let failClear = (_: Error) => {}
  const clearSession = vi.fn(vault.clearSession).mockImplementationOnce(
    () =>
      new Promise((_, reject) => {
        failClear = reject
      }),
  )
  const bots = createBotRuntimes({
    vault: { ...vault, clearSession },
    storage,
    clock,
    log: () => {},
    discordFetch: gateway.discordFetch(),
  })

  await bots.use(BOT_ID, 'private-token-a')
  await vi.waitFor(async () => expect(await vault.loadSessions()).toHaveLength(1))
  clock.advance(IDLE_TIMEOUT_MS)
  await vi.waitFor(() => expect(clearSession).toHaveBeenCalledTimes(1))
  // Shutdown starts while the clear is in flight, and then the clear fails.
  const closed = bots.close()
  failClear(new Error('Connection terminated unexpectedly'))
  await closed
  expect(await vault.loadSessions()).toEqual([])
  await gateway.close()
  await storage.close()
})

it('resumes only the bots this host owns, when bot hosts share a database', async () => {
  const OTHER_BOT_ID = '456789012345678901'
  const storage = await inMemoryStorage()
  const gateway = await fakeGateway()
  const options = { clock: manualClock(), log: () => {}, discordFetch: gateway.discordFetch() }
  const before = createBotRuntimes({ vault: createTokenVault(KEY, storage), storage, ...options })
  await before.use(BOT_ID, 'private-token-a')
  await before.use(OTHER_BOT_ID, 'private-token-b')
  await vi.waitFor(() => expect(gateway.connections).toHaveLength(2))
  await vi.waitFor(async () =>
    expect(await createTokenVault(KEY, storage).loadSessions()).toHaveLength(2),
  )
  await before.close()

  const after = createBotRuntimes({ vault: createTokenVault(KEY, storage), storage, ...options })
  await after.resume((botId) => botId === BOT_ID)
  await vi.waitFor(() =>
    expect(gateway.connections[2]?.received[0]).toMatchObject({ d: { token: 'private-token-a' } }),
  )
  await new Promise((resolve) => setTimeout(resolve, 100))
  expect(gateway.connections).toHaveLength(3)

  await after.close()
  await gateway.close()
  await storage.close()
})

it('runs every shard Discord recommends, one Identify per concurrency bucket at a time', async () => {
  const storage = await inMemoryStorage()
  const gateway = await fakeGateway(100 * HOUR)
  const clock = manualClock()
  const onDispatch = vi.fn()
  const bots = createBotRuntimes({
    vault: createTokenVault(KEY, storage),
    storage,
    clock,
    log: () => {},
    discordFetch: gateway.discordFetch({ shards: 4, maxConcurrency: 2 }),
    onDispatch,
  })

  await bots.use(BOT_ID, 'private-token-a')
  await vi.waitFor(() => expect(gateway.connections).toHaveLength(4))
  // Buckets are shard ID mod 2. Each lets one shard identify, and the other waits five seconds.
  await vi.waitFor(() => expect(identified(gateway)).toHaveLength(2))
  await new Promise((resolve) => setTimeout(resolve, 100))
  const buckets = identified(gateway).map((shard) => Number(shard.split('/')[0]) % 2)
  expect(buckets.sort()).toEqual([0, 1])
  clock.advance(5_000)
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
  const bots = createBotRuntimes({
    vault: createTokenVault(KEY, storage),
    storage,
    clock,
    log: () => {},
    discordFetch: gateway.discordFetch({ shards: 4, maxConcurrency: 4, remaining: 4 }),
  })

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
  const bots = createBotRuntimes({
    vault: createTokenVault(KEY, storage),
    storage,
    clock,
    log: () => {},
    discordFetch: gateway.discordFetch({ shards: 2, maxConcurrency: 2 }),
  })

  await bots.use(BOT_ID, 'private-token-a')
  await vi.waitFor(() => expect(identified(gateway)).toEqual(['0/2', '1/2']))
  const dropped = shardConnection(gateway, 1)
  dropped?.send({ op: 0, t: 'MESSAGE_CREATE', s: 5, d: {} })
  await vi.waitFor(async () =>
    expect(
      (await createTokenVault(KEY, storage).loadSessions()).map((s) => s.session.sequence),
    ).toContain(5),
  )

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

it('resumes a multi-shard bot after a restart with the shard count it identified with', async () => {
  const storage = await inMemoryStorage()
  const gateway = await fakeGateway(100 * HOUR)
  const clock = manualClock()
  const vault = createTokenVault(KEY, storage)
  const before = createBotRuntimes({
    vault,
    storage,
    clock,
    log: () => {},
    discordFetch: gateway.discordFetch({ shards: 2, maxConcurrency: 2 }),
  })

  await before.use(BOT_ID, 'private-token-a')
  await vi.waitFor(async () => expect(await vault.loadSessions()).toHaveLength(2))
  await before.close()
  // Shard 1's session is gone, so it identifies afresh.
  await vault.clearSession(BOT_ID, 1)

  // The bot grew meanwhile: Discord now recommends three shards.
  const after = createBotRuntimes({
    vault,
    storage,
    clock,
    log: () => {},
    discordFetch: gateway.discordFetch({ shards: 3 }),
  })
  await after.resume()
  await vi.waitFor(() => expect(identified(gateway)).toEqual(['0/2', '1/2', '1/2']))
  expect(
    gateway.connections
      .slice(2)
      .map((c) => c.received[0]?.op)
      .sort(),
  ).toEqual([2, 6])
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
  const bots = createBotRuntimes({
    vault: createTokenVault(KEY, storage),
    storage,
    clock,
    log: () => {},
    discordFetch: (input, init) => gateway.discordFetch({ shards, maxConcurrency: 2 })(input, init),
  })

  await bots.use(BOT_ID, 'private-token-a')
  await vi.waitFor(() => expect(identified(gateway)).toEqual(['0/1']))
  shards = 2
  // Sharding required: the bot is in too many guilds for one shard.
  gateway.connections[0]?.close(4011)
  await vi.waitFor(() => expect(gateway.connections[0]?.closeCode).toBe(4011))

  await bots.use(BOT_ID, 'private-token-a')
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
  const bots = createBotRuntimes({
    vault: createTokenVault(KEY, storage),
    storage,
    clock,
    log: () => {},
    discordFetch,
  })

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

it('keeps a bot with enabled workflows online from its stored token until they are disabled', async () => {
  const storage = await inMemoryStorage()
  // Heartbeats are proven in the shard suite; keep them out of this window.
  const gateway = await fakeGateway(1000 * HOUR)
  const clock = manualClock()
  const vault = createTokenVault(KEY, storage)
  // Stored by an earlier agent call, before a restart.
  await vault.store(BOT_ID, 'private-token-a')
  const bots = createBotRuntimes({
    vault,
    storage,
    clock,
    log: () => {},
    discordFetch: gateway.discordFetch(),
  })

  // Startup holds bots with enabled workflows, then resumes.
  await bots.hold(BOT_ID, 512)
  await bots.resume()
  await vi.waitFor(() =>
    expect(gateway.connections[0]?.received[0]).toMatchObject({
      op: 2,
      d: { token: 'private-token-a', intents: 512 | VOICE_INTENTS },
    }),
  )
  clock.advance(2 * IDLE_TIMEOUT_MS)
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(gateway.connections[0]?.closeCode).toBeUndefined()

  await bots.hold(BOT_ID, undefined)
  clock.advance(IDLE_TIMEOUT_MS - HOUR)
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(gateway.connections[0]?.closeCode).toBeUndefined()
  clock.advance(HOUR)
  await vi.waitFor(() => expect(gateway.connections[0]?.closeCode).toBe(1000))

  await bots.close()
  await gateway.close()
  await storage.close()
})

it("tries again once its workflows change after Discord refused a bot's intents", async () => {
  const storage = await inMemoryStorage()
  const gateway = await fakeGateway(1000 * HOUR)
  const vault = createTokenVault(KEY, storage)
  await vault.store(BOT_ID, 'private-token-a')
  const bots = createBotRuntimes({
    vault,
    storage,
    clock: manualClock(),
    log: () => {},
    discordFetch: gateway.discordFetch(),
  })
  await bots.hold(BOT_ID, 1 << 15)
  await bots.resume()
  await vi.waitFor(() => expect(gateway.connections[0]?.received[0]?.op).toBe(2))

  // Message Content is off in the Developer Portal.
  gateway.connections[0]?.close(4014)
  await vi.waitFor(() => expect(gateway.connections[0]?.closeCode).toBe(4014))
  // The workflow that needed it was disabled.
  await bots.hold(BOT_ID, 1)

  await vi.waitFor(() =>
    expect(gateway.connections[1]?.received[0]).toMatchObject({
      op: 2,
      d: { intents: 1 | VOICE_INTENTS },
    }),
  )
  await bots.close()
  await gateway.close()
  await storage.close()
})

it('sets a presence on every shard of the bot', async () => {
  const storage = await inMemoryStorage()
  const gateway = await fakeGateway(1000 * HOUR)
  const clock = manualClock()
  const bots = createBotRuntimes({
    vault: createTokenVault(KEY, storage),
    storage,
    clock,
    log: () => {},
    discordFetch: gateway.discordFetch({ shards: 2, maxConcurrency: 2 }),
  })
  await bots.use(BOT_ID, 'private-token-a')
  await vi.waitFor(() => expect(identified(gateway)).toEqual(['0/2', '1/2']))

  const idle = { since: null, activities: [], status: 'idle', afk: false }
  bots.updatePresence(BOT_ID, idle)

  for (const shardId of [0, 1]) {
    await vi.waitFor(() =>
      expect(shardConnection(gateway, shardId)?.received).toContainEqual({ op: 3, d: idle }),
    )
  }
  await bots.close()
  await gateway.close()
  await storage.close()
})

it('holds a presence for a shard still waiting to identify, which Discord would close over it', async () => {
  const storage = await inMemoryStorage()
  const gateway = await fakeGateway(1000 * HOUR)
  const clock = manualClock()
  const bots = createBotRuntimes({
    vault: createTokenVault(KEY, storage),
    storage,
    clock,
    log: () => {},
    // One Identify every five seconds: the second shard waits, connected, for its turn.
    discordFetch: gateway.discordFetch({ shards: 2, maxConcurrency: 1 }),
  })
  await bots.use(BOT_ID, 'private-token-a')
  await vi.waitFor(() => expect(gateway.connections).toHaveLength(2))
  await vi.waitFor(() => expect(identified(gateway)).toHaveLength(1))
  const waiting = gateway.connections.find((c) => !c.received.some((p) => p.op === 2))

  const idle = { since: null, activities: [], status: 'idle', afk: false }
  bots.updatePresence(BOT_ID, idle)
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(waiting?.received.map((p) => p.op)).not.toContain(3)

  clock.advance(5_000)
  await vi.waitFor(() =>
    expect(waiting?.received.find((p) => p.op === 2)).toMatchObject({ d: { presence: idle } }),
  )
  await bots.close()
  await gateway.close()
  await storage.close()
})
