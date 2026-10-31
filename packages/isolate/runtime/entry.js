// The isolate's main module. One request runs the script once and reports what happened.
// `discord.js` and `script.js` are CommonJS modules beside this one; importing them yields
// `module.exports`.
import { format } from 'node:util'
import discord from 'discord.js'

const { Client, ClientUser } = discord

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

export default {
  async fetch(request) {
    const { user } = await request.json()
    const logs = captureConsole()
    try {
      // Loaded here, not at the top, so a failing import is the script's error, not workerd's.
      const script = (await import('./script.js')).default.default
      if (typeof script !== 'function') {
        throw new TypeError(
          'The script must default-export a function: export default async ({ client }) => { ... }',
        )
      }
      const client = new Client({ intents: [] })
      client.user = new ClientUser(client, user)
      const result = await script({ client })
      // Stringified here so an unserializable result is the script's error, not a crash.
      return new Response(JSON.stringify({ outcome: 'completed', result: result ?? null, logs }))
    } catch (error) {
      return Response.json({ outcome: 'threw', error: describe(error), logs })
    }
  },
}
