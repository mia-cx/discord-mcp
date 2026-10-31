import { lookup } from 'node:dns/promises'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { BlockList, isIP, type LookupFunction } from 'node:net'
import { Readable } from 'node:stream'

/** Everything that is not the public internet: private, loopback, link-local, and special ranges. */
const nonPublic = new BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  nonPublic.addSubnet(network, prefix, 'ipv4')
}
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  nonPublic.addSubnet(network, prefix, 'ipv6')
}
// Kept apart: a BlockList also matches plain IPv4 addresses against an IPv4-mapped rule.
const ipv4Mapped = new BlockList()
ipv4Mapped.addSubnet('::ffff:0:0', 96, 'ipv6')

/** Whether an IP literal is on the public internet. IPv4-mapped IPv6 addresses never are. */
export const isPublicAddress = (address: string): boolean => {
  const family = isIP(address)
  if (family === 4) return !nonPublic.check(address, 'ipv4')
  if (family === 6) return !nonPublic.check(address, 'ipv6') && !ipv4Mapped.check(address, 'ipv6')
  return false
}

export class EgressBlockedError extends Error {
  constructor(host: string, address: string) {
    super(`${host} resolves to ${address}, which is not a public address.`)
    this.name = 'EgressBlockedError'
  }
}

export interface EgressOptions {
  readonly resolve?: (host: string) => Promise<ReadonlyArray<string>>
  /** The address policy. Only tests replace it. */
  readonly isPublic?: (address: string) => boolean
}

const resolveAll = async (host: string) =>
  (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address)

const HOP_BY_HOP = new Set([
  'connection',
  'host',
  'keep-alive',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

/**
 * Fetch a URL on the public internet only. Every address the hostname resolves to is checked, and
 * the connection goes to the checked address, so a DNS answer cannot change between the check and
 * the connect. Redirects come back to the caller unfollowed; the isolate's next request for the
 * `Location` arrives here again and is checked again.
 */
export const fetchPublic = async (
  request: Request,
  options: EgressOptions = {},
): Promise<Response> => {
  const url = new URL(request.url)
  const isPublic = options.isPublic ?? isPublicAddress
  const resolve = options.resolve ?? resolveAll
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1')

  const addresses = isIP(host) === 0 ? await resolve(host) : [host]
  const blocked = addresses.find((address) => !isPublic(address))
  if (addresses.length === 0 || blocked !== undefined) {
    throw new EgressBlockedError(host, blocked ?? 'nothing')
  }
  const [address = host] = addresses
  // Pins the connection to the address checked above. TLS still verifies the hostname.
  const pinned: LookupFunction = (_hostname, lookupOptions, callback) => {
    const family = isIP(address)
    if (lookupOptions.all === true) callback(null, [{ address, family }])
    else callback(null, address, family)
  }

  const headers = Object.fromEntries(
    [...request.headers].filter(([name]) => !HOP_BY_HOP.has(name.toLowerCase())),
  )
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const outgoing = send(
      url,
      { method: request.method, headers, lookup: pinned, signal: request.signal },
      resolve,
    )
    outgoing.on('error', reject)
    if (request.body === null) outgoing.end()
    else Readable.fromWeb(request.body).pipe(outgoing)
  })

  const responseHeaders = new Headers()
  for (const [name, value] of Object.entries(response.headers)) {
    if (value === undefined || HOP_BY_HOP.has(name)) continue
    for (const item of Array.isArray(value) ? value : [value]) responseHeaders.append(name, item)
  }
  const status = response.statusCode ?? 502
  const empty = status === 204 || status === 304 || request.method === 'HEAD'
  return new Response(empty ? null : Readable.toWeb(response), { status, headers: responseHeaders })
}
