import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport } from '@modelcontextprotocol/server'
import { afterEach, describe, expect, it } from 'vitest'
import { createServer } from '../../apps/server/src/server.js'
import { DiscordRestClient, type DiscordTransport } from '../../packages/discord-api/src/index.js'

describe('offline control-plane integration', () => {
  const close: Array<() => Promise<void>> = []
  afterEach(async () => {
    await Promise.all(close.splice(0).map((run) => run()))
  })

  it('validates and sends one Components V2 presentation through MCP and multipart REST', async () => {
    const calls: Array<Parameters<DiscordTransport['request']>[0]> = []
    const server = createServer(
      new DiscordRestClient({
        request: async (request) => {
          calls.push(request)
          return { id: '12345678901234568' }
        },
      }),
    )
    const client = new Client({ name: 'integration', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    close.push(
      () => client.close(),
      () => server.close(),
    )
    const presentation = {
      type: 'components_v2',
      components: [{ type: 'text', content: '## Release ready' }],
    }
    const validation = await client.callTool({
      name: 'discord_message_validate',
      arguments: { presentation },
    })
    expect(validation.isError).not.toBe(true)
    const sent = await client.callTool({
      name: 'discord_message_send',
      arguments: { channelId: '12345678901234567', presentation },
    })
    expect(sent.isError).not.toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.body).toMatchObject({ flags: 32768 })
  })

  it('rejects an unowned workflow component before a Discord request', async () => {
    let requests = 0
    const server = createServer(
      new DiscordRestClient({
        request: async () => {
          requests += 1
          return { id: '12345678901234568' }
        },
      }),
    )
    const client = new Client({ name: 'integration', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    close.push(
      () => client.close(),
      () => server.close(),
    )
    const result = await client.callTool({
      name: 'discord_message_send',
      arguments: {
        channelId: '12345678901234567',
        presentation: {
          type: 'components_v2',
          components: [
            {
              type: 'actionRow',
              components: [
                {
                  type: 'button',
                  style: 'primary',
                  label: 'Invalid owner',
                  action: { type: 'workflow', key: 'unowned' },
                },
              ],
            },
          ],
        },
      },
    })
    expect(result.isError).toBe(true)
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: expect.stringContaining('published workflow revision') }),
      ]),
    )
    expect(requests).toBe(0)
  })
})
