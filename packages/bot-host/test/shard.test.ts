import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextIdentifyAt, startShard } from '../src/shard.ts'
import { DEFAULT_HEARTBEAT_INTERVAL_MS, fakeGateway, manualClock } from '../src/testing.ts'

const TOKEN = 'private-bot-token'
/** `GUILDS` and `GUILD_VOICE_STATES`. */
const VOICE_INTENTS = 129
const INTERVAL = DEFAULT_HEARTBEAT_INTERVAL_MS
const cleanup: Array<() => unknown> = []
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})

/** Start a shard against a fake Gateway, resuming `saved` from the fake's `/resume` path if given. */
const start = async (saved?: { sessionId: string; sequence: number }) => {
  const gateway = await fakeGateway()
  const clock = manualClock()
  const onFatal = vi.fn()
  const onSession = vi.fn()
  const shard = startShard({
    token: TOKEN,
    gatewayUrl: gateway.url,
    clock,
    ...(saved && {
      session: { ...saved, resumeGatewayUrl: `${gateway.url}/resume`, intents: VOICE_INTENTS },
    }),
    onSession,
    onReady: () => {},
    onFatal,
    onIdentifyBudgetSpent: () => {},
  })
  cleanup.push(gateway.close, shard.stop)
  return { gateway, clock, onFatal, onSession, shard }
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
      d: { token: TOKEN, intents: VOICE_INTENTS, presence: { status: 'online', afk: false } },
    })

    // The first beat is jittered: random() is 0.5, so half an interval.
    clock.advance(INTERVAL / 2)
    await vi.waitFor(() => expect(connection?.received[1]).toEqual({ op: 1, d: 1 }))
    clock.advance(INTERVAL)
    await vi.waitFor(() => expect(connection?.received[2]).toEqual({ op: 1, d: 1 }))
    expect(gateway.connections).toHaveLength(1)
  })

  it('resumes after a zombie connection or a dropped one, so Discord replays what it missed', async () => {
    const { gateway, clock, onSession } = await start()
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
    await vi.waitFor(() =>
      expect(gateway.connections[1]?.received[0]).toEqual({
        op: 6,
        d: { token: TOKEN, session_id: 'fake-session', seq: 1 },
      }),
    )
    gateway.connections[1]?.send({ op: 0, t: 'MESSAGE_CREATE', s: 2, d: {} })
    gateway.connections[1]?.send({ op: 0, t: 'RESUMED', s: 3, d: {} })
    await vi.waitFor(() =>
      expect(onSession).toHaveBeenLastCalledWith({
        sessionId: 'fake-session',
        resumeGatewayUrl: gateway.url,
        sequence: 3,
        intents: VOICE_INTENTS,
      }),
    )

    // A later drop resumes again, from the replayed sequence, without spending an Identify.
    gateway.connections[1]?.close(4000)
    await vi.waitFor(() => expect(gateway.connections[1]?.closeCode).toBe(4000))
    clock.advance(500)
    await vi.waitFor(() =>
      expect(gateway.connections[2]?.received[0]).toMatchObject({ op: 6, d: { seq: 3 } }),
    )
    await identified(gateway, 1)
  })

  it('identifies afresh instead of resuming a session saved with other intents', async () => {
    const gateway = await fakeGateway()
    const shard = startShard({
      token: TOKEN,
      gatewayUrl: gateway.url,
      clock: manualClock(),
      // Saved before voice, when the shard identified with no intents.
      session: { sessionId: 'no-voice', resumeGatewayUrl: gateway.url, sequence: 7, intents: 0 },
      onSession: () => {},
      onReady: () => {},
      onFatal: () => {},
      onIdentifyBudgetSpent: () => {},
    })
    cleanup.push(gateway.close, shard.stop)
    await vi.waitFor(() =>
      expect(gateway.connections[0]?.received[0]).toMatchObject({
        op: 2,
        d: { intents: VOICE_INTENTS },
      }),
    )
  })

  it('identifies afresh, within Identify limits, when Discord rejects a saved session', async () => {
    const { gateway, clock } = await start({ sessionId: 'expired', sequence: 7 })
    await vi.waitFor(() =>
      expect(gateway.connections[0]?.received[0]).toEqual({
        op: 6,
        d: { token: TOKEN, session_id: 'expired', seq: 7 },
      }),
    )
    expect(gateway.connections[0]?.path).toBe('/resume/?v=10&encoding=json')

    gateway.connections[0]?.send({ op: 9, d: false })
    await vi.waitFor(() => expect(gateway.connections[0]?.closeCode).toBe(4000))
    // Discord asks for a random 1–5 second wait; random() is 0.5.
    clock.advance(3_000)
    await identified(gateway, 1)
    expect(gateway.connections[1]?.path).toBe('/?v=10&encoding=json')

    // Rejected again straight away: the next Identify waits out Discord's five-second window.
    gateway.connections[1]?.send({ op: 9, d: false })
    await vi.waitFor(() => expect(gateway.connections[1]?.closeCode).toBe(4000))
    clock.advance(3_000)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(gateway.connections).toHaveLength(2)
    clock.advance(2_000)
    await identified(gateway, 2)
  })

  it.each([4003, 4007, 4009])(
    'identifies afresh when Discord closes a resumed session with %i',
    async (code) => {
      const { gateway, clock } = await start({ sessionId: 'expired', sequence: 7 })
      await vi.waitFor(() => expect(gateway.connections[0]?.received[0]?.op).toBe(6))

      gateway.connections[0]?.close(code)
      await vi.waitFor(() => expect(gateway.connections[0]?.closeCode).toBe(code))
      clock.advance(500)
      await identified(gateway, 1)
    },
  )

  it('resumes through the initial Gateway URL when the resume URL is unreachable', async () => {
    const gateway = await fakeGateway()
    const clock = manualClock()
    const NativeWebSocket = globalThis.WebSocket
    const resumeGatewayUrl = 'wss://gateway-unreachable.discord.gg'
    const urls: string[] = []
    vi.stubGlobal(
      'WebSocket',
      class extends NativeWebSocket {
        constructor(url: string | URL) {
          urls.push(String(url))
          // Make an allowed Discord resume destination unreachable without leaving localhost.
          super(String(url).startsWith(resumeGatewayUrl) ? 'ws://127.0.0.1:1' : url)
        }
      },
    )
    cleanup.push(() => vi.unstubAllGlobals())
    const shard = startShard({
      token: TOKEN,
      gatewayUrl: gateway.url,
      clock,
      session: { sessionId: 'saved', resumeGatewayUrl, sequence: 7, intents: VOICE_INTENTS },
      onSession: () => {},
      onReady: () => {},
      onFatal: () => {},
      onIdentifyBudgetSpent: () => {},
    })
    cleanup.push(gateway.close, shard.stop)

    // Nothing listens on port 1, so the first connection fails before Hello. Advance time until
    // its reconnect backoff has run.
    await vi.waitFor(() => {
      clock.advance(500)
      expect(gateway.connections[0]?.received[0]).toEqual({
        op: 6,
        d: { token: TOKEN, session_id: 'saved', seq: 7 },
      })
    })
    expect(urls).toEqual([
      `${resumeGatewayUrl}/?v=10&encoding=json`,
      `${gateway.url}/?v=10&encoding=json`,
    ])
  })

  it.each(['saved', 'READY'])(
    'does not connect or send the token to a private resume URL from %s',
    async (source) => {
      const gateway = await fakeGateway()
      const target = await fakeGateway()
      const clock = manualClock()
      const session = {
        sessionId: 'saved',
        resumeGatewayUrl: target.url,
        sequence: 7,
        intents: VOICE_INTENTS,
      }
      const onSession = vi.fn()
      const shard = startShard({
        token: TOKEN,
        gatewayUrl: gateway.url,
        clock,
        ...(source === 'saved' && { session }),
        onSession,
        onReady: () => {},
        onFatal: () => {},
        onIdentifyBudgetSpent: () => {},
      })
      cleanup.push(gateway.close, target.close, shard.stop)

      if (source === 'READY') {
        await identified(gateway, 1)
        gateway.connections[0]?.send({
          op: 0,
          t: 'READY',
          s: 7,
          d: { session_id: session.sessionId, resume_gateway_url: target.url },
        })
        await vi.waitFor(() => expect(onSession).toHaveBeenLastCalledWith(session))
        gateway.connections[0]?.send({ op: 7 })
        await vi.waitFor(() => expect(gateway.connections[0]?.closeCode).toBe(4000))
        clock.advance(500)
      }

      await vi.waitFor(() =>
        expect(gateway.connections.at(-1)?.received[0]).toEqual({
          op: 6,
          d: { token: TOKEN, session_id: 'saved', seq: 7 },
        }),
      )
      expect(target.connections).toEqual([])
    },
  )

  it.each([
    ['wss://gateway.discord.gg', 'wss://gateway.discord.gg/'],
    ['wss://gateway-us-east1-b.discord.gg', 'wss://gateway-us-east1-b.discord.gg/'],
    ['wss://gateway.discord.gg.evil.example', 'wss://gateway.discord.gg/'],
    ['wss://evildiscord.gg', 'wss://gateway.discord.gg/'],
    ['wss://gateway.discord.gg@evil.example', 'wss://gateway.discord.gg/'],
    ['wss://user:password@gateway.discord.gg', 'wss://gateway.discord.gg/'],
    ['ws://gateway-us-east1-b.discord.gg', 'wss://gateway.discord.gg/'],
    ['wss://gateway-us-east1-b.discord.gg:8443', 'wss://gateway.discord.gg/'],
    ['ws://169.254.169.254', 'wss://gateway.discord.gg/'],
    ['ws://[::1]', 'wss://gateway.discord.gg/'],
    ['not a URL', 'wss://gateway.discord.gg/'],
  ])('uses only a trusted Gateway for resume URL %s', (resumeGatewayUrl, expected) => {
    const urls: string[] = []
    vi.stubGlobal(
      'WebSocket',
      class extends EventTarget {
        constructor(url: string | URL) {
          super()
          urls.push(String(url))
        }
        close() {}
      },
    )
    cleanup.push(() => vi.unstubAllGlobals())
    const shard = startShard({
      token: TOKEN,
      gatewayUrl: 'wss://gateway.discord.gg',
      clock: manualClock(),
      session: { sessionId: 'saved', resumeGatewayUrl, sequence: 7, intents: VOICE_INTENTS },
      onSession: () => {},
      onReady: () => {},
      onFatal: () => {},
      onIdentifyBudgetSpent: () => {},
    })
    cleanup.push(shard.stop)
    expect(urls).toEqual([`${expected}?v=10&encoding=json`])
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

  it.each([
    { case: 'a first Identify goes now', identifiedAt: [], next: 100_000 },
    {
      case: 'a recent Identify holds the next for five seconds',
      identifiedAt: [98_000],
      next: 103_000,
    },
    {
      case: 'a spent daily budget waits for the oldest Identify to age out',
      identifiedAt: Array.from({ length: 500 }, (_, i) => i * 100),
      next: 24 * 60 * 60 * 1000,
    },
    {
      case: 'a budget reopening still waits five seconds after the latest Identify',
      identifiedAt: [0, ...Array.from({ length: 499 }, (_, i) => 86_398_000 - (498 - i) * 5_000)],
      now: 86_398_000,
      next: 86_403_000,
    },
  ])(
    'schedules Identifies within Discord limits: $case',
    ({ identifiedAt, now = 100_000, next }) => {
      expect(nextIdentifyAt(identifiedAt, now)).toBe(next)
    },
  )
})
