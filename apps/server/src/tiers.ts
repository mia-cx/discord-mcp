import { createHash, timingSafeEqual } from 'node:crypto'
import { type Execute, json } from './relay.ts'
import { botIdFromToken, ownerOf } from './router.ts'

/** Where bot hosts are, and the secret that proves a request came through central. */
export interface Membership {
  /** Every bot host's base URL, as `URL.origin`. Central and bot hosts list the same ones. */
  readonly hosts: ReadonlyArray<string>
  readonly secret: string
}

/** Hop-by-hop and framing headers, which `fetch` sets or rejects, and the caller's cookies. */
const NOT_FORWARDED = [
  'connection',
  'content-length',
  'cookie',
  'host',
  'keep-alive',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]

/** Retry soon: the bot's owner is unreachable or the hosts are changing. */
const moving = (error: string) => json(503, { error }, { 'retry-after': '1' })

/**
 * Central's executor: send each request to the bot host that owns its bot. The relay credential
 * stops here; the host gets the bot token and this tier's secret instead.
 */
export const forwardToBotHosts =
  ({ hosts, secret }: Membership): Execute =>
  async (request, _credential, botId) => {
    const owner = ownerOf(hosts, botId)
    if (owner === undefined) return moving('bot_host_unavailable')
    const headers = new Headers(request.headers)
    for (const name of NOT_FORWARDED) headers.delete(name)
    headers.set('authorization', `Bearer ${secret}`)
    try {
      const response = await fetch(`${owner}/mcp`, {
        method: request.method,
        headers,
        body: request.body,
        duplex: 'half',
        redirect: 'error',
        signal: request.signal,
      })
      // The host refused central's secret, not the caller's login. Passed on, a 401 would send
      // every client to log in again.
      if (response.status === 401) {
        await response.body?.cancel()
        return json(502, { error: 'bot_host_rejected_central' })
      }
      const returned = new Headers(response.headers)
      for (const name of NOT_FORWARDED) returned.delete(name)
      return new Response(response.body, { status: response.status, headers: returned })
    } catch {
      return moving('bot_host_unavailable')
    }
  }

const digest = (value: string) => createHash('sha256').update(value).digest()

/**
 * A bot host's internal endpoint. It answers only central, and only for bots it owns, so one bot's
 * REST traffic always meets one rate limiter.
 */
export const createBotHost = (
  { hosts, secret, self }: Membership & { readonly self: string },
  execute: Execute,
) => {
  const expected = digest(`Bearer ${secret}`)
  return {
    fetch: async (request: Request): Promise<Response> => {
      const url = new URL(request.url)
      if (url.pathname === '/health/live' || url.pathname === '/health/ready') {
        return json(200, { ok: true })
      }
      if (url.pathname !== '/mcp') return json(404, { error: 'not_found' })
      if (!timingSafeEqual(digest(request.headers.get('authorization') ?? ''), expected)) {
        return json(401, { error: 'unauthorized' })
      }
      const credential = request.headers.get('x-discord-bot-token') ?? ''
      const botId = botIdFromToken(credential)
      if (botId === undefined) return json(403, { error: 'invalid_bot_token' })
      // A central replica with another host list routed it here; its owner will take the retry.
      if (ownerOf(hosts, botId) !== self) return moving('bot_moved')
      return execute(request, credential, botId)
    },
  }
}
