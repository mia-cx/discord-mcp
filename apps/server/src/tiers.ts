import { createHash, timingSafeEqual } from 'node:crypto'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { Duplex } from 'node:stream'
import { type RouteRequest, routePath } from '@discord-mcp/isolate'
import { type Execute, json, type OwnerRoutes } from './relay.ts'
import { botIdFromToken, ownerOf } from './router.ts'
import { NOT_FORWARDED, routeOf, type ServeRoute } from './routes.ts'
import { refuseUpgrade, VOICE_PATH, type VoiceUpgrade } from './voice.ts'

/** Where bot hosts are, and the secret that proves a request came through central. */
export interface Membership {
  /** Every bot host's base URL, as `URL.origin`. Central and bot hosts list the same ones. */
  readonly hosts: ReadonlyArray<string>
  readonly secret: string
}

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
 * Central's side of workflow routes: send each request, already read and bounded, to the bot host
 * that owns its bot. The caller's request travels as JSON, so its own `Authorization` header and
 * the public URL reach the workflow unchanged beside this tier's secret.
 */
export const forwardRoutesToBotHosts =
  ({ hosts, secret }: Membership): ServeRoute =>
  async (botId, name, route, signal) => {
    const owner = ownerOf(hosts, botId)
    if (owner === undefined) return moving('bot_host_unavailable')
    try {
      return await fetch(`${owner}${routePath(botId, name)}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
        body: JSON.stringify(route),
        redirect: 'error',
        signal,
      })
    } catch (error) {
      if (signal.aborted) throw error
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
    // The agent left while its login was checked.
    if (socket.destroyed) return
    const owner = ownerOf(hosts, botId)
    if (owner === undefined) return void refuseUpgrade(socket, moving('bot_host_unavailable'))
    // The upgrade's own headers go along, so the host can complete the WebSocket handshake.
    const { host: _, cookie: __, [ACTOR_HEADER]: ___, ...headers } = request.headers
    const send = owner.startsWith('https:') ? httpsRequest : httpRequest
    const upstream = send(`${owner}${request.url ?? VOICE_PATH}`, {
      headers: { ...headers, authorization: `Bearer ${secret}` },
    })
    let hostSocket: Duplex | undefined
    // An agent that leaves, even while the host is still admitting it, takes the host's side down.
    socket.once('close', () => {
      upstream.destroy()
      hostSocket?.destroy()
    })
    upstream.on('upgrade', (response: IncomingMessage, upgraded: Duplex, hostHead: Buffer) => {
      hostSocket = upgraded
      if (socket.destroyed) return void upgraded.destroy()
      const lines = [`HTTP/1.1 101 ${response.statusMessage ?? 'Switching Protocols'}`]
      for (let at = 0; at < response.rawHeaders.length; at += 2) {
        lines.push(`${response.rawHeaders[at]}: ${response.rawHeaders[at + 1]}`)
      }
      socket.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (hostHead.length > 0) socket.write(hostHead)
      if (head.length > 0) upgraded.write(head)
      upgraded.on('error', () => socket.destroy())
      upgraded.on('close', () => socket.destroy())
      upgraded.pipe(socket).pipe(upgraded)
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
    upstream.on('error', () => {
      if (!socket.destroyed) void refuseUpgrade(socket, moving('bot_host_unavailable'))
    })
    upstream.end()
  }

const digest = (value: string) => createHash('sha256').update(value).digest()

/**
 * A bot host's internal endpoint. It answers only central, and only for bots it owns, so one bot's
 * REST traffic always meets one rate limiter. `upgrade` takes over voice sockets for those bots,
 * and `route` runs their workflow routes.
 */
export const createBotHost = (
  { hosts, secret, self }: Membership & { readonly self: string },
  execute: Execute,
  { upgrade, route: serveRoute }: OwnerRoutes = {},
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
      const route = routeOf(url.pathname)
      if (route !== undefined) {
        if (!timingSafeEqual(digest(request.headers.get('authorization') ?? ''), expected)) {
          return json(401, { error: 'unauthorized' })
        }
        if (ownerOf(hosts, route.botId) !== self) return moving('bot_moved')
        if (serveRoute === undefined) return json(404, { error: 'not_found' })
        const inbound = (await request.json()) as RouteRequest
        return serveRoute(route.botId, route.name, inbound, request.signal)
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
      // A request target no URL can hold must not throw at the listener.
      const pathname = URL.parse(request.url ?? '/', 'http://bot-host')?.pathname
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
