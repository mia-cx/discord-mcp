// The isolate's main module. One request runs the agent's code once and reports what happened:
// a script's default export, a workflow's listeners for one Gateway event or schedule tick, or a
// probe of which events, intents, and schedules a workflow's clients declare.
// `discord.js` and `script.js` are CommonJS modules beside this one; importing them yields
// `module.exports`.
import { format } from 'node:util'
import discord from 'discord.js'

const { ChannelType, Client, ClientUser, textile } = discord

const LOG_LIMIT_CHARS = 64 * 1024
const LEVELS = ['debug', 'info', 'log', 'warn', 'error']

const captureConsole = () => {
  const lines = []
  let chars = 0
  for (const level of LEVELS) {
    console[level] = (...args) => {
      const line = level === 'log' ? format(...args) : `${level}: ${format(...args)}`
      chars += line.length
      if (chars <= LOG_LIMIT_CHARS) lines.push(line)
      else if (lines.at(-1) !== '[logs truncated]') lines.push('[logs truncated]')
    }
  }
  return lines
}

const describe = (error) =>
  error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: 'Error', message: String(error) }

/** Wait for every listener, including those that later ones trigger; throw the first failure. */
const settle = async () => {
  let failure
  while (textile.pending.length > 0) {
    for (const result of await Promise.allSettled(textile.pending.splice(0))) {
      if (result.status === 'rejected' && failure === undefined) failure = result
    }
  }
  if (failure !== undefined) throw failure.reason
}

/**
 * discord.js drops an event for a guild or channel it has not cached, and an isolate caches
 * nothing between events. So each event brings a stand-in for its own guild and channel.
 */
const seed = (client, data) => {
  if (data.guild_id === undefined) {
    if (data.channel_id !== undefined) seedDirectMessage(client, data)
    return
  }
  const guild = client.guilds._add({ id: data.guild_id, unavailable: true })
  const channel =
    data.channel ??
    (data.channel_id === undefined
      ? undefined
      : { id: data.channel_id, type: data.channel_type ?? ChannelType.GuildText })
  if (channel !== undefined) client.channels._add({ ...channel, guild_id: data.guild_id }, guild)
}

/**
 * A direct message's channel is the DM with the other user. The event names them when they acted;
 * when the bot acted, or nobody is named, as in a delete, the channel is fetched by ID instead.
 */
const seedDirectMessage = (client, data) => {
  const actor = data.author ?? data.user ?? (data.user_id && { id: data.user_id })
  const peer = actor && actor.id !== client.user.id ? actor : undefined
  const channel = client.channels._add({
    id: data.channel_id,
    type: ChannelType.DM,
    ...(peer ? { recipients: [peer] } : {}),
  })
  // discord.js fetches a DM through its recipient, which this channel does not know.
  if (peer === undefined)
    channel.fetch = (force = true) => client.channels.fetch(channel.id, { force })
}

const workflowClients = () => {
  if (textile.clients.length === 0) {
    throw new TypeError(
      'A workflow must create a discord.js Client at the top level and add its listeners there.',
    )
  }
  return textile.clients
}

/** Hand one Gateway event to each client the workflow created, as its own shard would. */
const deliver = async (event, user) => {
  for (const client of workflowClients()) {
    client.user = new ClientUser(client, user)
    seed(client, event.d)
    client.ws.handlePacket(event, { id: 0, status: client.ws.status })
  }
  await settle()
}

/** Hand one schedule tick to each client that declared its cron. */
const fire = async ({ cron, scheduledAt }, user) => {
  for (const client of workflowClients()) {
    client.user = new ClientUser(client, user)
    if (client.options.schedules?.includes(cron)) {
      client.emit('schedule', { cron, scheduledAt: new Date(scheduledAt) })
    }
  }
  await settle()
}

/** A client's own schedules, which only its own `schedule` listeners hear. */
const schedulesOf = (client) => {
  const schedules = client.options.schedules ?? []
  if (!Array.isArray(schedules)) {
    throw new TypeError("A Client's schedules option must be an array of cron expressions.")
  }
  const listening = client.listenerCount('schedule') > 0
  if (schedules.length > 0 && !listening) {
    throw new TypeError(
      "A Client declares schedules, but nothing listens for them: add client.on('schedule', (tick) => { ... }) on that Client.",
    )
  }
  if (schedules.length === 0 && listening) {
    throw new TypeError(
      "A Client listens for 'schedule', but declares no schedules: list cron expressions in its schedules option.",
    )
  }
  return schedules
}

const probe = () => {
  const clients = workflowClients()
  return {
    schedules: [...new Set(clients.flatMap(schedulesOf))],
    events: [
      ...new Set(
        clients.flatMap((client) =>
          client
            .eventNames()
            .filter((name) => typeof name === 'string' && !textile.ownEvents.get(client).has(name)),
        ),
      ),
    ],
    intents: clients.reduce((all, client) => all | client.options.intents.bitfield, 0),
  }
}

export default {
  async fetch(request) {
    const { user, event, tick, probe: probing } = await request.json()
    const logs = captureConsole()
    try {
      // Loaded here, not at the top, so a failing import is the agent's error, not workerd's.
      const script = (await import('./script.js')).default.default
      let result
      if (event !== undefined) result = await deliver(event, user)
      else if (tick !== undefined) result = await fire(tick, user)
      else if (probing) result = probe()
      else {
        if (typeof script !== 'function') {
          throw new TypeError(
            'The script must default-export a function: export default async ({ client }) => { ... }',
          )
        }
        const client = new Client({ intents: [] })
        client.user = new ClientUser(client, user)
        result = await script({ client })
        await settle()
      }
      // Stringified here so an unserializable result is the agent's error, not a crash.
      return new Response(JSON.stringify({ outcome: 'completed', result: result ?? null, logs }))
    } catch (error) {
      return Response.json({ outcome: 'threw', error: describe(error), logs })
    }
  },
}
