import { createHash, timingSafeEqual } from 'node:crypto'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { Duplex } from 'node:stream'
import { type Execute, json } from './relay.ts'
import { botIdFromToken, ownerOf } from './router.ts'
import { refuseUpgrade, VOICE_PATH, type VoiceUpgrade } from './voice.ts'

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

/**
 * The Discord user ID of the human whose login central checked. Central always replaces it, so a
 * client can't name someone else, and a bot host reads it only from requests carrying the secret.
 */
const ACTOR_HEADER = 'x-discord-mcp-actor'

/** Retry soon: the bot's owner is unreachable or the hosts are changing. */
const moving = (error: string) => json(503, { error }, { 'retry-after': '1' })

/**
 * Central's executor: send each request to the bot host that owns its bot. The relay credential
 * stops here; the host gets the bot token and this tier's secret instead.
 */
export const forwardToBotHosts =
  ({ hosts, secret }: Membership): Execute =>
  async (request, _credential, botId, actorId) => {
    const owner = ownerOf(hosts, botId)
    if (owner === undefined) return moving('bot_host_unavailable')
    const headers = new Headers(request.headers)
    for (const name of NOT_FORWARDED) headers.delete(name)
    headers.delete(ACTOR_HEADER)
    if (actorId !== undefined) headers.set(ACTOR_HEADER, actorId)
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

/**
 * Central's voice sockets: each goes to the bot host that owns its bot, which answers the upgrade
 * and then carries the socket. Central only relays the bytes.
 */
export const forwardVoiceToBotHosts =
  ({ hosts, secret }: Membership): VoiceUpgrade =>
  (request, socket, head, _credential, botId) => {
    const owner = ownerOf(hosts, botId)
    if (owner === undefined) return void refuseUpgrade(socket, moving('bot_host_unavailable'))
    // The upgrade's own headers go along, so the host can complete the WebSocket handshake.
    const { host: _, cookie: __, [ACTOR_HEADER]: ___, ...headers } = request.headers
    const send = owner.startsWith('https:') ? httpsRequest : httpRequest
    const upstream = send(`${owner}${request.url ?? VOICE_PATH}`, {
      headers: { ...headers, authorization: `Bearer ${secret}` },
    })
    upstream.on('upgrade', (response: IncomingMessage, hostSocket: Duplex, hostHead: Buffer) => {
      const lines = [`HTTP/1.1 101 ${response.statusMessage ?? 'Switching Protocols'}`]
      for (let at = 0; at < response.rawHeaders.length; at += 2) {
        lines.push(`${response.rawHeaders[at]}: ${response.rawHeaders[at + 1]}`)
      }
      socket.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (hostHead.length > 0) socket.write(hostHead)
      if (head.length > 0) hostSocket.write(head)
      hostSocket.on('error', () => socket.destroy())
      socket.on('close', () => hostSocket.destroy())
      hostSocket.on('close', () => socket.destroy())
      hostSocket.pipe(socket).pipe(hostSocket)
    })
    upstream.on('response', (response: IncomingMessage) => {
      // The host refused central's secret, not the caller's login; see `forwardToBotHosts`.
      if (response.statusCode === 401) {
        response.resume()
        return void refuseUpgrade(socket, json(502, { error: 'bot_host_rejected_central' }))
      }
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => {
        const headers = new Headers({ 'cache-control': 'no-store' })
        const type = response.headers['content-type']
        if (type !== undefined) headers.set('content-type', type)
        const retryAfter = response.headers['retry-after']
        if (retryAfter !== undefined) headers.set('retry-after', retryAfter)
        void refuseUpgrade(
          socket,
          new Response(Buffer.concat(chunks), { status: response.statusCode ?? 502, headers }),
        )
      })
    })
    upstream.on('error', () => void refuseUpgrade(socket, moving('bot_host_unavailable')))
    upstream.end()
  }

const digest = (value: string) => createHash('sha256').update(value).digest()

/**
 * A bot host's internal endpoint. It answers only central, and only for bots it owns, so one bot's
 * REST traffic always meets one rate limiter. `upgrade` takes over voice sockets for those bots.
 */
export const createBotHost = (
  { hosts, secret, self }: Membership & { readonly self: string },
  execute: Execute,
  upgrade?: VoiceUpgrade,
) => {
  const expected = digest(`Bearer ${secret}`)
  /** Central's credential and the bot's owner, or why this host won't serve the request. */
  const admit = (headers: Headers) => {
    if (!timingSafeEqual(digest(headers.get('authorization') ?? ''), expected)) {
      return json(401, { error: 'unauthorized' })
    }
    const credential = headers.get('x-discord-bot-token') ?? ''
    const botId = botIdFromToken(credential)
    if (botId === undefined) return json(403, { error: 'invalid_bot_token' })
    // A central replica with another host list routed it here; its owner will take the retry.
    if (ownerOf(hosts, botId) !== self) return moving('bot_moved')
    return { credential, botId }
  }
  return {
    fetch: async (request: Request): Promise<Response> => {
      const url = new URL(request.url)
      if (url.pathname === '/health/live' || url.pathname === '/health/ready') {
        return json(200, { ok: true })
      }
      if (url.pathname !== '/mcp') return json(404, { error: 'not_found' })
      const admitted = admit(request.headers)
      if (admitted instanceof Response) return admitted
      const { credential, botId } = admitted
      return execute(request, credential, botId, request.headers.get(ACTOR_HEADER) ?? undefined)
    },
    /** Serves voice sockets central forwards; attach it to the HTTP server's `upgrade` event. */
    upgrade: (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      socket.on('error', () => socket.destroy())
      const { pathname } = new URL(request.url ?? '/', 'http://bot-host')
      if (pathname !== VOICE_PATH || upgrade === undefined) {
        return void refuseUpgrade(socket, json(404, { error: 'not_found' }))
      }
      const headers = new Headers()
      for (const name of ['authorization', 'x-discord-bot-token']) {
        const value = request.headers[name]
        if (typeof value === 'string') headers.set(name, value)
      }
      const admitted = admit(headers)
      if (admitted instanceof Response) return void refuseUpgrade(socket, admitted)
      upgrade(request, socket, head, admitted.credential, admitted.botId)
    },
  }
}
