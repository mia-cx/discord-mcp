import { createBotRuntimes, createTokenVault } from '@discord-mcp/bot-host'
import { fakeGateway, manualClock } from '@discord-mcp/bot-host/testing'
import { DiscordRest, OperationCatalog } from '@discord-mcp/discord-api'
import { makeIsolateHost, makeWorkflowHost, type WorkflowHost } from '@discord-mcp/isolate'
import { inMemoryStorage } from '@discord-mcp/storage/testing'
import { Effect, Layer, Redacted } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRelay } from '../src/relay.ts'
import { config, discordOAuth, login } from './login-fixture.ts'

const TOKEN = 'private-bot-token'
const BOT = { id: '345678901234567890', username: 'textile', discriminator: '0', bot: true }
const GUILD = '223456789012345678'
const CHANNEL = '123456789012345678'
const HUMAN_A = '234567890123456789'
const HUMAN_B = '234567890123456780'
const HOUR = 60 * 60 * 1000
/** Guilds, GuildMessages, and MessageContent. */
const PING_INTENTS = 1 | (1 << 9) | (1 << 15)
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

const cleanup: Array<() => unknown> = []
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})

/**
 * The relay and bot host in one process, against a fake Discord: REST behind the relay's seam,
 * the Gateway on a local socket, and a clock that moves only when told to.
 */
const platform = async () => {
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
  const rest = (credential: Redacted.Redacted<string>) =>
    Layer.succeed(DiscordRest)({
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
          if (call.route.endsWith('/callback')) return new ArrayBuffer(0)
          return sent((call.body as { content?: unknown } | undefined)?.content)
        }),
    })
  let workflows: WorkflowHost | undefined
  const bots = createBotRuntimes({
    vault: createTokenVault(Buffer.alloc(32, 1), storage),
    clock,
    log,
    gatewayUrl: gateway.url,
    onEvent: (event) => workflows?.dispatch(event),
  })
  const catalog = await Effect.runPromise(Effect.provide(OperationCatalog, OperationCatalog.layer))
  workflows = makeWorkflowHost({
    storage,
    isolates: makeIsolateHost(),
    bots,
    operations: catalog.all,
    rest,
    log,
  })
  const oauth = discordOAuth()
  const relay = createRelay(
    { ...config, login: { ...config.login, allowedUserIds: [HUMAN_A, HUMAN_B] } },
    rest,
    oauth.fetch,
    { bots, workflows },
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

  /** The Gateway connection that identified with `intents`, once the shard has reconnected. */
  const identifiedWith = async (intents: number) => {
    clock.advance(60_000)
    return vi.waitFor(() => {
      const connection = gateway.connections.find((c) =>
        c.received.some((p) => p.op === 2 && (p.d as { intents: number }).intents === intents),
      )
      if (connection === undefined) throw new Error(`No identify with intents ${intents}.`)
      return connection
    })
  }

  return { agent, calls, clock, discord, gateway, identifiedWith, log }
}

describe('workflows', () => {
  it('answer Gateway events while no agent is connected, and record who changed them', async () => {
    const { agent, calls, clock, discord, gateway, identifiedWith } = await platform()
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
    const connection = await identifiedWith(PING_INTENTS)

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

    connection.send({
      op: 0,
      s: 3,
      t: 'INTERACTION_CREATE',
      d: {
        id: '700000000000000001',
        application_id: BOT.id,
        type: 2,
        token: 'interaction-token',
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
    const connection = await identifiedWith(PING_INTENTS)
    const pongs = () => calls.filter((call) => call.route === `/channels/${CHANNEL}/messages`)

    connection.send(message(2, 'ping'))
    connection.send(message(3, 'ping'))

    await vi.waitFor(() => expect(pongs()).toHaveLength(2), { timeout: 20_000 })
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Workflow hog (revision 1) of bot'))
  }, 30_000)
})
