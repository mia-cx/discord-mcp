import { type BotRuntimes, createBotRuntimes, createTokenVault } from '@discord-mcp/bot-host'
import { fakeGateway, manualClock } from '@discord-mcp/bot-host/testing'
import { DiscordRest, OperationCatalog } from '@discord-mcp/discord-api'
import { makeIsolateHost, makeWorkflowHost, type WorkflowHost } from '@discord-mcp/isolate'
import { inMemoryStorage } from '@discord-mcp/storage/testing'
import { Effect, Layer, Redacted } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBotLimiters, createRelay } from '../src/relay.ts'
import { botToken, config, discordOAuth, executor, login } from './login-fixture.ts'

const BOT = { id: '345678901234567890', username: 'textile', discriminator: '0', bot: true }
const TOKEN = botToken(BOT.id)
const GUILD = '223456789012345678'
const CHANNEL = '123456789012345678'
const HUMAN_A = '234567890123456789'
const HUMAN_B = '234567890123456780'
const HOUR = 60 * 60 * 1000
/** Guilds, GuildMessages, and MessageContent. */
const PING_INTENTS = 1 | (1 << 9) | (1 << 15)
/** `GUILDS` and `GUILD_VOICE_STATES`, which every bot identifies with for voice. */
const VOICE_INTENTS = 129
/** The application flag that allows the MessageContent intent. */
const GATEWAY_MESSAGE_CONTENT = 1 << 18

const PING_PONG = `
import { Client, Events, GatewayIntentBits } from 'discord.js'

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
})

client.on(Events.MessageCreate, async (message) => {
  if (message.content === 'ping') await message.reply('pong')
  if (message.content === 'status') client.user.setPresence({ activities: [{ name: 'ping' }], status: 'idle' })
})

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return
  await interaction.deferReply()
  await interaction.editReply('hello')
  await interaction.followUp('goodbye')
})

client.login(process.env.DISCORD_TOKEN)
`

const sent = (content: unknown) => ({
  id: '900000000000000002',
  channel_id: CHANNEL,
  author: BOT,
  content,
  timestamp: '2026-10-31T00:00:01.000Z',
  edited_timestamp: null,
  tts: false,
  mention_everyone: false,
  mentions: [],
  mention_roles: [],
  attachments: [],
  embeds: [],
  pinned: false,
  type: 0,
})

const message = (sequence: number, content: string) => ({
  op: 0,
  s: sequence,
  t: 'MESSAGE_CREATE',
  d: {
    ...sent(content),
    id: `90000000000000010${sequence}`,
    guild_id: GUILD,
    author: { id: HUMAN_A, username: 'mia', discriminator: '0' },
  },
})

const INTERACTION_TOKEN = 'interaction-token'

/** `/hello`, as Discord delivers it with the token that answers it. */
const slashCommand = (sequence: number) => ({
  op: 0,
  s: sequence,
  t: 'INTERACTION_CREATE',
  d: {
    id: '700000000000000001',
    application_id: BOT.id,
    type: 2,
    token: INTERACTION_TOKEN,
    version: 1,
    guild_id: GUILD,
    channel_id: CHANNEL,
    channel: { id: CHANNEL, type: 0 },
    member: {
      user: { id: HUMAN_A, username: 'mia', discriminator: '0' },
      roles: [],
      permissions: '0',
      joined_at: '2026-01-01T00:00:00.000Z',
    },
    app_permissions: '0',
    locale: 'en-US',
    entitlements: [],
    authorizing_integration_owners: {},
    data: { id: '800000000000000001', name: 'hello', type: 1 },
  },
})

const cleanup: Array<() => unknown> = []
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})

/**
 * The relay and bot host in one process, against a fake Discord: REST behind the relay's seam,
 * the Gateway on a local socket, and a clock that moves only when told to.
 */
const platform = async (shards = 1) => {
  const storage = await inMemoryStorage()
  // Heartbeats are proven in the shard suite; keep them out of these windows.
  const gateway = await fakeGateway(100 * HOUR)
  const clock = manualClock()
  const log = vi.fn()
  const discord = { applicationFlags: GATEWAY_MESSAGE_CONTENT }
  const calls: Array<{
    token: string
    method: string
    route: string
    auth?: false
    body?: unknown
  }> = []
  /** Discord REST as the bot, for agent requests and workflow runs alike. */
  const client = (credential: Redacted.Redacted<string>): DiscordRest['Service'] => ({
    raw: undefined as never,
    request: (call) =>
      Effect.sync(() => {
        calls.push({
          token: Redacted.value(credential),
          method: call.method,
          route: call.route,
          ...(call.auth === undefined ? {} : { auth: call.auth }),
          ...(call.body === undefined ? {} : { body: call.body }),
        })
        if (call.route === '/users/@me') return BOT
        if (call.route === '/applications/@me') return { flags: discord.applicationFlags }
        // A response that quotes the credential it was sent with.
        if (call.route === `/channels/${CHANNEL}`) {
          return { id: CHANNEL, type: 0, echo: Redacted.value(credential) }
        }
        if (call.route.endsWith('/callback')) return new ArrayBuffer(0)
        return sent((call.body as { content?: unknown } | undefined)?.content)
      }),
  })
  let workflows: WorkflowHost | undefined
  const bots: BotRuntimes = createBotRuntimes({
    vault: createTokenVault(Buffer.alloc(32, 1), storage),
    clock,
    log,
    discordFetch: gateway.discordFetch({ shards, maxConcurrency: shards }),
    // Every shard's events, as the server wires them.
    onDispatch: (botId, t, d) => {
      const token = bots.tokenOf(botId)
      if (token === undefined || typeof d !== 'object' || d === null) return
      workflows?.dispatch({ botId, token, dispatch: { t, d: d as Record<string, unknown> } })
    },
  })
  const catalog = await Effect.runPromise(Effect.provide(OperationCatalog, OperationCatalog.layer))
  workflows = makeWorkflowHost({
    storage,
    isolates: makeIsolateHost(),
    bots,
    operations: catalog.all,
    rest: (_botId, token) => ({ client: client(token), release: () => {} }),
    log,
  })
  const oauth = discordOAuth()
  const relay = createRelay(
    { ...config, login: { ...config.login, allowedUserIds: [HUMAN_A, HUMAN_B] } },
    executor((token) => Layer.succeed(DiscordRest)(client(token)), {
      bots,
      scripts: true,
      workflows,
    }),
    oauth.fetch,
  )
  cleanup.push(
    () => storage.close(),
    gateway.close,
    () => bots.close(),
  )

  /** Log in as `human` and return a function that calls a tool with the bot's token. */
  const agent = async (human: string) => {
    oauth.state.userId = human
    const { tokens } = await login(relay)
    return async (name: string, args: Record<string, unknown> = {}) => {
      const response = await relay.fetch(
        new Request('https://relay.test/mcp', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'mcp-method': 'tools/call',
            'mcp-name': name,
            'mcp-protocol-version': '2026-07-28',
            authorization: `Bearer ${tokens.access_token}`,
            'x-discord-bot-token': TOKEN,
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: {
              _meta: {
                'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                'io.modelcontextprotocol/clientCapabilities': {},
              },
              name,
              arguments: args,
            },
          }),
        }),
      )
      const { result } = await response.json()
      return result as {
        isError?: boolean
        content: [{ text: string }]
        structuredContent: { data: unknown }
      }
    }
  }

  /** Shard `shardId`'s connection that identified with `intents`, once it has reconnected. */
  const identifiedWith = async (intents: number, shardId = 0) => {
    clock.advance(60_000)
    return vi.waitFor(() => {
      const connection = gateway.connections.find((c) =>
        c.received.some((p) => {
          const d = p.d as { intents?: number; shard?: number[] } | undefined
          return p.op === 2 && d?.intents === intents && d.shard?.[0] === shardId
        }),
      )
      if (connection === undefined) throw new Error(`No identify with intents ${intents}.`)
      return connection
    })
  }

  return { agent, calls, clock, discord, gateway, identifiedWith, log }
}

describe('workflows', () => {
  it('answer Gateway events while no agent is connected, and record who changed them', async () => {
    // Two shards: the events below arrive on the second.
    const { agent, calls, clock, discord, gateway, identifiedWith } = await platform(2)
    const asA = await agent(HUMAN_A)

    const published = await asA('discord_workflow_publish', {
      name: 'ping',
      source: PING_PONG,
      grants: { families: ['message', 'interaction', 'webhook'] },
    })
    expect(published.structuredContent.data).toMatchObject({
      name: 'ping',
      revision: 1,
      events: ['messageCreate', 'interactionCreate'],
      intents: ['Guilds', 'GuildMessages', 'MessageContent'],
      enabled: false,
    })

    discord.applicationFlags = 0
    const refused = await asA('discord_workflow_enable', { name: 'ping' })
    expect(refused.isError).toBe(true)
    expect(refused.content[0].text).toContain('MessageContent')

    discord.applicationFlags = GATEWAY_MESSAGE_CONTENT
    const enabled = await asA('discord_workflow_enable', { name: 'ping' })
    expect(enabled.structuredContent.data).toMatchObject({
      revision: 1,
      grants: { operations: [], families: ['message', 'interaction', 'webhook'], hosts: [] },
      enabled: true,
    })
    const connection = await identifiedWith(PING_INTENTS | VOICE_INTENTS, 1)

    // Two days without an agent call: the bot stays online for its workflow.
    clock.advance(48 * HOUR)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(connection.closeCode).toBeUndefined()
    calls.length = 0

    connection.send(message(2, 'ping'))
    await vi.waitFor(() =>
      expect(calls).toContainEqual({
        token: TOKEN,
        method: 'POST',
        route: `/channels/${CHANNEL}/messages`,
        body: expect.objectContaining({ content: 'pong' }),
      }),
    )

    connection.send(slashCommand(3))
    await vi.waitFor(() => expect(calls.filter((call) => call.auth === false)).toHaveLength(3))
    expect(
      calls.filter((call) => call.auth === false).map((call) => [call.method, call.route]),
    ).toEqual([
      ['POST', '/interactions/700000000000000001/interaction-token/callback'],
      ['PATCH', `/webhooks/${BOT.id}/interaction-token/messages/%40original`],
      ['POST', `/webhooks/${BOT.id}/interaction-token`],
    ])

    connection.send(message(4, 'status'))
    await vi.waitFor(() =>
      expect(connection.received).toContainEqual({
        op: 3,
        d: { status: 'idle', afk: false, since: null, activities: [{ name: 'ping', type: 0 }] },
      }),
    )

    // Anyone with relay access and the bot's token manages its workflows.
    const asB = await agent(HUMAN_B)
    expect((await asB('discord_workflow_disable', { name: 'ping' })).isError).toBe(false)
    const listed = await asB('discord_workflow_list')
    expect(listed.structuredContent.data).toMatchObject({
      workflows: [{ name: 'ping', latestRevision: 1, enabled: null }],
      changes: [
        { workflowName: 'ping', action: 'disable', revision: null, actorId: HUMAN_B },
        { workflowName: 'ping', action: 'enable', revision: 1, actorId: HUMAN_A },
        { workflowName: 'ping', action: 'publish', revision: 1, actorId: HUMAN_A },
      ],
    })
    expect(
      gateway.connections.every((c) => c.closeCode === undefined || c.closeCode === 4000),
    ).toBe(true)
  }, 30_000)

  it('keep answering when another workflow of the same bot crashes on the same event', async () => {
    const { agent, calls, identifiedWith, log } = await platform()
    const asA = await agent(HUMAN_A)
    const grants = { families: ['message'] }
    await asA('discord_workflow_publish', {
      name: 'hog',
      source: `
        import { Client } from 'discord.js'
        const client = new Client({ intents: [1, 512, 32768] })
        client.on('messageCreate', () => { const a = []; for (;;) a.push(new Array(1e6).fill(1)) })`,
      grants,
    })
    await asA('discord_workflow_publish', { name: 'ping', source: PING_PONG, grants })
    await asA('discord_workflow_enable', { name: 'hog' })
    await asA('discord_workflow_enable', { name: 'ping' })
    const connection = await identifiedWith(PING_INTENTS | VOICE_INTENTS)
    const pongs = () => calls.filter((call) => call.route === `/channels/${CHANNEL}/messages`)

    connection.send(message(2, 'ping'))
    connection.send(message(3, 'ping'))

    await vi.waitFor(() => expect(pongs()).toHaveLength(2), { timeout: 20_000 })
    // The hog now runs beside the other workflow rather than ahead of it, so it fails later.
    await vi.waitFor(
      () =>
        expect(log).toHaveBeenCalledWith(
          expect.stringContaining('Workflow hog (revision 1) of bot'),
        ),
      { timeout: 20_000 },
    )
  }, 30_000)
})

describe('workflow state and logs', () => {
  it('count messages in KV, and show agents each run without its tokens', async () => {
    const { agent, calls, identifiedWith, log } = await platform()
    const asA = await agent(HUMAN_A)
    await asA('discord_workflow_publish', {
      name: 'counter',
      source: `
        import { Client } from 'discord.js'
        import { kv } from 'textile'

        const client = new Client({ intents: [1, 512, 32768] })

        client.on('messageCreate', async (message) => {
          if (message.content === 'shout') throw new Error('x'.repeat(100000))
          if (message.content === 'hoard') {
            await kv.set('a', 'x'.repeat(600000))
            await kv.set('b', 'x'.repeat(600000))
          }
          const count = ((await kv.get('count')) ?? 0) + 1
          await kv.set('count', count)
          console.log('message', count)
          if (message.content === 'count') await message.reply(String(count))
        })

        client.on('interactionCreate', async (interaction) => {
          const channel = await client.rest.get('/channels/' + interaction.channelId)
          console.log(interaction.token, JSON.stringify(channel))
          await kv.set('.', 'dot')
          const refused = await kv.get(interaction.token + '\\0').catch((error) => error.message)
          console.log(await kv.get('.'), refused, 'nul\\0 lone\\uD800')
          throw new Error('failed with ' + interaction.token)
        })`,
      grants: { families: ['message', 'channel'] },
    })
    await asA('discord_workflow_enable', { name: 'counter' })
    const connection = await identifiedWith(PING_INTENTS)

    connection.send(message(2, 'one'))
    connection.send(message(3, 'hoard'))
    connection.send(message(4, 'count'))
    connection.send(slashCommand(5))
    connection.send(message(6, 'shout'))

    // The run past the limit stored nothing and counted nothing.
    await vi.waitFor(
      () =>
        expect(calls).toContainEqual(
          expect.objectContaining({
            route: `/channels/${CHANNEL}/messages`,
            body: expect.objectContaining({ content: '2' }),
          }),
        ),
      { timeout: 20_000 },
    )
    type Runs = {
      runs: Array<{ event: string; outcome: string; error: string | null; logs: string[] }>
    }
    const runs = async (args: Record<string, unknown> = {}) =>
      (await asA('discord_workflow_logs', args)).structuredContent.data as Runs
    await vi.waitFor(async () => expect((await runs()).runs).toHaveLength(5), { timeout: 20_000 })

    expect((await runs({ name: 'counter', limit: 1 })).runs).toHaveLength(1)
    const failed = await runs({ failed: true })
    expect(failed.runs).toHaveLength(3)
    // A listener's error is cut like its logs, however long the message it throws.
    expect(failed.runs).toContainEqual(
      expect.objectContaining({ error: `Error: ${'x'.repeat(16_377)} [truncated]` }),
    )
    expect(failed.runs).toContainEqual(
      expect.objectContaining({
        event: 'MESSAGE_CREATE',
        outcome: 'threw',
        error: expect.stringContaining('past its limit of 1048576'),
      }),
    )
    expect(failed.runs).toContainEqual(
      expect.objectContaining({
        event: 'INTERACTION_CREATE',
        outcome: 'threw',
        error: 'Error: failed with [redacted]',
        logs: [
          `[redacted] {"id":"${CHANNEL}","type":0,"echo":"[redacted]"}`,
          // Keys URL parsing would drop, and text Postgres refuses, both still work.
          'dot A KV key is a non-empty string without NUL characters. nul\uFFFD lone\uFFFD',
        ],
      }),
    )
    const everything = JSON.stringify([await runs(), log.mock.calls])
    expect(everything).not.toContain(INTERACTION_TOKEN)
    expect(everything).not.toContain(TOKEN)
  }, 60_000)
})

describe("a bot's shared limiter", () => {
  it("keeps a reset token's late failures from blocking its successor", async () => {
    const [retired, current] = [botToken(BOT.id, 'retired'), botToken(BOT.id, 'current')]
    const reached: string[] = []
    // Discord rejects the retired token and accepts its successor.
    const discordFetch: typeof fetch = async (_url, init) => {
      const token = new Headers(init?.headers).get('authorization')?.replace(/^Bot /, '') ?? ''
      reached.push(token)
      return token === retired
        ? Response.json({ message: '401: Unauthorized', code: 0 }, { status: 401 })
        : Response.json({ id: CHANNEL })
    }
    const limiters = createBotLimiters(
      { timeoutMs: 1000, retries: 0, maxRateLimitWaitMs: 0 },
      discordFetch,
    )
    const call = (token: string) => {
      const { client, release } = limiters.lend(BOT.id, Redacted.make(token))
      return Effect.runPromiseExit(
        client.request({
          method: 'GET',
          route: `/channels/${CHANNEL}`,
          operationFamily: 'channel',
        }),
      ).finally(release)
    }

    // A workflow run queued before the reset keeps failing with the old token.
    for (let i = 0; i < 30; i += 1) await call(retired)
    const blocked = reached.filter((token) => token === retired).length

    expect(blocked).toBeLessThan(30)
    expect((await call(current))._tag).toBe('Success')
    expect(reached.at(-1)).toBe(current)
  })
})
