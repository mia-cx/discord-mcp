import { Effect, Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import { encodeComponentsV2, encodePresentation } from '../src/encode.ts'
import { COMPONENT_TYPE, IS_COMPONENTS_V2 } from '../src/limits.ts'
import { asciiLayout } from '../src/preview.ts'
import { ComponentsV2TopLevel, MessagePresentation } from '../src/schema.ts'
import { validateComponentsV2 } from '../src/validate.ts'

const decode = Schema.decodeUnknownEffect(MessagePresentation, { errors: 'all' })
const decodeComponent = Schema.decodeUnknownEffect(ComponentsV2TopLevel, { errors: 'all' })

const accepts = async (value: unknown) =>
  (await Effect.runPromiseExit(decode(value)))._tag === 'Success'
const acceptsComponent = async (value: unknown) =>
  (await Effect.runPromiseExit(decodeComponent(value)))._tag === 'Success'

const text = (content = 'hello') => ({ type: 'text', content })
const action = { type: 'workflow', key: 'ack' }

const encode = (components: ReadonlyArray<unknown>, attachments: ReadonlyArray<unknown> = []) =>
  Effect.runPromiseExit(
    encodeComponentsV2(
      components as ReadonlyArray<ComponentsV2TopLevel>,
      attachments as never,
      undefined,
      { resolveCustomId: (_a, path) => `handle:${path}` },
    ),
  )

describe('the flag', () => {
  it('is set automatically and is not something an author can toggle', async () => {
    const exit = await encode([text()])
    expect(exit._tag).toBe('Success')
    if (exit._tag !== 'Success') return
    expect(exit.value.payload.flags).toBe(IS_COMPONENTS_V2)
    expect(IS_COMPONENTS_V2).toBe(32_768)
  })

  it('clears every legacy field in the same request when upgrading a legacy message', async () => {
    // Discord answers 400 unless content, poll, embeds, and sticker_ids are all cleared together.
    const exit = await Effect.runPromiseExit(
      encodeComponentsV2([text()] as never, [], undefined, { upgradingFromLegacy: true }),
    )
    expect(exit._tag).toBe('Success')
    if (exit._tag !== 'Success') return

    const { payload } = exit.value
    expect(payload.content).toBeNull()
    expect(payload.poll).toBeNull()
    expect(payload.embeds).toEqual([])
    expect(payload.sticker_ids).toEqual([])
  })
})

describe('legacy fields cannot appear under Components V2', () => {
  it('is unrepresentable once excess properties are rejected, as the tool boundary does', async () => {
    const strict = Schema.decodeUnknownEffect(MessagePresentation, {
      errors: 'all',
      onExcessProperty: 'error',
    })
    const rejects = async (v: unknown) =>
      (await Effect.runPromiseExit(strict(v)))._tag === 'Failure'

    expect(await rejects({ type: 'components_v2', components: [text()], content: 'hi' })).toBe(true)
    expect(
      await rejects({ type: 'components_v2', components: [text()], embeds: [{ title: 'x' }] }),
    ).toBe(true)
    // The valid shape still decodes.
    expect(await accepts({ type: 'components_v2', components: [text()] })).toBe(true)
  })

  it('is also rejected at the encoder, since a rendered template can arrive that way', async () => {
    const exit = await Effect.runPromiseExit(
      encodePresentation({ type: 'components_v2', components: [text()], content: 'hi' } as never),
    )
    expect(exit._tag).toBe('Failure')
    expect(JSON.stringify(exit)).toContain('refused, not ignored')
  })
})

describe('nesting rules', () => {
  it('rejects a Container inside a Container', () => {
    const report = validateComponentsV2([
      { type: 'container', components: [{ type: 'container', components: [text()] }] },
    ] as never)
    expect(report.errors.join()).toContain('cannot nest inside a Container')
  })

  it('rejects a Section inside a Section', () => {
    const report = validateComponentsV2([
      {
        type: 'section',
        components: [
          {
            type: 'section',
            components: [text()],
            accessory: { type: 'thumbnail', media: 'https://x/y.png' },
          },
        ],
        accessory: { type: 'thumbnail', media: 'https://x/y.png' },
      },
    ] as never)
    expect(report.errors.join()).toContain('cannot nest inside a Section')
  })

  it('makes a Thumbnail reachable only as a Section accessory', async () => {
    // Structurally: a bare Thumbnail is not a member of the top-level union.
    expect(await acceptsComponent({ type: 'thumbnail', media: 'https://x/y.png' })).toBe(false)

    const report = validateComponentsV2([{ type: 'thumbnail', media: 'https://x/y.png' }] as never)
    expect(report.errors.join()).toContain('only as a Section accessory')

    // But it is valid in the one place Discord allows it.
    expect(
      await acceptsComponent({
        type: 'section',
        components: [text()],
        accessory: { type: 'thumbnail', media: 'https://x/y.png' },
      }),
    ).toBe(true)
  })

  it('requires a Section accessory', async () => {
    expect(await acceptsComponent({ type: 'section', components: [text()] })).toBe(false)
  })

  it('bounds a Section to 1-3 text displays', async () => {
    const section = (n: number) => ({
      type: 'section',
      components: Array.from({ length: n }, () => text()),
      accessory: { type: 'thumbnail', media: 'https://x/y.png' },
    })
    expect(await acceptsComponent(section(0))).toBe(false)
    expect(await acceptsComponent(section(3))).toBe(true)
    expect(await acceptsComponent(section(4))).toBe(false)
  })
})

describe('hard limits reject', () => {
  it('counts components recursively against the 40 limit', () => {
    const many = Array.from({ length: 41 }, () => text())
    const report = validateComponentsV2(many as never)
    expect(report.componentCount).toBe(41)
    expect(report.errors.join()).toContain('counted recursively')
  })

  it('refuses a mix of buttons and a select in one ActionRow', () => {
    const report = validateComponentsV2([
      {
        type: 'actionRow',
        components: [
          { type: 'button', style: 'primary', label: 'a', action },
          { type: 'stringSelect', action, options: [{ label: 'x', value: 'x' }] },
        ],
      },
    ] as never)
    expect(report.errors.join()).toContain('never a mix')
  })

  it('bounds MediaGallery to 1-10 items', async () => {
    const gallery = (n: number) => ({
      type: 'mediaGallery',
      items: Array.from({ length: n }, () => ({ media: 'https://x/y.png' })),
    })
    expect(await acceptsComponent(gallery(0))).toBe(false)
    expect(await acceptsComponent(gallery(10))).toBe(true)
    expect(await acceptsComponent(gallery(11))).toBe(false)
  })

  it('bounds TextDisplay content to 1-4000 characters', async () => {
    expect(await acceptsComponent({ type: 'text', content: '' })).toBe(false)
    expect(await acceptsComponent({ type: 'text', content: 'x'.repeat(4000) })).toBe(true)
    expect(await acceptsComponent({ type: 'text', content: 'x'.repeat(4001) })).toBe(false)
  })

  it('rejects duplicate explicit numeric ids', () => {
    const report = validateComponentsV2([
      { type: 'text', id: 7, content: 'a' },
      { type: 'text', id: 7, content: 'b' },
    ] as never)
    expect(report.errors.join()).toContain('Duplicate explicit component id')
  })

  it('requires every interactive component to bind to a handler', () => {
    const report = validateComponentsV2([
      { type: 'actionRow', components: [{ type: 'button', style: 'primary', label: 'go' }] },
    ] as never)
    expect(report.errors.join()).toContain('must bind')
  })

  it('needs no handler for link and premium buttons, which never fire an interaction', () => {
    const report = validateComponentsV2([
      {
        type: 'actionRow',
        components: [
          { type: 'button', style: 'link', label: 'docs', url: 'https://example.com' },
          { type: 'button', style: 'premium', skuId: '123456789012345678' },
        ],
      },
    ] as never)
    expect(report.errors).toEqual([])
  })
})

describe('advisory limits warn but never reject', () => {
  it('warns above 10 top-level components', () => {
    const report = validateComponentsV2(Array.from({ length: 11 }, () => text()) as never)
    expect(report.warnings.join()).toContain('top-level')
    expect(report.errors.join()).not.toContain('top-level')
  })

  it('warns above the message-wide 4000-character budget', () => {
    const report = validateComponentsV2([text('x'.repeat(3000)), text('y'.repeat(2000))] as never)
    expect(report.warnings.join()).toContain('undocumented')
    expect(report.errors).toEqual([])
  })

  it('warns above 10 container children', () => {
    const report = validateComponentsV2([
      { type: 'container', components: Array.from({ length: 11 }, () => text()) },
    ] as never)
    expect(report.warnings.join()).toContain('JSDoc')
    expect(report.errors).toEqual([])
  })
})

describe('attachment references', () => {
  const attachment = (filename: string) => ({ kind: 'blob', filename, blobId: 'b1' })

  it('resolves each reference exactly once', () => {
    const report = validateComponentsV2(
      [
        { type: 'file', file: 'attachment://a.pdf' },
        { type: 'file', file: 'attachment://a.pdf' },
      ] as never,
      [attachment('a.pdf')] as never,
    )
    expect(report.errors.join()).toContain('referenced 2 times')
  })

  it('rejects a reference to an attachment that was not supplied', () => {
    const report = validateComponentsV2(
      [{ type: 'file', file: 'attachment://missing.pdf' }] as never,
      [],
    )
    expect(report.errors.join()).toContain('no attachment with that filename')
  })

  it('warns about an uploaded attachment nothing references', () => {
    // The most common silent failure in V2: it uploads and renders nowhere.
    const report = validateComponentsV2([text()] as never, [attachment('unused.png')] as never)
    expect(report.warnings.join()).toContain('invisible')
  })

  it('rejects an https URL in a File component, which Discord refuses', async () => {
    expect(await acceptsComponent({ type: 'file', file: 'https://example.com/a.pdf' })).toBe(false)
  })

  it('accepts an https URL in a Thumbnail, which Discord allows', async () => {
    expect(
      await acceptsComponent({
        type: 'section',
        components: [text()],
        accessory: { type: 'thumbnail', media: 'https://example.com/a.png' },
      }),
    ).toBe(true)
  })
})

describe('the encoder maps semantic tags to Discord wire types', () => {
  it('emits the documented numeric types', async () => {
    const exit = await encode([
      {
        type: 'container',
        accentColor: 0x58_65_f2,
        components: [
          text('## Weekly status'),
          { type: 'separator', spacing: 'large' },
          {
            type: 'section',
            components: [text('Details')],
            accessory: { type: 'button', style: 'primary', label: 'Ack', action },
          },
          {
            type: 'actionRow',
            components: [{ type: 'button', style: 'link', label: 'Docs', url: 'https://x' }],
          },
        ],
      },
    ])
    expect(exit._tag).toBe('Success')
    if (exit._tag !== 'Success') return

    const container = (exit.value.payload.components as Array<Record<string, unknown>>)[0]
    expect(container?.type).toBe(COMPONENT_TYPE.container)
    // accent_color is a decimal integer on the wire, never a hex string.
    expect(container?.accent_color).toBe(5_793_266)

    const children = container?.components as Array<Record<string, unknown>>
    expect(children[0]?.type).toBe(COMPONENT_TYPE.textDisplay)
    expect(children[1]).toMatchObject({ type: COMPONENT_TYPE.separator, spacing: 2 })
    expect(children[2]?.type).toBe(COMPONENT_TYPE.section)
    expect((children[2]?.accessory as Record<string, unknown> | undefined)?.style).toBe(1)
    expect(
      (children[3]?.components as Array<Record<string, unknown>> | undefined)?.[0]?.style,
    ).toBe(5)
  })

  it('gives an interactive button an opaque handle and a link button a url', async () => {
    const exit = await encode([
      {
        type: 'actionRow',
        components: [
          { type: 'button', style: 'danger', label: 'Delete', action },
          { type: 'button', style: 'link', label: 'Docs', url: 'https://x' },
          { type: 'button', style: 'premium', skuId: '123456789012345678' },
        ],
      },
    ])
    expect(exit._tag).toBe('Success')
    if (exit._tag !== 'Success') return

    const row = (exit.value.payload.components as Array<Record<string, unknown>>)[0]
    const [danger, link, premium] = (row?.components ?? []) as Array<Record<string, unknown>>

    expect(danger?.custom_id).toBe('handle:components.0.components.0')
    expect(danger?.url).toBeUndefined()
    expect(link?.url).toBe('https://x')
    expect(link?.custom_id).toBeUndefined()
    // A premium button carries a SKU and nothing else.
    expect(premium).toEqual({ type: COMPONENT_TYPE.button, style: 6, sku_id: '123456789012345678' })
  })

  it('never emits component type 16, which is unstable and undocumented', async () => {
    const exit = await encode([{ type: 'container', components: [text(), { type: 'separator' }] }])
    expect(JSON.stringify(exit)).not.toContain('"type":16')
  })
})

describe('mention safety', () => {
  it('defaults to mentioning nothing', async () => {
    const exit = await encode([text('hello @everyone')])
    expect(exit._tag).toBe('Success')
    if (exit._tag !== 'Success') return
    expect(exit.value.payload.allowed_mentions).toEqual({ parse: [], replied_user: false })
  })

  it('refuses @everyone without the mentions:broad scope rather than silently dropping it', async () => {
    const exit = await Effect.runPromiseExit(
      encodeComponentsV2([text()] as never, [], { everyone: true }, { allowBroadMentions: false }),
    )
    expect(exit._tag).toBe('Failure')
    expect(JSON.stringify(exit)).toContain('mentions:broad')
  })

  it('allows @everyone when the scope is held', async () => {
    const exit = await Effect.runPromiseExit(
      encodeComponentsV2([text()] as never, [], { everyone: true }, { allowBroadMentions: true }),
    )
    expect(exit._tag).toBe('Success')
    if (exit._tag !== 'Success') return
    expect((exit.value.payload.allowed_mentions as { parse: string[] }).parse).toEqual(['everyone'])
  })

  it('allowlists specific users and roles without opening it up', async () => {
    const exit = await Effect.runPromiseExit(
      encodeComponentsV2([text()] as never, [], { users: ['123456789012345678'] }, {}),
    )
    expect(exit._tag).toBe('Success')
    if (exit._tag !== 'Success') return
    expect(exit.value.payload.allowed_mentions).toEqual({
      parse: [],
      users: ['123456789012345678'],
      replied_user: false,
    })
  })
})

describe('ASCII layout preview', () => {
  it('shows the structure the model just described', () => {
    const layout = asciiLayout([
      {
        type: 'container',
        accentColor: 0x58_65_f2,
        components: [
          text('## Weekly status'),
          {
            type: 'section',
            components: [text('The report is ready.')],
            accessory: { type: 'button', style: 'primary', label: 'Acknowledge', action },
          },
        ],
      },
    ] as never)

    expect(layout).toContain('Container  accent #5865f2')
    expect(layout).toContain('Text  "## Weekly status"')
    expect(layout).toContain('accessory: Button[primary] "Acknowledge" -> workflow:ack')
    // Tree drawing, so nesting is visible at a glance.
    expect(layout).toContain('└─')
  })

  it('marks an unbound interactive component', () => {
    const layout = asciiLayout([
      { type: 'actionRow', components: [{ type: 'button', style: 'primary', label: 'x' }] },
    ] as never)
    expect(layout).toContain('UNBOUND')
  })
})
