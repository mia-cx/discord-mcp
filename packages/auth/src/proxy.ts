import type { Database } from '@discord-mcp/persistence'
import ipaddr from 'ipaddr.js'
import { AuthenticationError, type Principal, type Scope, scopes } from './principal.js'

export const isValidCidr = (cidr: string): boolean => {
  try {
    ipaddr.parseCIDR(cidr)
    return true
  } catch {
    return false
  }
}

export const isAddressInCidrs = (address: string, cidrs: ReadonlyArray<string>): boolean => {
  let peer: ipaddr.IPv4 | ipaddr.IPv6
  try {
    peer = ipaddr.process(address)
  } catch {
    throw new AuthenticationError('invalid proxy peer address')
  }
  return cidrs.some((cidr) => {
    try {
      const [range, bits] = ipaddr.parseCIDR(cidr)
      return peer.kind() === range.kind() && peer.match(range, bits)
    } catch {
      throw new AuthenticationError(`invalid trusted proxy CIDR: ${cidr}`)
    }
  })
}

export const resolveForwardedClientAddress = (
  peerAddress: string,
  forwardedFor: string | undefined,
  trustedCidrs: ReadonlyArray<string>,
): string => {
  if (!forwardedFor || !isAddressInCidrs(peerAddress, trustedCidrs)) return peerAddress
  const chain = forwardedFor
    .split(',')
    .map((address) => address.trim())
    .filter(Boolean)
  let current = peerAddress
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    if (!isAddressInCidrs(current, trustedCidrs)) return current
    current = chain[index] as string
  }
  // Validate the final client address even when every intermediary is trusted.
  ipaddr.process(current)
  return current
}

export class TrustedProxyAuthentication {
  constructor(
    readonly database: Database,
    readonly trustedCidrs: ReadonlyArray<string>,
    readonly identityHeader = 'x-forwarded-user',
    readonly groupsHeader = 'x-forwarded-groups',
  ) {}

  authenticate(input: {
    readonly peerAddress: string
    readonly headers: Readonly<Record<string, string | undefined>>
  }): Principal {
    if (!isAddressInCidrs(input.peerAddress, this.trustedCidrs)) {
      throw new AuthenticationError('forwarded identity came from an untrusted peer')
    }
    const identity = input.headers[this.identityHeader]
    if (!identity) throw new AuthenticationError(`missing ${this.identityHeader} header`)
    if (!input.headers[this.groupsHeader]) {
      throw new AuthenticationError(`missing ${this.groupsHeader} header`)
    }
    const principal = this.database.get<{
      id: string
      name: string
      disabled_at: string | null
    }>(
      `SELECT p.id, p.name, p.disabled_at
       FROM proxy_identities x JOIN principals p ON p.id = x.principal_id
       WHERE x.identity = ?`,
      identity,
    )
    if (!principal || principal.disabled_at !== null) {
      throw new AuthenticationError('proxy identity is not mapped to an active principal')
    }
    const bound = this.database
      .all<{ scope: string }>(
        'SELECT scope FROM principal_scope_bindings WHERE principal_id = ?',
        principal.id,
      )
      .map(({ scope }) => scope)
      .filter((scope): scope is Scope => scopes.includes(scope as Scope))
    return {
      id: principal.id,
      name: principal.name,
      kind: 'proxy',
      scopes: new Set(bound),
    }
  }
}
