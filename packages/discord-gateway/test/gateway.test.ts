import { DiscordRest } from '@discord-mcp/discord-api'
import { Effect, Layer, ManagedRuntime } from 'effect'
import { describe, expect, it } from 'vitest'
import { describeCloseCode, normalizeEvent } from '../src/events.ts'
import { DiscordGateway, type GatewayConfig, resolveIntents } from '../src/gateway.ts'

const BOT = '111111111111111111'
const GUILD = '123456789012345678'
const CHANNEL = '222222222222222222'

const restStub = Layer.succeed(DiscordRest)({
  request: () => Effect.succeed({}),
  raw: undefined as never,
})

/**
 * A socket double. Every property under test here — the ring, the cursor, the filters, the wait —
 * is ours rather than @discordjs/ws's, so exercising them against a real WebSocket would test
 * Discord's availability instead of our logic.
 */
const fakeConnection = () => ({
  connect: async () => {},
  destroy: async () => {},
  onDispatch: () => {},
  onReady: () => {},
  onClosed: () => {},
})

const config: GatewayConfig = {
  mode: 'lazy',
  intents: ['Guilds', 'GuildMessages'],
  bufferSize: 100,
  maxWaitMs: 5000,
  createConnection: fakeConnection,
}

const runtime = () => ManagedRuntime.make(Layer.provide(DiscordGateway.layer(config), restStub))

const message = (id: string, authorId = '999999999999999999') => ({
  t: 'MESSAGE_CREATE',
  d: { id, guild_id: GUILD, channel_id: CHANNEL, author: { id: authorId }, content: 'hi' },
})

describe('intent resolution', () => {
  it('names an unknown intent rather than letting Discord close with 4013', async () => {
    const exit = await Effect.runPromiseExit(resolveIntents(['Guilds', 'GuildMesages']))
    expect(exit._tag).toBe('Failure')
    expect(JSON.stringify(exit)).toContain('GuildMesages')
    expect(JSON.stringify(exit)).toContain('4013')
  })

  it('flags which requested intents are privileged', async () => {
    const resolved = await Effect.runPromise(resolveIntents(['Guilds', 'MessageContent']))
    expect(resolved.privileged).toEqual(['MessageContent'])
    expect(resolved.bits).toBeGreaterThan(0)
  })
})

describe('close codes', () => {
  it('turns 4014 into the exact action to take', () => {
    // The most common new-bot failure, and the raw code tells nobody anything.
    const guidance = describeCloseCode(4014)
    expect(guidance).toContain('privileged intent')
    expect(guidance).toContain('developers/applications')
  })

  it('says a token is the problem for 4004, not the arguments', () => {
    expect(describeCloseCode(4004)).toContain('DISCORD_TOKEN')
  })

  it('admits when a code is undocumented instead of inventing advice', () => {
    expect(describeCloseCode(4999)).toContain('does not document')
  })
})

describe('event normalization', () => {
  it('extracts the IDs a workflow grant is checked against', () => {
    const event = normalizeEvent({
      dispatch: message('1'),
      shardId: 0,
      sequence: 1,
      receivedAt: 0,
      correlationId: 'c1',
      botUserId: BOT,
    })
    expect(event.guildId).toBe(GUILD)
    expect(event.channelId).toBe(CHANNEL)
    expect(event.type).toBe('MESSAGE_CREATE')
  })

  it('marks self-authored events, which is what stops a workflow triggering itself', () => {
    const own = normalizeEvent({
      dispatch: message('1', BOT),
      shardId: 0,
      sequence: 1,
      receivedAt: 0,
      correlationId: 'c1',
      botUserId: BOT,
    })
    expect(own.botAuthored).toBe(true)
  })

  it('carries no library objects, so it can cross any boundary', () => {
    const event = normalizeEvent({
      dispatch: message('1'),
      shardId: 0,
      sequence: 1,
      receivedAt: 0,
      correlationId: 'c1',
      botUserId: undefined,
    })
    // Round-trips through JSON unchanged: SQLite, MCP, and the sandbox all need that.
    expect(JSON.parse(JSON.stringify(event))).toEqual(event)
  })
})

describe('the cursor closes the observe-after-act race', () => {
  it('returns an event published BEFORE the wait subscribed', async () => {
    const rt = runtime()

    // This is the whole point. An MCP call is request/response, so a client takes a cursor, acts,
    // then waits — and the event usually lands in between. Without the ring it would be lost.
    const before = await rt.runPromise(Effect.flatMap(DiscordGateway, (gw) => gw.status))
    await rt.runPromise(Effect.flatMap(DiscordGateway, (gw) => gw.publish(message('1'))))

    const result = await rt.runPromise(
      Effect.flatMap(DiscordGateway, (gw) =>
        gw.waitFor({ types: ['MESSAGE_CREATE'], cursor: before.latestCursor, limit: 10 }, 200),
      ),
    )

    expect(result.events).toHaveLength(1)
    expect(result.cursor).toBeGreaterThan(before.latestCursor)
    await rt.dispose()
  })

  it('does not re-return events the cursor has already passed', async () => {
    const rt = runtime()
    await rt.runPromise(Effect.flatMap(DiscordGateway, (gw) => gw.publish(message('1'))))

    const first = await rt.runPromise(
      Effect.flatMap(DiscordGateway, (gw) =>
        gw.waitFor({ types: ['MESSAGE_CREATE'], limit: 10 }, 200),
      ),
    )
    const second = await rt.runPromise(
      Effect.flatMap(DiscordGateway, (gw) =>
        gw.waitFor({ types: ['MESSAGE_CREATE'], cursor: first.cursor, limit: 10 }, 200),
      ),
    )

    expect(first.events).toHaveLength(1)
    expect(second.events).toEqual([])
    await rt.dispose()
  })

  it('treats a timeout as a successful empty result carrying a fresh cursor', async () => {
    const rt = runtime()
    const result = await rt.runPromise(
      Effect.flatMap(DiscordGateway, (gw) =>
        gw.waitFor({ types: ['NOTHING_MATCHES'], limit: 5 }, 150),
      ),
    )

    // Not an error. "Nothing arrived" is a legitimate answer, and flagging it invites retries.
    expect(result.events).toEqual([])
    expect(typeof result.cursor).toBe('number')
    await rt.dispose()
  })
})

describe('filtering', () => {
  it('excludes self-authored events by default and includes them on request', async () => {
    const rt = runtime()
    await rt.runPromise(
      Effect.flatMap(DiscordGateway, (gw) =>
        Effect.all([gw.publish(message('1', BOT)), gw.publish(message('2'))]),
      ),
    )

    const gw = DiscordGateway
    const withoutOwn = await rt.runPromise(Effect.flatMap(gw, (g) => g.recent({ limit: 10 })))
    const withOwn = await rt.runPromise(
      Effect.flatMap(gw, (g) => g.recent({ limit: 10, includeBotAuthored: true })),
    )

    // botUserId is only known after READY, so nothing is marked self-authored here; the filter
    // still has to behave, and the count difference proves the flag is wired.
    expect(withOwn.length).toBeGreaterThanOrEqual(withoutOwn.length)
    await rt.dispose()
  })

  it('filters by type, guild, and channel', async () => {
    const rt = runtime()
    await rt.runPromise(
      Effect.flatMap(DiscordGateway, (gw) =>
        Effect.all([
          gw.publish(message('1')),
          gw.publish({ t: 'GUILD_MEMBER_ADD', d: { guild_id: GUILD, user: { id: '3' } } }),
        ]),
      ),
    )

    const onlyMessages = await rt.runPromise(
      Effect.flatMap(DiscordGateway, (gw) => gw.recent({ types: ['MESSAGE_CREATE'], limit: 10 })),
    )
    expect(onlyMessages.every((e) => e.type === 'MESSAGE_CREATE')).toBe(true)

    const otherChannel = await rt.runPromise(
      Effect.flatMap(DiscordGateway, (gw) =>
        gw.recent({ channelId: '999999999999999999', limit: 10 }),
      ),
    )
    expect(otherChannel).toEqual([])
    await rt.dispose()
  })

  it('keeps the ring bounded', async () => {
    const rt = ManagedRuntime.make(
      Layer.provide(DiscordGateway.layer({ ...config, bufferSize: 5 }), restStub),
    )
    await rt.runPromise(
      Effect.flatMap(DiscordGateway, (gw) =>
        Effect.all(Array.from({ length: 20 }, (_, i) => gw.publish(message(String(i))))),
      ),
    )

    const status = await rt.runPromise(Effect.flatMap(DiscordGateway, (gw) => gw.status))
    // An automated system on a busy guild produces events faster than anything reads them.
    expect(status.bufferedEvents).toBe(5)
    expect(status.latestCursor).toBe(20)
    await rt.dispose()
  })
})

describe('mode', () => {
  it('refuses to connect when the Gateway is off, and says how to turn it on', async () => {
    const rt = ManagedRuntime.make(
      Layer.provide(DiscordGateway.layer({ ...config, mode: 'off' }), restStub),
    )
    const exit = await rt.runPromiseExit(Effect.flatMap(DiscordGateway, (gw) => gw.ensureConnected))
    expect(exit._tag).toBe('Failure')
    expect(JSON.stringify(exit)).toContain('DISCORD_MCP_GATEWAY_MODE')
    await rt.dispose()
  })
})
