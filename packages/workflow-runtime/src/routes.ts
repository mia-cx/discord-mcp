import { createHmac, timingSafeEqual } from 'node:crypto'
import type { RouteAuth, WorkflowGrant } from '@discord-mcp/workflow-sdk'

/**
 * Dynamic public routes.
 *
 * Every workflow route lives beneath `/workflows/{slug}/`, without exception. A workflow that could
 * choose its own prefix could shadow `/mcp` or `/oauth/discord/callback`, and the failure mode is
 * a workflow that intercepts the control plane's own authentication.
 */

export const ROUTE_PREFIX = '/workflows'

/**
 * Paths the control plane owns.
 *
 * Listed for the error message rather than for the check — the check is that a workflow route is
 * *always* built from its own namespace, which no reserved list can be wrong about.
 */
export const RESERVED_PREFIXES: ReadonlyArray<string> = [
  '/mcp',
  '/discord',
  '/oauth',
  '/.well-known',
  '/health',
  '/metrics',
]

export interface RouteRejection {
  readonly reason: string
}

/** Normalize a workflow-declared path into its mounted form, or refuse it. */
export const mountPath = (
  slug: string,
  relativePath: string,
): { readonly path: string } | RouteRejection => {
  if (!relativePath.startsWith('/')) {
    return { reason: `Route path "${relativePath}" must start with "/".` }
  }

  // `..` is the whole attack: `/workflows/a/../../mcp` resolves outside the namespace, and a naive
  // prefix check would pass it.
  if (relativePath.includes('..')) {
    return {
      reason: `Route path "${relativePath}" contains "..", which would resolve outside this workflow's namespace.`,
    }
  }

  if (relativePath.includes('//') || /[\s?#]/.test(relativePath)) {
    return { reason: `Route path "${relativePath}" is not a plain path.` }
  }

  return { path: `${ROUTE_PREFIX}/${slug}${relativePath}` }
}

/** Split a mounted path back into the workflow it belongs to and the remainder. */
export const parseMountedPath = (
  path: string,
): { readonly slug: string; readonly rest: string } | undefined => {
  if (!path.startsWith(`${ROUTE_PREFIX}/`)) return undefined

  const remainder = path.slice(ROUTE_PREFIX.length + 1)
  const slash = remainder.indexOf('/')
  if (slash === -1) return { slug: remainder, rest: '/' }

  return { slug: remainder.slice(0, slash), rest: remainder.slice(slash) }
}

// ---------------------------------------------------------------- policy

export interface RequestFacts {
  readonly method: string
  readonly path: string
  readonly host: string | undefined
  readonly origin: string | undefined
  readonly sourceIp: string | undefined
  readonly headers: Readonly<Record<string, string>>
  readonly contentLength: number | undefined
}

export type PolicyOutcome =
  | { readonly allowed: true; readonly corsOrigin?: string }
  | { readonly allowed: false; readonly status: number; readonly reason: string }

const refuse = (status: number, reason: string): PolicyOutcome => ({
  allowed: false,
  status,
  reason,
})

/**
 * Everything checked before a body is read.
 *
 * Order matters: the size limit is applied to `Content-Length` here so an oversized request is
 * refused *before* buffering. Checking after would mean a workflow's `maxBodyBytes` protected
 * nothing — the memory is already spent by then.
 */
export const checkRoutePolicy = (input: {
  readonly grant: WorkflowGrant
  readonly request: RequestFacts
  readonly trustedSourceIp: string | undefined
}): PolicyOutcome => {
  const { grant, request } = input

  if (grant.routes.allowedHosts.length > 0) {
    if (request.host === undefined || !grant.routes.allowedHosts.includes(request.host)) {
      return refuse(404, `Host "${request.host ?? '(absent)'}" is not served by this route.`)
    }
  }

  if (grant.routes.allowedSourceCidrs.length > 0) {
    // Only forwarding data from a trusted proxy counts. An untrusted `X-Forwarded-For` is a
    // claim by the client about itself, and treating it as a source address makes the CIDR rule
    // trivially bypassable.
    const client = input.trustedSourceIp
    if (client === undefined) {
      return refuse(
        403,
        'This route restricts source addresses, but no trusted forwarding data identified the client. Configure TRUST_PROXY_IDENTITY and TRUSTED_PROXY_CIDRS, or remove the source restriction.',
      )
    }
    if (!grant.routes.allowedSourceCidrs.some((cidr) => withinCidr(client, cidr))) {
      return refuse(403, 'This source address is not permitted by the route policy.')
    }
  }

  if (request.contentLength !== undefined && request.contentLength > grant.routes.maxBodyBytes) {
    return refuse(
      413,
      `The request body is ${request.contentLength} bytes, over this route's ${grant.routes.maxBodyBytes}-byte limit.`,
    )
  }

  // CORS is a browser convenience, applied after the decision and never as part of it: a
  // non-browser client ignores it entirely, so treating it as access control protects nobody.
  const corsOrigin =
    request.origin !== undefined && grant.routes.allowedOrigins.includes(request.origin)
      ? request.origin
      : undefined

  return corsOrigin === undefined ? { allowed: true } : { allowed: true, corsOrigin }
}

// ---------------------------------------------------------------- authentication

export const MAX_HMAC_SKEW_MS = 5 * 60 * 1000

export interface AuthInput {
  readonly auth: RouteAuth
  readonly headers: Readonly<Record<string, string>>
  /** The bytes exactly as received. Re-serialising before verifying would change the signature. */
  readonly rawBody: string
  readonly now: number
  /** Resolves a named secret reference. Route secrets are never readable through MCP. */
  readonly secret: (reference: string) => string | undefined
  /** Returns true when this replay ID was already seen inside the window. */
  readonly seenReplayId: (id: string) => boolean
}

const constantTimeEquals = (a: string, b: string): boolean => {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

export const authenticateRoute = (input: AuthInput): PolicyOutcome => {
  switch (input.auth.type) {
    case 'none':
      // Reachable only because an administrator granted it explicitly; the grant is the check.
      return { allowed: true }

    case 'apiKey': {
      const header = (input.auth.header ?? 'x-api-key').toLowerCase()
      const supplied = input.headers[header]
      const expected = input.secret(input.auth.secretRef)
      return expected !== undefined &&
        supplied !== undefined &&
        constantTimeEquals(supplied, expected)
        ? { allowed: true }
        : refuse(401, 'The API key is missing or incorrect.')
    }

    case 'bearer': {
      const authorization = input.headers.authorization ?? ''
      const supplied = authorization.startsWith('Bearer ') ? authorization.slice(7) : undefined
      const expected = input.secret(input.auth.secretRef)
      return expected !== undefined &&
        supplied !== undefined &&
        constantTimeEquals(supplied, expected)
        ? { allowed: true }
        : refuse(401, 'The bearer token is missing or incorrect.')
    }

    case 'hmacSha256':
      return checkHmac(input, input.auth)
  }
}

const checkHmac = (
  input: AuthInput,
  auth: Extract<RouteAuth, { type: 'hmacSha256' }>,
): PolicyOutcome => {
  const header = (auth.header ?? 'x-signature').toLowerCase()
  const signature = input.headers[header]
  const timestamp = input.headers['x-signature-timestamp']
  const secret = input.secret(auth.secretRef)

  if (signature === undefined || timestamp === undefined) {
    return refuse(401, `Both ${header} and x-signature-timestamp are required.`)
  }
  if (secret === undefined) {
    return refuse(500, `The route secret "${auth.secretRef}" is not configured.`)
  }

  const age = Math.abs(input.now - Number(timestamp))
  if (!Number.isFinite(age) || age > MAX_HMAC_SKEW_MS) {
    // A signature with no freshness bound is replayable forever, which is the whole point of
    // signing the timestamp alongside the body.
    return refuse(401, 'The signature timestamp is outside the five-minute window.')
  }

  // Over timestamp + raw body, so a request cannot be replayed with a different body under the
  // same signature.
  const expected = createHmac('sha256', secret)
    .update(`${timestamp}.${input.rawBody}`)
    .digest('hex')
  if (!constantTimeEquals(signature, expected)) {
    return refuse(401, 'The signature does not match.')
  }

  // Within the window a valid signature is still valid; without a replay record the same request
  // could be delivered repeatedly.
  return input.seenReplayId(signature)
    ? refuse(409, 'This request was already delivered.')
    : { allowed: true }
}

// ---------------------------------------------------------------- response validation

export const MAX_RESPONSE_BYTES = 1024 * 1024

export interface ResponseRejection {
  readonly reason: string
}

/**
 * Check what a workflow wants to return before it becomes a public HTTP response.
 *
 * A workflow choosing its own status and headers could set `Location`, `Set-Cookie`, or a CORS
 * header on the control plane's own origin — so the set it may choose from is closed.
 */
const FORBIDDEN_RESPONSE_HEADERS: ReadonlyArray<string> = [
  'set-cookie',
  'access-control-allow-origin',
  'access-control-allow-credentials',
  'strict-transport-security',
  'www-authenticate',
]

export const checkWorkflowResponse = (response: {
  readonly status: number
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
}): ResponseRejection | undefined => {
  if (!Number.isInteger(response.status) || response.status < 200 || response.status > 599) {
    return { reason: `A workflow returned status ${response.status}, which is not a valid status.` }
  }

  for (const name of Object.keys(response.headers)) {
    if (FORBIDDEN_RESPONSE_HEADERS.includes(name.toLowerCase())) {
      return {
        reason: `A workflow tried to set "${name}", which belongs to the control plane rather than to a route.`,
      }
    }
  }

  if (response.body.length > MAX_RESPONSE_BYTES) {
    return {
      reason: `The response body is ${response.body.length} bytes, over the ${MAX_RESPONSE_BYTES}-byte limit.`,
    }
  }

  return undefined
}

// ---------------------------------------------------------------- CIDR

/**
 * IPv4 and IPv6 CIDR membership.
 *
 * Duplicated rather than shared with the auth package because the dependency would run backwards:
 * the workflow runtime must not depend on control-plane authentication.
 */
export const withinCidr = (ip: string, cidr: string): boolean => {
  const [network, bitsRaw] = cidr.split('/')
  if (network === undefined || bitsRaw === undefined) return false

  const bits = Number(bitsRaw)
  const target = parseIp(ip)
  const base = parseIp(network)
  if (target === undefined || base === undefined || target.length !== base.length) return false
  if (!Number.isInteger(bits) || bits < 0 || bits > target.length * 8) return false

  const wholeBytes = Math.floor(bits / 8)
  for (let index = 0; index < wholeBytes; index += 1) {
    if (target[index] !== base[index]) return false
  }

  const remainder = bits % 8
  if (remainder === 0) return true

  const mask = 0xff << (8 - remainder)
  return ((target[wholeBytes] ?? 0) & mask) === ((base[wholeBytes] ?? 0) & mask)
}

const parseIp = (value: string): Uint8Array | undefined =>
  value.includes(':') ? parseIpv6(value) : parseIpv4(value)

const parseIpv4 = (value: string): Uint8Array | undefined => {
  const parts = value.split('.')
  if (parts.length !== 4) return undefined

  const bytes = new Uint8Array(4)
  for (let index = 0; index < 4; index += 1) {
    const part = Number(parts[index])
    if (!Number.isInteger(part) || part < 0 || part > 255) return undefined
    bytes[index] = part
  }
  return bytes
}

const parseIpv6 = (value: string): Uint8Array | undefined => {
  const [head, tail, ...extra] = value.split('::')
  if (extra.length > 0 || head === undefined) return undefined

  const left = head === '' ? [] : head.split(':')
  const right = tail === undefined || tail === '' ? [] : tail.split(':')
  if (tail === undefined && left.length !== 8) return undefined
  if (left.length + right.length > 8) return undefined

  const groups = [...left, ...Array(8 - left.length - right.length).fill('0'), ...right]
  const bytes = new Uint8Array(16)

  for (let index = 0; index < 8; index += 1) {
    const group = Number.parseInt(groups[index] ?? '0', 16)
    if (!Number.isInteger(group) || group < 0 || group > 0xffff) return undefined
    bytes[index * 2] = group >> 8
    bytes[index * 2 + 1] = group & 0xff
  }
  return bytes
}
