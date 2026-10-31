import { describe, expect, it } from 'vitest'
import { prepareScript } from '../src/bundle.ts'
import { type GatewayEvent, makeIsolateHost } from '../src/isolate-host.ts'

const BOT = { id: '345678901234567890', username: 'textile', discriminator: '0', bot: true }
const USER = { id: '456789012345678901', username: 'mia', discriminator: '0' }
const GUILD = '223456789012345678'
const CHANNEL = '123456789012345678'
const APPLICATION = '345678901234567890'

/** A plain discord.js bot, as an agent writes it. */
const WORKFLOW = `
import { Client, Events, GatewayIntentBits } from 'discord.js'

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
})

client.on(Events.MessageCreate, async (message) => {
  if (message.content === 'ping') await message.reply('pong')
  if (message.content === 'status') client.user.setPresence({ activities: [{ name: 'tests' }], status: 'idle' })
  if (message.content === 'throw') throw new Error('handler failed')
})

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'hello') return
  await interaction.deferReply()
  await interaction.editReply('hello ' + interaction.options.getString('who'))
  await interaction.followUp('and goodbye')
})

client.login(process.env.DISCORD_TOKEN)
`

const message = (content: string): GatewayEvent => ({
  t: 'MESSAGE_CREATE',
  d: {
    id: '900000000000000001',
    channel_id: CHANNEL,
    guild_id: GUILD,
    author: USER,
    content,
    timestamp: '2026-10-31T00:00:00.000Z',
    edited_timestamp: null,
    tts: false,
    mention_everyone: false,
    mentions: [],
    mention_roles: [],
    attachments: [],
    embeds: [],
    pinned: false,
    type: 0,
  },
})

const slashCommand: GatewayEvent = {
  t: 'INTERACTION_CREATE',
  d: {
    id: '700000000000000001',
    application_id: APPLICATION,
    type: 2,
    token: 'interaction-token',
    version: 1,
    guild_id: GUILD,
    channel_id: CHANNEL,
    channel: { id: CHANNEL, type: 0 },
    member: { user: USER, roles: [], permissions: '0', joined_at: '2026-01-01T00:00:00.000Z' },
    app_permissions: '0',
    locale: 'en-US',
    entitlements: [],
    authorizing_integration_owners: {},
    data: {
      id: '800000000000000001',
      name: 'hello',
      type: 1,
      options: [{ name: 'who', type: 3, value: 'world' }],
    },
  },
}

const sentMessage = (content: string) => ({
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

/** Run the workflow once in workerd, recording every request its broker receives. */
const run = async (input: { event: GatewayEvent } | { probe: true }) => {
  const requests: Array<{ method: string; url: string; auth: string | null; body: unknown }> = []
  const outcome = await makeIsolateHost().run({
    queue: BOT.id,
    botUser: BOT,
    modules: await prepareScript(WORKFLOW),
    timeoutMs: 10_000,
    input,
    broker: async (request) => {
      const text = await request.text()
      requests.push({
        method: request.method,
        url: request.url,
        auth: request.headers.get('authorization'),
        body: text === '' ? undefined : JSON.parse(text),
      })
      if (request.url.includes('/callback') || request.url.includes('gateway')) {
        return new Response(null, { status: 204 })
      }
      return Response.json(sentMessage((JSON.parse(text) as { content: string }).content))
    },
  })
  return { outcome, requests }
}

describe('the discord.js shim', () => {
  it('reports the events and intents a workflow declares', async () => {
    const { outcome } = await run({ probe: true })

    expect(outcome).toEqual({
      outcome: 'completed',
      // Guilds, GuildMessages, and MessageContent.
      result: { events: ['messageCreate', 'interactionCreate'], intents: 1 | 512 | 32768 },
      logs: [],
    })
  })

  it('answers a forwarded message with message.reply', async () => {
    const { outcome, requests } = await run({ event: message('ping') })

    expect(outcome.outcome).toBe('completed')
    expect(requests).toEqual([
      {
        method: 'POST',
        url: `https://discord.com/api/v10/channels/${CHANNEL}/messages`,
        auth: 'Bot textile-broker',
        body: expect.objectContaining({
          content: 'pong',
          message_reference: expect.objectContaining({ message_id: '900000000000000001' }),
        }),
      },
    ])
  })

  it('defers, edits, and follows up a slash command through its interaction token', async () => {
    const { outcome, requests } = await run({ event: slashCommand })

    expect(outcome.outcome).toBe('completed')
    expect(requests.map(({ method, url, auth }) => [method, url.split('?')[0], auth])).toEqual([
      [
        'POST',
        'https://discord.com/api/v10/interactions/700000000000000001/interaction-token/callback',
        null,
      ],
      [
        'PATCH',
        `https://discord.com/api/v10/webhooks/${APPLICATION}/interaction-token/messages/%40original`,
        null,
      ],
      ['POST', `https://discord.com/api/v10/webhooks/${APPLICATION}/interaction-token`, null],
    ])
    expect(requests.map((request) => request.body)).toEqual([
      { type: 5, data: expect.anything() },
      expect.objectContaining({ content: 'hello world' }),
      expect.objectContaining({ content: 'and goodbye' }),
    ])
  })

  it('sends setPresence to the Gateway route', async () => {
    const { outcome, requests } = await run({ event: message('status') })

    expect(outcome.outcome).toBe('completed')
    expect(requests).toEqual([
      {
        method: 'POST',
        url: 'https://gateway.textile.internal/',
        auth: null,
        body: {
          op: 3,
          d: { status: 'idle', afk: false, since: null, activities: [{ name: 'tests', type: 0 }] },
        },
      },
    ])
  })

  it('reports a listener that throws', async () => {
    const { outcome } = await run({ event: message('throw') })

    expect(outcome).toEqual({
      outcome: 'threw',
      error: { name: 'Error', message: 'handler failed' },
      logs: [],
    })
  })

  /** Every event a workflow may listen for, each with a default-options client, as most are written. */
  const LOGGER = `
import { Client } from 'discord.js'
const client = new Client({ intents: [] })
for (const name of ['messageCreate', 'messageUpdate', 'messageDelete', 'messageReactionAdd', 'messageReactionRemove', 'guildMemberAdd', 'guildMemberRemove']) {
  client.on(name, () => console.log(name))
}
`
  const reaction = {
    user_id: USER.id,
    channel_id: CHANNEL,
    message_id: '900000000000000001',
    guild_id: GUILD,
    emoji: { id: null, name: '👍' },
  }
  it.each([
    ['messageCreate', message('hi')],
    ['messageCreate', { t: 'MESSAGE_CREATE', d: { ...message('hi').d, guild_id: undefined } }],
    [
      'messageUpdate',
      {
        t: 'MESSAGE_UPDATE',
        d: { ...message('edited').d, edited_timestamp: '2026-10-31T00:00:02.000Z' },
      },
    ],
    [
      'messageDelete',
      {
        t: 'MESSAGE_DELETE',
        d: { id: '900000000000000001', channel_id: CHANNEL, guild_id: GUILD },
      },
    ],
    [
      'messageDelete',
      { t: 'MESSAGE_DELETE', d: { id: '900000000000000001', channel_id: CHANNEL } },
    ],
    ['messageReactionAdd', { t: 'MESSAGE_REACTION_ADD', d: reaction }],
    ['messageReactionRemove', { t: 'MESSAGE_REACTION_REMOVE', d: reaction }],
    [
      'guildMemberAdd',
      {
        t: 'GUILD_MEMBER_ADD',
        d: { guild_id: GUILD, user: USER, roles: [], joined_at: '2026-10-31T00:00:00.000Z' },
      },
    ],
    ['guildMemberRemove', { t: 'GUILD_MEMBER_REMOVE', d: { guild_id: GUILD, user: USER } }],
  ] as const)('delivers %s with no cache and default options (%#)', async (name, event) => {
    const outcome = await makeIsolateHost().run({
      queue: BOT.id,
      botUser: BOT,
      modules: await prepareScript(LOGGER),
      timeoutMs: 10_000,
      input: { event: event as GatewayEvent },
      broker: async () => new Response(null, { status: 404 }),
    })

    expect(outcome).toEqual({ outcome: 'completed', result: null, logs: [name] })
  })

  /** Fetches the DM channel of each event, as the partial-object guidance says to. */
  const DM_FETCHER = `
import { Client } from 'discord.js'
const client = new Client({ intents: [] })
client.on('messageDelete', (message) => message.channel.fetch())
client.on('messageReactionAdd', (reaction) => reaction.message.channel.fetch())
`
  const dmReaction = (userId: string) => ({
    t: 'MESSAGE_REACTION_ADD',
    d: {
      user_id: userId,
      channel_id: CHANNEL,
      message_id: '900000000000000001',
      emoji: { id: null, name: '👍' },
    },
  })
  it.each([
    [
      'a deleted DM, which names nobody',
      { t: 'MESSAGE_DELETE', d: { id: '900000000000000001', channel_id: CHANNEL } },
      `GET https://discord.com/api/v10/channels/${CHANNEL}`,
    ],
    [
      "the bot's own DM reaction",
      dmReaction(BOT.id),
      `GET https://discord.com/api/v10/channels/${CHANNEL}`,
    ],
    [
      "a user's DM reaction",
      dmReaction(USER.id),
      'POST https://discord.com/api/v10/users/@me/channels',
    ],
  ])('fetches the DM channel of %s by the route Discord needs', async (_, event, request) => {
    const requests: string[] = []
    const outcome = await makeIsolateHost().run({
      queue: BOT.id,
      botUser: BOT,
      modules: await prepareScript(DM_FETCHER),
      timeoutMs: 10_000,
      input: { event: event as GatewayEvent },
      broker: async (incoming) => {
        requests.push(`${incoming.method} ${incoming.url}`)
        return Response.json({ id: CHANNEL, type: 1, recipients: [USER] })
      },
    })

    expect(outcome.outcome).toBe('completed')
    expect(requests).toEqual([request])
  })
})
