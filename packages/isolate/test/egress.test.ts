import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { OperationCatalog } from '@mia-cx/discord-catalog'
import { Effect } from 'effect'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { type Denial, makeBroker } from '../src/broker.ts'
import { prepareScript } from '../src/bundle.ts'
import { fetchPublic, isPublicAddress } from '../src/egress.ts'
import { makeIsolateHost } from '../src/isolate-host.ts'

const catalog = await Effect.runPromise(Effect.provide(OperationCatalog, OperationCatalog.layer))

/**
 * A local target that records every request, standing in for both a public webhook and something
 * inside the cluster. Redirect destinations are registered by the test, never taken from a request.
 */
const listen = async () => {
  const hits: string[] = []
  const redirects = new Map<string, string>()
  const server = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    hits.push(`${request.method} ${request.headers.host} ${request.url}${body && ` ${body}`}`)
    const target = redirects.get(request.url ?? '')
    if (target !== undefined) response.writeHead(302, { location: target })
    response.end('reached')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { hits, redirects, server, port: (server.address() as AddressInfo).port }
}

/** Fake DNS: names outside `answers` fail as an unknown domain would, so no test reaches the internet. */
const dns =
  (answers: Record<string, ReadonlyArray<string>>) =>
  async (host: string): Promise<ReadonlyArray<string>> => {
    const found = answers[host]
    if (found !== undefined) return found
    throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' })
  }

const brokerFor = (
  hosts: ReadonlyArray<string>,
  egress: (request: Request) => Promise<Response>,
) => {
  const denied: Denial[] = []
  const broker = makeBroker({
    operations: catalog.all,
    grants: { operations: [], families: [], hosts },
    discord: () => Effect.die('No Discord call is expected.'),
    egress,
    onDenied: (denial) => denied.push(denial),
  })
  return { broker, denied }
}

describe('the address policy', () => {
  it.each([
    ['public IPv4', '8.8.8.8', true],
    ['public IPv6', '2606:4700:4700::1111', true],
    ['loopback', '127.0.0.1', false],
    ['private 10/8', '10.1.2.3', false],
    ['private 172.16/12', '172.20.0.1', false],
    ['private 192.168/16', '192.168.1.1', false],
    ['shared address space', '100.64.0.1', false],
    ['unspecified', '0.0.0.0', false],
    ['broadcast', '255.255.255.255', false],
    ['AWS, GCP, and Azure metadata', '169.254.169.254', false],
    ['AWS IPv6 metadata', 'fd00:ec2::254', false],
    ['Alibaba metadata', '100.100.100.200', false],
    ['Oracle metadata', '192.0.0.192', false],
    ['IPv6 loopback', '::1', false],
    ['IPv6 link-local', 'fe80::1', false],
    ['IPv6 unique local', 'fd00::1', false],
    ['IPv6 site-local', 'fec0::1', false],
    ['IPv4-mapped loopback', '::ffff:127.0.0.1', false],
    ['IPv4-mapped public', '::ffff:8.8.8.8', false],
    ['IPv4-compatible loopback', '::127.0.0.1', false],
    ['IPv4-translated metadata', '::ffff:0:a9fe:a9fe', false],
    ['NAT64 metadata', '64:ff9b::a9fe:a9fe', false],
    ['local-use NAT64', '64:ff9b:1::a00:1', false],
    ['6to4 loopback', '2002:7f00:1::1', false],
    ['Teredo', '2001:0:4136:e378:8000:63bf:3fff:fdd2', false],
    ['not an address', 'hooks.example', false],
  ])('%s (%s) is public: %s', (_label, address, expected) => {
    expect(isPublicAddress(address)).toBe(expected)
  })
})

describe('the broker refuses outbound requests it cannot show are public and granted', () => {
  let target: Awaited<ReturnType<typeof listen>>
  beforeAll(async () => {
    target = await listen()
  })
  afterAll(() => target.server.close())
  afterEach(() => {
    // Every refusal happens before a connection: nothing ever reaches the target.
    expect(target.hits).toEqual([])
  })

  // Rows that reach loopback use the target's `{port}`: a refusal that failed to stop the
  // request would show up in its hits.
  it.each<{
    label: string
    url: string
    answers?: ReadonlyArray<string>
    granted?: false
    reason: string
  }>([
    {
      label: 'an ungranted host',
      url: 'http://hooks.example/',
      granted: false,
      reason: 'Host hooks.example is not granted',
    },
    { label: 'a private literal', url: 'http://10.0.0.1/', reason: '10.0.0.1, which is not' },
    { label: 'a loopback literal', url: 'http://127.0.0.1:{port}/', reason: '127.0.0.1, which' },
    {
      label: 'a mapped literal',
      url: 'http://[::ffff:7f00:1]:{port}/',
      reason: '::ffff:7f00:1, which is not',
    },
    {
      label: 'cloud metadata',
      url: 'http://169.254.169.254/latest/',
      reason: '169.254.169.254, which is not',
    },
    {
      label: 'a name for loopback',
      url: 'http://hooks.example:{port}/',
      answers: ['127.0.0.1'],
      reason: 'hooks.example resolves to 127.0.0.1, which is not a public address',
    },
    {
      label: 'a name for a private address',
      url: 'http://hooks.example/',
      answers: ['10.1.2.3'],
      reason: 'resolves to 10.1.2.3',
    },
    {
      label: 'a name with public and private answers',
      url: 'http://hooks.example:{port}/',
      answers: ['93.184.215.14', '127.0.0.1'],
      reason: 'resolves to 127.0.0.1',
    },
    {
      label: 'a name for a mapped address',
      url: 'http://hooks.example:{port}/',
      answers: ['::ffff:127.0.0.1'],
      reason: 'resolves to ::ffff:127.0.0.1',
    },
    {
      label: 'a name for NAT64 metadata',
      url: 'http://hooks.example/',
      answers: ['64:ff9b::a9fe:a9fe'],
      reason: 'resolves to 64:ff9b::a9fe:a9fe',
    },
    {
      label: 'a name with no answers',
      url: 'http://hooks.example/',
      answers: [],
      reason: 'hooks.example resolves to no address',
    },
    {
      label: 'a name that fails to resolve',
      url: 'http://hooks.example/',
      reason: 'hooks.example did not resolve (ENOTFOUND)',
    },
  ])('$label', async ({ url: template, answers, granted, reason }) => {
    const url = new URL(template.replace('{port}', String(target.port)))
    const host = url.hostname
    const { broker, denied } = brokerFor(granted === false ? [] : [host], (request) =>
      fetchPublic(request, { resolve: dns(answers === undefined ? {} : { [host]: answers }) }),
    )

    const response = await broker(new Request(url))

    expect(response.status).toBe(403)
    expect(denied).toEqual([
      { method: 'GET', url: url.href, reason: expect.stringContaining(reason) },
    ])
  })
})

describe('outbound fetch from an isolate', () => {
  it('posts to a granted public webhook, and refuses redirects into private or ungranted hosts', async () => {
    const target = await listen()
    try {
      const at = (host: string, path: string) => `http://${host}:${target.port}${path}`
      const into = (url: string) => {
        const path = `/to/${encodeURIComponent(url)}`
        target.redirects.set(path, url)
        return at('hooks.example', path)
      }
      const { broker, denied } = brokerFor(['hooks.example', 'internal.example'], (request) =>
        fetchPublic(request, {
          resolve: dns({ 'hooks.example': ['127.0.0.1'], 'internal.example': ['10.0.0.1'] }),
          // The local target plays the public webhook; every other address keeps the real policy.
          isPublic: (address) => address === '127.0.0.1' || isPublicAddress(address),
        }),
      )

      const run = await makeIsolateHost().run({
        botId: '1',
        botUser: { id: '1', username: 'bot', discriminator: '0', bot: true },
        modules: await prepareScript(`
          export default async () => {
            const posted = await fetch('${at('hooks.example', '/hook')}', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ content: 'deployed' }),
            })
            const redirects = []
            for (const url of [
              '${into(at('internal.example', '/inside'))}',
              '${into(at('127.0.0.1', '/inside'))}',
              '${into('http://169.254.169.254/latest/')}',
            ]) redirects.push((await fetch(url)).status)
            return { posted: [posted.status, await posted.text()], redirects }
          }`),
        timeoutMs: 10_000,
        broker,
      })

      expect(run).toEqual({
        outcome: 'completed',
        result: { posted: [200, 'reached'], redirects: [403, 403, 403] },
        logs: [],
      })
      expect(target.hits).toEqual([
        `POST hooks.example:${target.port} /hook {"content":"deployed"}`,
        ...[
          at('internal.example', '/inside'),
          at('127.0.0.1', '/inside'),
          'http://169.254.169.254/latest/',
        ].map((url) => `GET hooks.example:${target.port} /to/${encodeURIComponent(url)}`),
      ])
      expect(denied.map((denial) => denial.reason)).toEqual([
        expect.stringContaining('internal.example resolves to 10.0.0.1'),
        expect.stringContaining('Host 127.0.0.1 is not granted'),
        expect.stringContaining('Host 169.254.169.254 is not granted'),
      ])
    } finally {
      target.server.close()
    }
  })
})
