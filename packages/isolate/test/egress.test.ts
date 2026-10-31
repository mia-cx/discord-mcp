import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { EgressBlockedError, fetchPublic, isPublicAddress } from '../src/egress.ts'

/** A local target that records every request, standing in for something inside the cluster. */
const listen = async () => {
  const hits: string[] = []
  const server = createServer((request, response) => {
    hits.push(`${request.headers.host} ${request.url}`)
    response.end('inside')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { hits, server, port: (server.address() as AddressInfo).port }
}

let close = () => {}
afterEach(() => close())

describe('egress', () => {
  it.each([
    ['8.8.8.8', true],
    ['2606:4700:4700::1111', true],
    ['127.0.0.1', false],
    ['10.1.2.3', false],
    ['172.20.0.1', false],
    ['192.168.1.1', false],
    ['100.64.0.1', false],
    ['169.254.169.254', false],
    ['0.0.0.0', false],
    ['::1', false],
    ['fe80::1', false],
    ['fd00::1', false],
    ['::ffff:127.0.0.1', false],
    ['::ffff:8.8.8.8', false],
  ])('%s is public: %s', (address, expected) => {
    expect(isPublicAddress(address)).toBe(expected)
  })

  it('refuses a hostname that resolves to a private address, before connecting', async () => {
    const target = await listen()
    close = () => target.server.close()

    const rebound = fetchPublic(new Request(`http://hooks.example:${target.port}/`), {
      resolve: async () => ['93.184.215.14', '127.0.0.1'],
    })

    await expect(rebound).rejects.toBeInstanceOf(EgressBlockedError)
    expect(target.hits).toEqual([])
  })

  it('connects to the checked address and keeps the hostname', async () => {
    const target = await listen()
    close = () => target.server.close()

    const response = await fetchPublic(new Request(`http://hooks.example:${target.port}/ping`), {
      resolve: async () => ['127.0.0.1'],
      isPublic: (address) => address === '127.0.0.1',
    })

    expect(await response.text()).toBe('inside')
    expect(target.hits).toEqual([`hooks.example:${target.port} /ping`])
  })
})
