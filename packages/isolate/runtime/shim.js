// "discord.js" as agent code sees it: the real package, with a Client that never connects.
// The bundler aliases `discord.js-real` to the installed package.
import * as real from 'discord.js-real'

export * from 'discord.js-real'

/** Stands in for the bot token inside the isolate. The broker replays calls with the real one. */
const PLACEHOLDER_TOKEN = 'textile-broker'
/** The broker hands Gateway commands sent here, such as presence updates, to the bot host. */
const GATEWAY_URL = 'https://gateway.textile.internal/'

/**
 * What the entry module reads back: every client agent code created, the events discord.js itself
 * listens for on each, and what listeners returned, so a run waits for async handlers and reports
 * their errors.
 */
export const textile = { clients: [], ownEvents: new WeakMap(), pending: [] }

const sendToGateway = async (packet) => {
  const response = await fetch(GATEWAY_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(packet),
  })
  if (!response.ok) throw new Error((await response.json()).message)
}

export class Client extends real.Client {
  constructor(options) {
    // workerd forbids timers in global scope, so every sweeper interval is zeroed.
    const sweepers = Object.fromEntries(
      Object.entries({ ...real.Options.DefaultSweeperSettings, ...options?.sweepers }).map(
        ([key, value]) => [key, { ...value, interval: 0 }],
      ),
    )
    super({
      ...options,
      sweepers,
      // The broker owns retries. A 429 it returns is still waited out here, per Retry-After.
      rest: { ...options?.rest, retries: 0, hashSweepInterval: 0, handlerSweepInterval: 0 },
    })
    this.token = PLACEHOLDER_TOKEN
    this.rest.setToken(PLACEHOLDER_TOKEN)
    // With no Gateway, no guild is cached, and discord.js drops a fetched guild channel whose guild
    // it has not seen. Keep it instead; it works by ID.
    const fetchChannel = this.channels.fetch.bind(this.channels)
    this.channels.fetch = (id, options) => fetchChannel(id, { allowUnknownGuild: true, ...options })
    // Ready, so discord.js handles forwarded events at once instead of queueing them.
    this.ws.status = real.Status.Ready
    // The bot host holds the Gateway connection and sends commands, like setPresence, for it.
    this.ws.broadcast = (packet) => textile.pending.push(sendToGateway(packet))
    textile.clients.push(this)
    textile.ownEvents.set(this, new Set(this.eventNames()))
  }

  /** Never opens a Gateway connection. */
  async login() {
    return PLACEHOLDER_TOKEN
  }

  emit(event, ...args) {
    const listeners = this.rawListeners(event)
    // Keeps EventEmitter's own handling of an unheard event, such as throwing an unheard 'error'.
    if (listeners.length === 0) return super.emit(event, ...args)
    for (const listener of listeners) {
      try {
        textile.pending.push(Promise.resolve(listener.apply(this, args)))
      } catch (error) {
        textile.pending.push(Promise.reject(error))
      }
    }
    return true
  }
}

/** For `import Discord from 'discord.js'`, which Node also allows. */
export default { ...real, Client }
