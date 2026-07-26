import { AuthenticationError, type Principal, type Scope } from '@discord-mcp/core'
import { Effect } from 'effect'
import { createRemoteJWKSet, jwtVerify } from 'jose'

/**
 * Turning an HTTP request into a principal.
 *
 * Three paths — OIDC bearer, personal access token, trusted proxy identity — all producing the
 * same `Principal`, so authorization downstream cannot accidentally depend on how someone
 * authenticated.
 */

export interface OidcConfig {
  readonly issuer: string
  readonly audience: string
  readonly jwksUri: string
}

export interface AuthInfoLike {
  readonly token: string
  readonly clientId?: string
  readonly scopes: ReadonlyArray<string>
  /** Milliseconds. Never optional in practice — see `verifyAccessToken`. */
  readonly expiresAt: number
}

/**
 * Verify an OIDC access token.
 *
 * `exp` is required rather than optional. MCP's `AuthInfo.expiresAt` is nominally optional, but a
 * token with no expiry is a token that cannot be revoked by waiting, and treating an unset value
 * as "valid forever" is how a leaked token stays useful indefinitely. Absent `exp` is a 401.
 */
export const verifyAccessToken =
  (config: OidcConfig, jwks: ReturnType<typeof createRemoteJWKSet>) =>
  (token: string): Effect.Effect<AuthInfoLike, AuthenticationError> =>
    Effect.gen(function* () {
      const verified = yield* Effect.tryPromise({
        try: () =>
          jwtVerify(token, jwks, {
            issuer: config.issuer,
            audience: config.audience,
            // jose checks nbf and exp itself; clockTolerance stays at 0 so a skewed client is a
            // visible failure rather than a silent widening of the validity window.
            clockTolerance: 0,
          }),
        catch: (cause) =>
          new AuthenticationError({
            message: `The access token is not valid: ${cause instanceof Error ? cause.message : String(cause)}`,
          }),
      })

      const { payload } = verified
      if (typeof payload.exp !== 'number') {
        return yield* Effect.fail(
          new AuthenticationError({
            message:
              'The access token has no expiry. A token that never expires cannot be revoked by waiting, so this server refuses it.',
          }),
        )
      }

      const scopeClaim = payload.scope ?? payload.scp
      const scopes =
        typeof scopeClaim === 'string'
          ? scopeClaim.split(' ').filter((s) => s.length > 0)
          : Array.isArray(scopeClaim)
            ? scopeClaim.map(String)
            : []

      return {
        token,
        ...(typeof payload.sub === 'string' ? { clientId: payload.sub } : {}),
        scopes,
        expiresAt: payload.exp * 1000,
      }
    })

export const makeJwks = (config: OidcConfig) => createRemoteJWKSet(new URL(config.jwksUri))

// ---------------------------------------------------------------- trusted proxy

export interface ProxyTrustConfig {
  readonly trustProxyIdentity: boolean
  /** CIDRs the TCP peer must fall inside. Empty means nothing is trusted. */
  readonly trustedProxyCidrs: ReadonlyArray<string>
  readonly allowedHosts: ReadonlyArray<string>
  readonly identityHeader: string
  readonly groupsHeader?: string
}

/** Parse `a.b.c.d/len`. IPv4 only; an IPv6 deployment should terminate TLS differently anyway. */
const parseCidr = (cidr: string): { base: number; mask: number } | undefined => {
  const [address, bits] = cidr.split('/')
  if (address === undefined || bits === undefined) return undefined

  const octets = address.split('.').map(Number)
  if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) {
    return undefined
  }

  const length = Number(bits)
  if (!Number.isInteger(length) || length < 0 || length > 32) return undefined

  const base =
    ((octets[0] as number) << 24) |
    ((octets[1] as number) << 16) |
    ((octets[2] as number) << 8) |
    (octets[3] as number)
  const mask = length === 0 ? 0 : (-1 << (32 - length)) >>> 0
  return { base: base >>> 0, mask }
}

export const isWithinCidr = (ip: string, cidr: string): boolean => {
  const parsed = parseCidr(cidr)
  const octets = ip.split('.').map(Number)
  if (parsed === undefined || octets.length !== 4 || octets.some((o) => !Number.isInteger(o))) {
    return false
  }
  const value =
    (((octets[0] as number) << 24) |
      ((octets[1] as number) << 16) |
      ((octets[2] as number) << 8) |
      (octets[3] as number)) >>>
    0
  return (value & parsed.mask) === (parsed.base & parsed.mask)
}

export interface InboundRequest {
  /** The TCP peer. Never a forwarded header — that is the whole point. */
  readonly remoteAddress: string
  readonly host: string | undefined
  readonly forwardedProto: string | undefined
  readonly headers: Readonly<Record<string, string | undefined>>
}

export type ProxyTrustResult =
  | { readonly trusted: true; readonly identity: string; readonly groups: ReadonlyArray<string> }
  | { readonly trusted: false; readonly reason: string }

/**
 * Decide whether to believe a forwarded identity header.
 *
 * Every condition must hold. Forwarded identity is the single most dangerous header a server can
 * believe: if any check is skipped, anyone who can reach the port can assert any identity. The
 * checks are ordered cheapest first, and each returns a distinct reason so a misconfiguration is
 * diagnosable without guessing.
 */
export const evaluateProxyTrust = (
  config: ProxyTrustConfig,
  request: InboundRequest,
): ProxyTrustResult => {
  if (!config.trustProxyIdentity) {
    return {
      trusted: false,
      reason:
        'TRUST_PROXY_IDENTITY is not enabled, so forwarded identity headers are ignored. This is the safe default.',
    }
  }

  if (config.trustedProxyCidrs.length === 0) {
    return {
      trusted: false,
      reason:
        'TRUSTED_PROXY_CIDRS is empty. With no trusted range, any client could assert any identity, so nothing is trusted.',
    }
  }

  if (!config.trustedProxyCidrs.some((cidr) => isWithinCidr(request.remoteAddress, cidr))) {
    return {
      trusted: false,
      reason: `The connection came from ${request.remoteAddress}, which is outside TRUSTED_PROXY_CIDRS. Forwarded headers from anywhere else are discarded.`,
    }
  }

  // A Host header the deployment does not expect means the request did not arrive the way the
  // operator configured, so the proxy's guarantees do not apply to it.
  if (config.allowedHosts.length > 0) {
    const host = request.host?.split(':')[0]
    if (host === undefined || !config.allowedHosts.includes(host)) {
      return {
        trusted: false,
        reason: `Host "${request.host ?? '(absent)'}" is not in ALLOWED_HOSTS. CORS and Host are never the access-control decision, but an unexpected Host means this request did not come through the configured path.`,
      }
    }
  }

  if (request.forwardedProto !== undefined && request.forwardedProto !== 'https') {
    return {
      trusted: false,
      reason: `X-Forwarded-Proto is "${request.forwardedProto}". A proxy that terminates TLS should forward https; anything else suggests the request reached the proxy unencrypted.`,
    }
  }

  const identity = request.headers[config.identityHeader.toLowerCase()]
  if (identity === undefined || identity === '') {
    return {
      trusted: false,
      reason: `The configured identity header "${config.identityHeader}" is absent. The proxy is trusted but did not identify anyone.`,
    }
  }

  const groupsRaw =
    config.groupsHeader === undefined
      ? undefined
      : request.headers[config.groupsHeader.toLowerCase()]

  return {
    trusted: true,
    identity,
    groups:
      groupsRaw === undefined
        ? []
        : groupsRaw
            .split(',')
            .map((g) => g.trim())
            .filter((g) => g.length > 0),
  }
}

/**
 * The client's address, when it can be established.
 *
 * Distinct from `evaluateProxyTrust`, which answers "who is this" from identity headers. This
 * answers "where did it come from", which is what a source-CIDR rule needs.
 *
 * Undefined when it cannot be established honestly: an `X-Forwarded-For` from an untrusted peer is
 * a claim the client made about itself, and treating it as an address makes every CIDR rule
 * trivially bypassable by setting a header.
 */
export const trustedClientAddress = (input: {
  readonly socketAddress: string
  readonly forwardedFor: string | undefined
  readonly config: ProxyTrustConfig
}): string | undefined => {
  const direct = normalizeAddress(input.socketAddress)

  const behindTrustedProxy =
    input.config.trustProxyIdentity &&
    input.config.trustedProxyCidrs.length > 0 &&
    input.config.trustedProxyCidrs.some((cidr) => isWithinCidr(direct, cidr))

  if (!behindTrustedProxy) {
    // A direct connection: the peer address is the client, and no header can change that.
    return direct === '' ? undefined : direct
  }

  // Leftmost entry is the original client. Anything a proxy appended after it is a hop.
  const claimed = input.forwardedFor?.split(',')[0]?.trim()
  return claimed === undefined || claimed === '' ? undefined : normalizeAddress(claimed)
}

/** `::ffff:203.0.113.7` is an IPv4 address wearing an IPv6 hat; CIDR rules are written for the hat-free form. */
const normalizeAddress = (address: string): string =>
  address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address

/**
 * Intersect a token's scopes with what the principal actually holds.
 *
 * A token can never widen a principal: an OIDC provider we do not control could otherwise assert
 * `mcp:destructive` for someone who was never granted it.
 */
export const narrowScopes = (
  principal: Principal,
  tokenScopes: ReadonlyArray<string>,
): Principal => ({
  ...principal,
  scopes: new Set([...principal.scopes].filter((s) => tokenScopes.includes(s)) as Scope[]),
})
