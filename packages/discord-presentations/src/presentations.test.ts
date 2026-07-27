import { MessageFlags } from 'discord-api-types/v10'
import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import { encodeMessage, encodeModal, encodeV2Upgrade } from './encoder.js'
import { MessagePresentationSchema, ModalPresentationSchema } from './schemas.js'
import type { MessagePresentation } from './types.js'
import { PresentationValidationError, validateMessage, validateModal } from './validation.js'

const announcement: Extract<MessagePresentation, { type: 'components_v2' }> = {
  type: 'components_v2',
  components: [
    {
      type: 'container',
      accentColor: 0x5865f2,
      components: [
        { type: 'text', content: '## Release\nHello <@12345678901234567>' },
        {
          type: 'section',
          components: [{ type: 'text', content: 'The build is ready.' }],
          accessory: {
            type: 'thumbnail',
            media: { url: 'https://example.test/image.png' },
          },
        },
        { type: 'separator', spacing: 'large' },
        {
          type: 'actionRow',
          components: [
            {
              type: 'button',
              style: 'primary',
              label: 'Acknowledge',
              action: { type: 'workflow', key: 'acknowledge' },
            },
          ],
        },
      ],
    },
  ],
}

describe('Components V2 presentations', () => {
  it('advertises structural message and modal schemas through Standard Schema', async () => {
    const message = Schema.toStandardJSONSchemaV1(
      Schema.toStandardSchemaV1(MessagePresentationSchema),
    )
    const modal = Schema.toStandardJSONSchemaV1(Schema.toStandardSchemaV1(ModalPresentationSchema))
    expect(
      await message['~standard'].validate({
        type: 'components_v2',
        components: [{ type: 'text', content: 'Hello' }],
      }),
    ).toHaveProperty('value')
    expect(
      await message['~standard'].validate({
        type: 'components_v2',
        components: [{ type: 'label', label: 'Message-only violation' }],
      }),
    ).toHaveProperty('issues')
    expect(
      await modal['~standard'].validate({
        title: 'Release',
        action: { type: 'event', key: 'submit' },
        components: [{ type: 'file', file: { url: 'attachment://release.txt' } }],
      }),
    ).toHaveProperty('issues')
    const json = message['~standard'].jsonSchema.input({ target: 'draft-2020-12' })
    expect(JSON.stringify(json)).toContain('components_v2')
    expect(JSON.stringify(json)).toContain('mediaGallery')
  })

  it('encodes semantic components and sets the V2 flag safely', () => {
    const encoded = encodeMessage(announcement, 'revision:1')
    expect(encoded.payload.flags).toBe(MessageFlags.IsComponentsV2)
    expect(encoded.payload).not.toHaveProperty('content')
    expect(encoded.payload.allowed_mentions).toEqual({
      parse: [],
      users: [],
      roles: [],
      replied_user: false,
    })
    expect(encoded.report.componentCount).toBe(8)
    expect(encoded.report.mentions.users).toEqual(['12345678901234567'])
    expect(encoded.report.interactiveBindings[0]?.customId).toMatch(/^dcmcp_/)
    expect(encoded.layout).toContain('Acknowledge')
  })

  it('clears incompatible legacy fields during a V1 to V2 edit', () => {
    expect(encodeV2Upgrade(announcement).payload).toMatchObject({
      content: null,
      poll: null,
      embeds: [],
      sticker_ids: [],
    })
  })

  it('rejects mixed buttons and selects in one action row', () => {
    expect(() =>
      validateMessage({
        type: 'components_v2',
        components: [
          {
            type: 'actionRow',
            components: [
              {
                type: 'button',
                style: 'primary',
                label: 'Go',
                action: { type: 'event', key: 'go' },
              },
              {
                type: 'select',
                kind: 'user',
                action: { type: 'event', key: 'select' },
              },
            ],
          },
        ],
      }),
    ).toThrow(PresentationValidationError)
  })

  it('rejects more than 40 recursively counted components', () => {
    expect(() =>
      validateMessage({
        type: 'components_v2',
        components: Array.from({ length: 11 }, (_, outer) => ({
          type: 'container' as const,
          components: Array.from({ length: 3 }, (_, inner) => ({
            type: 'text' as const,
            content: `${outer}.${inner}`,
          })),
        })),
      }),
    ).toThrow(/maximum is 40/)
  })

  it('warns, rather than rejects, advisory limits and invisible uploads', () => {
    const report = validateMessage({
      type: 'components_v2',
      components: Array.from({ length: 11 }, (_, index) => ({
        type: 'text' as const,
        content: String(index),
      })),
      attachments: [
        {
          source: 'inline',
          filename: 'unused.txt',
          data: Buffer.from('hello').toString('base64'),
        },
      ],
    })
    expect(report.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('10 top-level'),
        expect.stringContaining('will be invisible'),
      ]),
    )
  })

  it('requires every attachment reference to resolve exactly once', () => {
    expect(() =>
      validateMessage({
        type: 'components_v2',
        components: [{ type: 'file', file: { url: 'attachment://missing.pdf' } }],
      }),
    ).toThrow(/missing attachment/)
  })

  it('emits normalized multipart attachment metadata', () => {
    const encoded = encodeMessage({
      type: 'components_v2',
      components: [{ type: 'file', file: { url: 'attachment://report.pdf' } }],
      attachments: [
        {
          source: 'inline',
          filename: 'report.pdf',
          data: Buffer.from('report').toString('base64'),
        },
      ],
    })
    expect(encoded.payload.attachments).toEqual([{ id: 0, filename: 'report.pdf' }])
  })

  it('keeps modal-only inputs in the modal validator', () => {
    expect(
      validateModal({
        title: 'Feedback',
        action: { type: 'workflow', key: 'feedback' },
        components: [
          {
            type: 'label',
            label: 'Comment',
            component: { type: 'textInput', key: 'comment', style: 'paragraph' },
          },
        ],
      }).componentCount,
    ).toBe(1)
  })

  it('encodes every documented modal-only input with semantic discriminators', () => {
    const encoded = encodeModal({
      title: 'Release',
      action: { type: 'workflow', key: 'release' },
      components: [
        {
          type: 'label',
          label: 'Attachment',
          component: { type: 'fileUpload', key: 'artifact', maxValues: 2 },
        },
        {
          type: 'label',
          label: 'Environment',
          component: {
            type: 'radioGroup',
            key: 'environment',
            options: [{ label: 'Production', value: 'production' }],
          },
        },
        {
          type: 'label',
          label: 'Checks',
          component: {
            type: 'checkboxGroup',
            key: 'checks',
            options: [{ label: 'Tests passed', value: 'tests' }],
          },
        },
        {
          type: 'label',
          label: 'Confirm',
          component: { type: 'checkbox', key: 'confirm', default: true },
        },
      ],
    })
    expect(
      (encoded.payload.components as Array<{ component: { type: number } }>).map(
        ({ component }) => component.type,
      ),
    ).toEqual([19, 21, 22, 23])
    expect(encoded.report.interactiveBindings).toHaveLength(1)
  })
})
