import { createHmac } from 'node:crypto'
import { DEFAULT_GRANT, type WorkflowGrant } from '@discord-mcp/workflow-sdk'
import { describe, expect, it } from 'vitest'
import {
  authenticateRoute,
  checkRoutePolicy,
  checkWorkflowResponse,
  MAX_HMAC_SKEW_MS,
  mountPath,
  parseMountedPath,
  RESERVED_PREFIXES,
  withinCidr,
} from '../src/routes.ts'

/**
 * Public routes are the only part of the system an unauthenticated stranger can reach, so each of
 * these is a way in that has to stay shut.
 */

const NOW = 1_780_000_000_000
const SECRET = 'a-route-secret'

const grantWith = (routes: Partial<WorkflowGrant['routes']>): WorkflowGrant => ({
  ...DEFAULT_GRANT,
  routes: { ...DEFAULT_GRANT.routes, ...routes },
})

const facts = (overrides: Partial<Parameters<typeof checkRoutePolicy>[0]['request']> = {}) => ({
  method: 'POST',
  path: '/workflows/greeter/hook',
  host: 'bot.example.com',
  origin: undefined,
  sourceIp: '203.0.113.7',
  headers: {},
  contentLength: 100,
  ...overrides,
})

describe('route namespacing', () => {
  it('mounts every route beneath its own workflow', () => {
    expect(mountPath('greeter', '/hook')).toEqual({ path: '/workflows/greeter/hook' })
  })

  it('refuses a path that would escape the namespace', () => {
    // Without this, `/workflows/a/../../mcp` resolves onto the control plane's own endpoint.
    const escaped = mountPath('greeter', '/../../mcp')
    expect('reason' in escaped && escaped.reason).toContain('outside this workflow')
  })

  it('cannot reach a reserved prefix, because a workflow never chooses its own prefix', () => {
    for (const reserved of RESERVED_PREFIXES) {
      const mounted = mountPath('greeter', reserved)
      expect('path' in mounted && mounted.path).toBe(`/workflows/greeter${reserved}`)
    }
  })

  it('refuses a path that is not a plain path', () => {
    expect('reason' in mountPath('greeter', 'hook')).toBe(true)
    expect('reason' in mountPath('greeter', '/hook?x=1')).toBe(true)
    expect('reason' in mountPath('greeter', '//evil')).toBe(true)
  })

  it('routes a request back to the workflow that owns it', () => {
    expect(parseMountedPath('/workflows/greeter/hook')).toEqual({ slug: 'greeter', rest: '/hook' })
    expect(parseMountedPath('/mcp')).toBeUndefined()
  })
})

describe('route policy', () => {
  it('refuses a host the route does not serve', () => {
    const outcome = checkRoutePolicy({
      grant: grantWith({ allowedHosts: ['bot.example.com'] }),
      request: facts({ host: 'attacker.example' }),
      trustedSourceIp: undefined,
    })
    // 404 rather than 403: an unserved host should not learn that the route exists.
    expect(outcome).toMatchObject({ allowed: false, status: 404 })
  })

  it('refuses a source restriction it cannot evaluate', () => {
    const outcome = checkRoutePolicy({
      grant: grantWith({ allowedSourceCidrs: ['203.0.113.0/24'] }),
      request: facts(),
      // No trusted proxy identified the client, so `sourceIp` is a claim rather than a fact.
      trustedSourceIp: undefined,
    })
    expect(outcome).toMatchObject({ allowed: false, status: 403 })
    expect('reason' in outcome && outcome.reason).toContain('TRUST_PROXY_IDENTITY')
  })

  it('applies source CIDRs using only trusted forwarding data', () => {
    const grant = grantWith({ allowedSourceCidrs: ['203.0.113.0/24'] })

    expect(
      checkRoutePolicy({ grant, request: facts(), trustedSourceIp: '203.0.113.7' }),
    ).toMatchObject({ allowed: true })

    expect(
      checkRoutePolicy({ grant, request: facts(), trustedSourceIp: '198.51.100.9' }),
    ).toMatchObject({ allowed: false, status: 403 })
  })

  it('refuses an oversized body from Content-Length, before any of it is buffered', () => {
    const outcome = checkRoutePolicy({
      grant: grantWith({ maxBodyBytes: 1024 }),
      request: facts({ contentLength: 5000 }),
      trustedSourceIp: undefined,
    })
    expect(outcome).toMatchObject({ allowed: false, status: 413 })
  })

  it('adds CORS only for configured origins, and never as the decision', () => {
    const grant = grantWith({ allowedOrigins: ['https://app.example.com'] })

    const allowed = checkRoutePolicy({
      grant,
      request: facts({ origin: 'https://app.example.com' }),
      trustedSourceIp: undefined,
    })
    expect(allowed).toMatchObject({ allowed: true, corsOrigin: 'https://app.example.com' })

    // An unlisted origin still gets through — CORS is a browser convenience, and a non-browser
    // client ignores it entirely. Access control is the auth scheme's job.
    const other = checkRoutePolicy({
      grant,
      request: facts({ origin: 'https://attacker.example' }),
      trustedSourceIp: undefined,
    })
    expect(other).toEqual({ allowed: true })
  })
})

describe('route authentication', () => {
  const secret = (reference: string) => (reference === 'ref' ? SECRET : undefined)
  const never = () => false

  it('checks an API key against its secret reference', () => {
    expect(
      authenticateRoute({
        auth: { type: 'apiKey', secretRef: 'ref' },
        headers: { 'x-api-key': SECRET },
        rawBody: '',
        now: NOW,
        secret,
        seenReplayId: never,
      }),
    ).toEqual({ allowed: true })

    expect(
      authenticateRoute({
        auth: { type: 'apiKey', secretRef: 'ref' },
        headers: { 'x-api-key': 'wrong' },
        rawBody: '',
        now: NOW,
        secret,
        seenReplayId: never,
      }),
    ).toMatchObject({ allowed: false, status: 401 })
  })

  it('checks a bearer token', () => {
    expect(
      authenticateRoute({
        auth: { type: 'bearer', secretRef: 'ref' },
        headers: { authorization: `Bearer ${SECRET}` },
        rawBody: '',
        now: NOW,
        secret,
        seenReplayId: never,
      }),
    ).toEqual({ allowed: true })
  })

  const sign = (timestamp: number, body: string) =>
    createHmac('sha256', SECRET).update(`${timestamp}.${body}`).digest('hex')

  it('verifies an HMAC over timestamp and raw body', () => {
    const body = '{"hello":"world"}'
    expect(
      authenticateRoute({
        auth: { type: 'hmacSha256', secretRef: 'ref' },
        headers: {
          'x-signature': sign(NOW, body),
          'x-signature-timestamp': String(NOW),
        },
        rawBody: body,
        now: NOW,
        secret,
        seenReplayId: never,
      }),
    ).toEqual({ allowed: true })
  })

  it('refuses a signature reused with a different body', () => {
    const signature = sign(NOW, '{"amount":1}')
    expect(
      authenticateRoute({
        auth: { type: 'hmacSha256', secretRef: 'ref' },
        headers: { 'x-signature': signature, 'x-signature-timestamp': String(NOW) },
        rawBody: '{"amount":1000000}',
        now: NOW,
        secret,
        seenReplayId: never,
      }),
    ).toMatchObject({ allowed: false, status: 401 })
  })

  it('refuses a signature older than the window', () => {
    const timestamp = NOW - MAX_HMAC_SKEW_MS - 1000
    expect(
      authenticateRoute({
        auth: { type: 'hmacSha256', secretRef: 'ref' },
        headers: { 'x-signature': sign(timestamp, ''), 'x-signature-timestamp': String(timestamp) },
        rawBody: '',
        now: NOW,
        secret,
        seenReplayId: never,
      }),
    ).toMatchObject({ allowed: false, status: 401 })
  })

  it('refuses a replay of a still-valid signature', () => {
    const signature = sign(NOW, '')
    expect(
      authenticateRoute({
        auth: { type: 'hmacSha256', secretRef: 'ref' },
        headers: { 'x-signature': signature, 'x-signature-timestamp': String(NOW) },
        rawBody: '',
        now: NOW,
        secret,
        // Within the window the signature stays valid, so only a replay record stops the same
        // request being delivered twice.
        seenReplayId: (id) => id === signature,
      }),
    ).toMatchObject({ allowed: false, status: 409 })
  })

  it('reports an unconfigured route secret as a server problem, not a client one', () => {
    expect(
      authenticateRoute({
        auth: { type: 'hmacSha256', secretRef: 'missing' },
        headers: { 'x-signature': 'x', 'x-signature-timestamp': String(NOW) },
        rawBody: '',
        now: NOW,
        secret,
        seenReplayId: never,
      }),
    ).toMatchObject({ allowed: false, status: 500 })
  })

  it('allows an unauthenticated route only because a grant said so', () => {
    expect(
      authenticateRoute({
        auth: { type: 'none' },
        headers: {},
        rawBody: '',
        now: NOW,
        secret,
        seenReplayId: never,
      }),
    ).toEqual({ allowed: true })
  })
})

describe('workflow responses', () => {
  const ok = { status: 200, headers: { 'content-type': 'application/json' }, body: '{}' }

  it('accepts an ordinary response', () => {
    expect(checkWorkflowResponse(ok)).toBeUndefined()
  })

  it('refuses headers that belong to the control plane', () => {
    for (const header of ['set-cookie', 'access-control-allow-origin', 'www-authenticate']) {
      const rejection = checkWorkflowResponse({ ...ok, headers: { [header]: 'x' } })
      expect(rejection?.reason).toContain(header)
    }
  })

  it('refuses an invalid status', () => {
    expect(checkWorkflowResponse({ ...ok, status: 999 })?.reason).toContain('not a valid status')
  })

  it('refuses an oversized body', () => {
    expect(checkWorkflowResponse({ ...ok, body: 'x'.repeat(2 * 1024 * 1024) })?.reason).toContain(
      'over the',
    )
  })
})

describe('CIDR membership', () => {
  it('handles IPv4', () => {
    expect(withinCidr('203.0.113.7', '203.0.113.0/24')).toBe(true)
    expect(withinCidr('203.0.114.7', '203.0.113.0/24')).toBe(false)
    expect(withinCidr('10.1.2.3', '10.0.0.0/8')).toBe(true)
  })

  it('handles a non-byte-aligned prefix', () => {
    // /28 is where an implementation that only compares whole bytes gets it wrong.
    expect(withinCidr('192.168.1.15', '192.168.1.0/28')).toBe(true)
    expect(withinCidr('192.168.1.16', '192.168.1.0/28')).toBe(false)
  })

  it('handles IPv6, including the compressed form', () => {
    expect(withinCidr('2001:db8::1', '2001:db8::/32')).toBe(true)
    expect(withinCidr('2001:db9::1', '2001:db8::/32')).toBe(false)
    expect(withinCidr('::1', '::1/128')).toBe(true)
  })

  it('never matches across families or on nonsense', () => {
    expect(withinCidr('203.0.113.7', '2001:db8::/32')).toBe(false)
    expect(withinCidr('not-an-ip', '203.0.113.0/24')).toBe(false)
    expect(withinCidr('203.0.113.7', '203.0.113.0/99')).toBe(false)
  })
})
