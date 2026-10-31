import { afterEach, describe, expect, it, vi } from 'vitest'
import { startShard } from '../src/shard.ts'
import { DEFAULT_HEARTBEAT_INTERVAL_MS, fakeGateway, manualClock } from '../src/testing.ts'

const TOKEN = 'private-bot-token'
const INTERVAL = DEFAULT_HEARTBEAT_INTERVAL_MS
const cleanup: Array<() => unknown> = []
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})

const start = async () => {
  const gateway = await fakeGateway()
  const clock = manualClock()
  const onFatal = vi.fn()
  const shard = startShard({
    token: TOKEN,
    gatewayUrl: gateway.url,
    clock,
    onReady: () => {},
    onFatal,
  })
  cleanup.push(gateway.close, shard.stop)
  return { gateway, clock, onFatal, shard }
}

const identified = (gateway: Awaited<ReturnType<typeof fakeGateway>>, count: number) =>
  vi.waitFor(() =>
    expect(gateway.connections.filter((c) => c.received.some((p) => p.op === 2))).toHaveLength(
      count,
    ),
  )

describe('the shard supervisor', () => {
  it('identifies with an online presence and heartbeats the last sequence number', async () => {
    const { gateway, clock } = await start()
    await identified(gateway, 1)
    const connection = gateway.connections[0]
    expect(connection?.received[0]).toMatchObject({
      op: 2,
      d: { token: TOKEN, intents: 0, presence: { status: 'online', afk: false } },
    })

    // The first beat is jittered: random() is 0.5, so half an interval.
    clock.advance(INTERVAL / 2)
    await vi.waitFor(() => expect(connection?.received[1]).toEqual({ op: 1, d: 1 }))
    clock.advance(INTERVAL)
    await vi.waitFor(() => expect(connection?.received[2]).toEqual({ op: 1, d: 1 }))
    expect(gateway.connections).toHaveLength(1)
  })

  it('reconnects with a fresh identify after a zombie connection or a dropped one', async () => {
    const { gateway, clock } = await start()
    await identified(gateway, 1)
    const zombie = gateway.connections[0]
    if (zombie === undefined) throw new Error('no connection')
    zombie.acknowledge = false

    clock.advance(INTERVAL / 2)
    await vi.waitFor(() => expect(zombie.received.at(-1)).toEqual({ op: 1, d: 1 }))
    // The next beat finds no ACK, so the shard abandons the connection.
    clock.advance(INTERVAL)
    await vi.waitFor(() => expect(zombie.closeCode).toBe(4000))
    // Backoff is 1s × random() for the first attempt.
    clock.advance(500)
    await identified(gateway, 2)

    // A drop right after an Identify waits out Discord's five-second Identify window.
    gateway.connections[1]?.close(4000)
    await vi.waitFor(() => expect(gateway.connections[1]?.closeCode).toBe(4000))
    clock.advance(4_000)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(gateway.connections).toHaveLength(2)
    clock.advance(1_000)
    await identified(gateway, 3)
  })

  it('stops for good when Discord rejects the token', async () => {
    const { gateway, clock, onFatal } = await start()
    await identified(gateway, 1)

    gateway.connections[0]?.close(4004)
    await vi.waitFor(() => expect(onFatal).toHaveBeenCalledWith(4004))
    clock.advance(60 * 60 * 1000)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(gateway.connections).toHaveLength(1)
  })

  it('closes normally on stop, so Discord shows the bot offline', async () => {
    const { gateway, shard } = await start()
    await identified(gateway, 1)

    shard.stop()
    await vi.waitFor(() => expect(gateway.connections[0]?.closeCode).toBe(1000))
  })
})
