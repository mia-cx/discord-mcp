import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import {
  ROUTE_BODY_LIMIT_BYTES,
  ROUTE_PREFIX,
  ROUTE_TIMEOUT_MS,
  type RouteRequest,
  WORKFLOW_NAME,
} from '@discord-mcp/isolate'
import { toNodeHandler } from '@modelcontextprotocol/node'
import { SNOWFLAKE } from './router.ts'

/**
 * Answers a request to the route of the bot's workflow `name`, on whichever host owns the bot.
 * `signal` aborts once the caller's deadline passes.
 */
export type ServeRoute = (
  botId: string,
  name: string,
  request: RouteRequest,
  signal: AbortSignal,
) => Promise<Response>

/** Hop-by-hop and framing headers, which `fetch` sets or rejects, and the caller's cookies. */
export const NOT_FORWARDED = [
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
 * A Node request's URL, built as the MCP adapter's `toWebRequest` builds it: from the client's
 * Host header and raw target, unvalidated. Routing decides on this, so it matches the handler.
 */
const requestUrl = (request: IncomingMessage) =>
  `http://${request.headers.host ?? 'localhost'}${request.url ?? '/'}`

/**
 * The Node request listener for `handler`. Workflow routes skip the MCP adapter, which reads the
 * whole body as text before the handler runs; everything else goes through it.
 */
export const nodeListener = (handler: { fetch: (request: Request) => Promise<Response> }) => {
  const mcp = toNodeHandler(handler)
  return (request: IncomingMessage, response: ServerResponse) => {
    // Decided on the URL the handler will see, so neither dot segments nor a malformed Host can
    // steer a route around the streamed path.
    if (URL.parse(requestUrl(request))?.pathname.startsWith(ROUTE_PREFIX)) {
      return void serveStreamed(handler, request, response)
    }
    void mcp(
      {
        method: request.method ?? 'GET',
        url: request.url ?? '/',
        headers: request.headers,
        [Symbol.asyncIterator]: () => request[Symbol.asyncIterator](),
      },
      response,
    )
  }
}

/**
 * Hand a Node request for a workflow route to `handler`. Streamed, a route applies its own size
 * limit and deadline to the upload and keeps its exact bytes. The caller hanging up aborts the
 * request.
 */
const serveStreamed = async (
  handler: { fetch: (request: Request) => Promise<Response> },
  request: IncomingMessage,
  response: ServerResponse,
) => {
  const hangUp = new AbortController()
  response.on('close', () => hangUp.abort())
  try {
    const headers = new Headers()
    for (const [name, value] of Object.entries(request.headers)) {
      for (const item of Array.isArray(value) ? value : [value ?? '']) headers.append(name, item)
    }
    const method = request.method ?? 'GET'
    const answer = await handler.fetch(
      new Request(requestUrl(request), {
        method,
        headers,
        signal: hangUp.signal,
        ...(method === 'GET' || method === 'HEAD'
          ? {}
          : { body: Readable.toWeb(request) as ReadableStream, duplex: 'half' }),
      }),
    )
    const body = Buffer.from(await answer.arrayBuffer())
    // An unread body would otherwise be parsed as the connection's next request.
    if (!request.complete) response.setHeader('connection', 'close')
    response.writeHead(answer.status, Object.fromEntries(answer.headers)).end(body)
  } catch {
    if (!response.headersSent) response.writeHead(400).end()
  }
}

/** How long a route's caller may take to send its body and get an answer: the run, plus a slot. */
const ROUTE_DEADLINE_MS = ROUTE_TIMEOUT_MS + 5_000

/** The bot and workflow a path names: `/workflows/<bot ID>/<name>`, or any path below it. */
export const routeOf = (pathname: string) => {
  if (!pathname.startsWith(ROUTE_PREFIX)) return undefined
  const [botId = '', name = ''] = pathname.slice(ROUTE_PREFIX.length).split('/')
  return SNOWFLAKE.test(botId) && WORKFLOW_NAME.test(name) ? { botId, name } : undefined
}

/**
 * The request's body, or why it was refused: past the size limit, or not sent in time. A late
 * upload is cancelled, which drops its connection.
 */
const readBody = async (request: Request, signal: AbortSignal) => {
  if (Number(request.headers.get('content-length') ?? 0) > ROUTE_BODY_LIMIT_BYTES) return 413
  if (request.body === null) return Buffer.alloc(0)
  const reader = request.body.getReader()
  const stop = () => void reader.cancel().catch(() => {})
  signal.addEventListener('abort', stop, { once: true })
  try {
    const chunks: Uint8Array[] = []
    let size = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (signal.aborted) return 408
      if (done) return Buffer.concat(chunks)
      size += value.byteLength
      if (size > ROUTE_BODY_LIMIT_BYTES) return 413
      chunks.push(value)
    }
  } finally {
    signal.removeEventListener('abort', stop)
    reader.releaseLock()
  }
}

/**
 * A route's answer as its caller sees it: the status, the body, and its type, nothing else.
 * Routes share the relay's origin, so a workflow can't set cookies or headers on it, and the
 * sandbox policy keeps a page it serves from scripting the relay.
 */
const publicResponse = (response: Response) => {
  const headers = new Headers({
    'cache-control': 'no-store',
    'content-security-policy': 'sandbox',
    'x-content-type-options': 'nosniff',
  })
  for (const name of ['content-type', 'retry-after']) {
    const value = response.headers.get(name)
    if (value !== null) headers.set(name, value)
  }
  return new Response(response.body, { status: response.status, headers })
}

/**
 * Serve an inbound workflow route. Callers are anonymous: the body is bounded, the whole exchange
 * has a deadline, and failures answer a bare status. `publicBaseUrl` gives the workflow the URL
 * its caller used, which some webhook signatures cover.
 */
export const handleRoute = async (
  request: Request,
  publicBaseUrl: string,
  serve: ServeRoute | undefined,
): Promise<Response> => {
  const url = new URL(request.url)
  const route = routeOf(url.pathname)
  if (route === undefined || serve === undefined) {
    return publicResponse(Response.json({ error: 'not_found' }, { status: 404 }))
  }
  const signal = AbortSignal.any([AbortSignal.timeout(ROUTE_DEADLINE_MS), request.signal])
  try {
    const body = await readBody(request, signal)
    if (typeof body === 'number') {
      return publicResponse(
        Response.json({ error: body === 413 ? 'body_too_large' : 'timed_out' }, { status: body }),
      )
    }
    const response = await serve(
      route.botId,
      route.name,
      {
        method: request.method,
        url: new URL(`${url.pathname}${url.search}`, publicBaseUrl).href,
        headers: [...request.headers].filter(([name]) => !NOT_FORWARDED.includes(name)),
        body: body.toString('base64'),
      },
      signal,
    )
    return publicResponse(response)
  } catch {
    return publicResponse(
      Response.json(
        { error: signal.aborted ? 'timed_out' : 'bad_request' },
        { status: signal.aborted ? 504 : 400 },
      ),
    )
  }
}
