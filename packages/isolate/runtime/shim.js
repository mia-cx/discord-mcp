// "discord.js" as a script sees it: the real package, with a Client that never connects.
// The bundler aliases `discord.js-real` to the installed package.
import * as real from 'discord.js-real'

export * from 'discord.js-real'

/** Stands in for the bot token inside the isolate. The broker replays calls with the real one. */
const PLACEHOLDER_TOKEN = 'textile-broker'

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
  }

  /** Never opens a Gateway connection. */
  async login() {
    return PLACEHOLDER_TOKEN
  }
}
