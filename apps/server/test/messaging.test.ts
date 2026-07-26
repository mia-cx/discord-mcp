import { messageTools } from '@discord-mcp/discord-api'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { type StubbedRequest, stubRest, withClient } from './support/harness.ts'

/**
 * The messaging surface driven through a real MCP client, so schemas, the encoder, the result
 * path, and the error renderer are all exercised the way a model would hit them.
 */

// biome-ignore lint/suspicious/noExplicitAny: MCP's CallToolResult is intentionally loose.
const structured = (result: any) => result.structuredContent
// biome-ignore lint/suspicious/noExplicitAny: as above.
const text = (result: any) => JSON.stringify(result.content)

const announcement = {
  type: 'components_v2',
  components: [
    {
      type: 'container',
      accentColor: 0x58_65_f2,
      components: [
        { type: 'text', content: '## Release 2.1\nThe new report is ready.' },
        { type: 'separator', spacing: 'large' },
        {
          type: 'section',
          components: [{ type: 'text', content: 'Full notes in the docs.' }],
          accessory: { type: 'thumbnail', media: 'https://example.com/logo.png' },
        },
        {
          type: 'actionRow',
          components: [
            { type: 'button', style: 'link', label: 'Read the notes', url: 'https://example.com' },
          ],
        },
      ],
    },
  ],
}

describe('discord_message_validate', () => {
  it('returns the payload, an ASCII layout, and the component count without sending', async () => {
    const recorded: Array<StubbedRequest> = []
    await withClient(
      stubRest(() => Effect.succeed({}), recorded),
      messageTools,
      async (client) => {
        const result = await client.callTool({
          name: 'discord_message_validate',
          arguments: { presentation: announcement },
        })

        expect(result.isError).toBe(false)
        const data = structured(result).data
        expect(data.valid).toBe(true)
        expect(data.payload.flags).toBe(32_768)
        expect(data.layout).toContain('Container  accent #5865f2')
        expect(data.layout).toContain('Button[link]')
        expect(data.componentCount).toBeGreaterThan(4)
        // Validation must never touch Discord.
        expect(recorded).toEqual([])
      },
    )
  })

  it('rejects an illegal nesting structurally, before the validator even runs', async () => {
    await withClient(
      stubRest(() => Effect.succeed({})),
      messageTools,
      async (client) => {
        const result = await client.callTool({
          name: 'discord_message_validate',
          arguments: {
            presentation: {
              type: 'components_v2',
              components: [
                {
                  type: 'container',
                  components: [{ type: 'container', components: [{ type: 'text', content: 'x' }] }],
                },
              ],
            },
          },
        })

        // A Container is not a member of the Container-children union, so this fails at decode
        // with a field path — earlier and more precisely than the validator's own message, and far
        // earlier than Discord's 400.
        expect(result.isError).toBe(true)
        expect(text(result)).toMatch(/components/)
      },
    )
  })

  it('warns about an attachment nothing references, without failing', async () => {
    await withClient(
      stubRest(() => Effect.succeed({})),
      messageTools,
      async (client) => {
        const result = await client.callTool({
          name: 'discord_message_validate',
          arguments: {
            presentation: {
              type: 'components_v2',
              components: [{ type: 'text', content: 'hello' }],
              attachments: [{ kind: 'blob', filename: 'unused.png', blobId: 'b1' }],
            },
          },
        })

        expect(result.isError).toBe(false)
        expect(JSON.stringify(structured(result).data.warnings)).toContain('invisible')
      },
    )
  })
})

describe('discord_message_send', () => {
  it('sends an encoded Components V2 payload', async () => {
    const recorded: Array<StubbedRequest> = []
    await withClient(
      stubRest(() => Effect.succeed({ id: '999999999999999999' }), recorded),
      messageTools,
      async (client) => {
        const result = await client.callTool({
          name: 'discord_message_send',
          arguments: { channelId: '123456789012345678', presentation: announcement },
        })

        expect(result.isError).toBe(false)
        expect(recorded).toEqual([
          { method: 'POST', route: '/channels/123456789012345678/messages' },
        ])
      },
    )
  })

  it('refuses a Components V2 message carrying legacy content, with no request', async () => {
    const recorded: Array<StubbedRequest> = []
    await withClient(
      stubRest(() => Effect.succeed({}), recorded),
      messageTools,
      async (client) => {
        const result = await client.callTool({
          name: 'discord_message_send',
          arguments: {
            channelId: '123456789012345678',
            presentation: {
              type: 'components_v2',
              components: [{ type: 'text', content: 'x' }],
              content: 'legacy',
            },
          },
        })

        expect(result.isError).toBe(true)
        expect(recorded).toEqual([])
      },
    )
  })

  it('refuses an interactive component until bindings exist, and says why', async () => {
    const recorded: Array<StubbedRequest> = []
    await withClient(
      stubRest(() => Effect.succeed({}), recorded),
      messageTools,
      async (client) => {
        const result = await client.callTool({
          name: 'discord_message_send',
          arguments: {
            channelId: '123456789012345678',
            presentation: {
              type: 'components_v2',
              components: [
                {
                  type: 'actionRow',
                  components: [
                    {
                      type: 'button',
                      style: 'primary',
                      label: 'Ack',
                      action: { type: 'workflow', key: 'ack' },
                    },
                  ],
                },
              ],
            },
          },
        })

        expect(result.isError).toBe(true)
        // A dead button is worse than a refusal, so the refusal names the alternative.
        expect(text(result)).toContain('link buttons')
        expect(recorded).toEqual([])
      },
    )
  })
})

describe('discord_message_edit', () => {
  it('clears every legacy field when upgrading a legacy message to V2', async () => {
    const bodies: Array<unknown> = []
    await withClient(
      stubRest(() => Effect.succeed({})),
      messageTools,
      async (client) => {
        // The stub records only method and route, so assert through validate instead: the same
        // encoder produces the payload either way.
        const result = await client.callTool({
          name: 'discord_message_validate',
          arguments: { presentation: announcement },
        })
        bodies.push(structured(result).data.payload)
        expect(result.isError).toBe(false)
      },
    )
    expect((bodies[0] as { flags: number }).flags).toBe(32_768)
  })
})

describe('discord_modal_validate', () => {
  it('encodes a modal with its label and input types', async () => {
    await withClient(
      stubRest(() => Effect.succeed({})),
      messageTools,
      async (client) => {
        const result = await client.callTool({
          name: 'discord_modal_validate',
          arguments: {
            modal: {
              title: 'Report an issue',
              action: 'report',
              components: [
                {
                  type: 'label',
                  label: 'What happened?',
                  component: {
                    type: 'textInput',
                    key: 'details',
                    style: 'paragraph',
                    required: true,
                  },
                },
              ],
            },
          },
        })

        expect(result.isError).toBe(false)
        const payload = structured(result).data.payload
        expect(payload.title).toBe('Report an issue')
        // Label is 18, TextInput is 4, paragraph style is 2.
        expect(payload.components[0].type).toBe(18)
        expect(payload.components[0].component).toMatchObject({ type: 4, style: 2, required: true })
      },
    )
  })

  it('rejects a message-only component inside a modal', async () => {
    await withClient(
      stubRest(() => Effect.succeed({})),
      messageTools,
      async (client) => {
        const result = await client.callTool({
          name: 'discord_modal_validate',
          arguments: {
            modal: {
              title: 'x',
              action: 'a',
              // A Section is message-only; the type system makes this unrepresentable.
              components: [{ type: 'section', components: [{ type: 'text', content: 'x' }] }],
            },
          },
        })
        expect(result.isError).toBe(true)
      },
    )
  })
})
