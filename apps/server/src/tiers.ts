import { createHash, timingSafeEqual } from 'node:crypto'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { Duplex } from 'node:stream'
import type { BotRuntimes } from '@discord-mcp/bot-host'
import {
  type GatewayEvent,
  type RouteRequest,
  routePath,
  type WorkflowEvent,
  type WorkflowHost,
} from '@discord-mcp/isolate'
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

/** How long after a workflow event arrives a bot host keeps offering it to the bot's REST owner. */
const DISPATCH_DEADLINE_MS = 60_000
const DISPATCH_RETRY_MS = 1_000
/** How long one offer to another host may take. */
const DISPATCH_TIMEOUT_MS = 5_000

/**
 * A bot host's router for the workflow events its shards receive. Each runs on the bot's REST
 * owner, on the bot's one rate limiter: here once this host holds the bot's lease, else sent to
 * the owner's `/dispatch`. A bot's events go one at a time, in order; one its owner can't take
 * yet is offered again each second until a minute after it arrived, then dropped, so an owner
 * that is down holds up at most a minute of events.
 */
export const routeDispatches = (
  { hosts, secret, self }: Membership & { readonly self: string },
  local: {
    readonly bots: Pick<BotRuntimes, 'own'>
    readonly workflows: Pick<WorkflowHost, 'dispatch'>
  },
  log: (message: string) => void,
  deadlineMs = DISPATCH_DEADLINE_MS,
) => {
  const queues = new Map<string, Promise<void>>()
  /** Run or send the event. Resolves `undefined` once its owner took it, or why it didn't. */
  const offer = async (
    event: WorkflowEvent,
  ): Promise<{ readonly failure: string; readonly retry: boolean } | undefined> => {
    const owner = ownerOf(hosts, event.botId)
    if (owner === self) {
      // Its previous owner, on an older list, still serves the bot until it restarts.
      if (!(await local.bots.own(event.botId))) return { failure: 'is another host', retry: true }
      local.workflows.dispatch(event)
      return undefined
    }
    const response = await fetch(`${owner}/dispatch`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${secret}`,
        'x-discord-bot-token': event.token,
        'content-type': 'application/json',
      },
      body: JSON.stringify(event.dispatch),
      redirect: 'error',
      signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
    })
    await response.body?.cancel()
    if (response.ok) return undefined
    // Only a moving owner is worth waiting for.
    return { failure: `answered ${response.status}`, retry: response.status === 503 }
  }
  /** Events dropped by bot since one last went through, so a long outage logs once. */
  const dropped = new Map<string, number>()
  const send = async (event: WorkflowEvent, deadline: number) => {
    let failure = 'took too long'
    for (let attempt = 0; Date.now() < deadline; attempt += 1) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, DISPATCH_RETRY_MS))
      const outcome = await offer(event).catch((cause: unknown) => ({
        failure: cause instanceof Error ? cause.message : String(cause),
        retry: true,
      }))
      if (outcome === undefined) {
        const count = dropped.get(event.botId) ?? 0
        if (count > 0) log(`Bot ${event.botId}'s REST owner is back; ${count} events were dropped.`)
        dropped.delete(event.botId)
        return
      }
      failure = outcome.failure
      if (!outcome.retry) break
    }
    const count = (dropped.get(event.botId) ?? 0) + 1
    dropped.set(event.botId, count)
    if (count === 1)
      log(`Dropped bot ${event.botId}'s ${event.dispatch.t}: its REST owner ${failure}.`)
  }
  return (event: WorkflowEvent) => {
    const deadline = Date.now() + deadlineMs
    const next = (queues.get(event.botId) ?? Promise.resolve()).then(() => send(event, deadline))
    queues.set(event.botId, next)
  }
}

/**
 * A bot host's internal endpoint. It answers only central and other bot hosts, and only for bots
 * it owns, so one bot's REST traffic, its workflows' included, always meets one rate limiter.
 * With `bots`, it also holds each bot's lease in Postgres while serving it, so two hosts on
 * different lists never both serve one bot. With `workflows`, it runs the workflow events other
 * hosts' shards forward to `/dispatch`. `upgrade` takes over voice sockets for those bots, and
 * `route` runs their workflow routes.
 */
export const createBotHost = (
  { hosts, secret, self }: Membership & { readonly self: string },
  execute: Execute,
  {
    bots,
    workflows,
    upgrade,
    route: serveRoute,
  }: OwnerRoutes & {
    readonly bots?: Pick<BotRuntimes, 'own'> | undefined
    readonly workflows?: Pick<WorkflowHost, 'dispatch'> | undefined
  } = {},
) => {
  const expected = digest(`Bearer ${secret}`)
  /** Central's credential and the bot's owner, or why this host won't serve the request. */
  const admit = async (headers: Headers) => {
    if (!timingSafeEqual(digest(headers.get('authorization') ?? ''), expected)) {
      return json(401, { error: 'unauthorized' })
    }
    const credential = headers.get('x-discord-bot-token') ?? ''
    const botId = botIdFromToken(credential)
    if (botId === undefined) return json(403, { error: 'invalid_bot_token' })
    return (await serving(botId)) ?? { credential, botId }
  }
  /** Why this host won't serve the bot now, if it won't. */
  const serving = async (botId: string) => {
    // A central replica with another host list routed it here; its owner will take the retry.
    if (ownerOf(hosts, botId) !== self) return moving('bot_moved')
    // Its previous owner, on an older list, still serves it until it restarts.
    const owned = bots === undefined || (await bots.own(botId).catch(() => undefined))
    if (owned === undefined) return moving('bot_host_unavailable')
    if (!owned) return moving('bot_moved')
    return undefined
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
        // Routes run workflows on the bot's REST limiter, so they wait for its lease too.
        const refused = await serving(route.botId)
        if (refused !== undefined) return refused
        if (serveRoute === undefined) return json(404, { error: 'not_found' })
        const inbound = (await request.json()) as RouteRequest
        return serveRoute(route.botId, route.name, inbound, request.signal)
      }
      if (url.pathname !== '/mcp' && url.pathname !== '/dispatch') {
        return json(404, { error: 'not_found' })
      }
      const admitted = await admit(request.headers)
      if (admitted instanceof Response) return admitted
      const { credential, botId } = admitted
      if (url.pathname === '/mcp') {
        return execute(request, credential, botId, request.headers.get(ACTOR_HEADER) ?? undefined)
      }
      if (workflows === undefined) return json(404, { error: 'not_found' })
      const dispatch: unknown = await request.json().catch(() => undefined)
      if (!isGatewayEvent(dispatch)) return json(400, { error: 'invalid_dispatch' })
      workflows.dispatch({ botId, token: credential, dispatch })
      return new Response(null, { status: 204 })
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
      admit(headers).then(
        (admitted) => {
          if (admitted instanceof Response) return void refuseUpgrade(socket, admitted)
          upgrade(request, socket, head, admitted.credential, admitted.botId)
        },
        () => socket.destroy(),
      )
    },
  }
}

const isGatewayEvent = (value: unknown): value is GatewayEvent =>
  typeof value === 'object' &&
  value !== null &&
  'd' in value &&
  typeof value.d === 'object' &&
  value.d !== null &&
  't' in value &&
  typeof value.t === 'string'
