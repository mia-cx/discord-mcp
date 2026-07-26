import { ValidationError } from '@discord-mcp/core'
import { Effect } from 'effect'
import { BUTTON_STYLE, COMPONENT_TYPE, IS_COMPONENTS_V2, SEPARATOR_SPACING } from './limits.ts'
import type {
  AllowedMentions,
  AttachmentInput,
  ComponentsV2TopLevel,
  MessagePresentation,
} from './schema.ts'
import { type ValidationReport, validateComponentsV2 } from './validate.ts'

/**
 * Encode a presentation into the exact JSON Discord expects.
 *
 * The encoder owns every numeric detail — component types, button styles, the `IS_COMPONENTS_V2`
 * flag — so an author never writes one and never gets one wrong.
 */

export interface EncodedMessage {
  readonly payload: Record<string, unknown>
  readonly attachments: ReadonlyArray<AttachmentInput>
  readonly report: ValidationReport
  /** Actions the control plane must compile into opaque handles before sending. */
  readonly bindings: ReadonlyArray<{ readonly path: string; readonly action: unknown }>
}

export interface EncodeOptions {
  /**
   * True when editing a message that is currently legacy.
   *
   * Upgrading V1→V2 requires clearing `content`, `poll`, `embeds`, and `sticker_ids` **in the same
   * request**, or Discord answers 400. A V2 message can never be edited back to legacy.
   */
  readonly upgradingFromLegacy?: boolean
  /** Resolves a logical action to the opaque `custom_id` Discord will round-trip. */
  readonly resolveCustomId?: (action: unknown, path: string) => string
  /**
   * Granted when the principal holds `mentions:broad`. Without it, `everyone: true` is refused
   * rather than silently downgraded, because silently not pinging is its own surprise.
   */
  readonly allowBroadMentions?: boolean
}

/**
 * The default. Nothing is mentioned unless explicitly allowlisted.
 *
 * Discord still governs whether the bot *may* mention; this only stops the accident.
 */
export const SAFE_ALLOWED_MENTIONS = { parse: [] as string[], replied_user: false }

const encodeAllowedMentions = (
  mentions: AllowedMentions | undefined,
  allowBroad: boolean,
): Effect.Effect<Record<string, unknown>, ValidationError> => {
  if (mentions === undefined) return Effect.succeed(SAFE_ALLOWED_MENTIONS)

  if (mentions.everyone === true && !allowBroad) {
    return Effect.fail(
      new ValidationError({
        message: '@everyone and @here mentions require the mentions:broad scope.',
        issues: [
          'allowedMentions.everyone: this principal does not hold mentions:broad. Remove it, or ask the user to grant that scope.',
        ],
      }),
    )
  }

  const parse: string[] = []
  if (mentions.everyone === true) parse.push('everyone')

  return Effect.succeed({
    parse,
    ...(mentions.users === undefined ? {} : { users: mentions.users }),
    ...(mentions.roles === undefined ? {} : { roles: mentions.roles }),
    replied_user: mentions.repliedUser ?? false,
  })
}

const encodeEmoji = (emoji: unknown) => emoji

// A flat dispatch over Discord's component types. Splitting it would scatter one wire-format
// mapping across many functions and make it harder, not easier, to check against the docs.
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: see above.
const encodeComponent = (node: unknown, path: string, options: EncodeOptions): unknown => {
  const n = node as Record<string, unknown>
  const id = n.id === undefined ? {} : { id: n.id }

  switch (n.type) {
    case 'text':
      return { type: COMPONENT_TYPE.textDisplay, ...id, content: n.content }

    case 'separator':
      return {
        type: COMPONENT_TYPE.separator,
        ...id,
        ...(n.divider === undefined ? {} : { divider: n.divider }),
        ...(n.spacing === undefined
          ? {}
          : { spacing: SEPARATOR_SPACING[n.spacing as keyof typeof SEPARATOR_SPACING] }),
      }

    case 'thumbnail':
      return {
        type: COMPONENT_TYPE.thumbnail,
        ...id,
        media: { url: n.media },
        ...(n.description === undefined ? {} : { description: n.description }),
        ...(n.spoiler === undefined ? {} : { spoiler: n.spoiler }),
      }

    case 'mediaGallery':
      return {
        type: COMPONENT_TYPE.mediaGallery,
        ...id,
        items: (n.items as ReadonlyArray<Record<string, unknown>>).map((item) => ({
          media: { url: item.media },
          ...(item.description === undefined ? {} : { description: item.description }),
          ...(item.spoiler === undefined ? {} : { spoiler: item.spoiler }),
        })),
      }

    case 'file':
      // Discord's field here is `file`, an unfurled media item — not `attachment_id`.
      return {
        type: COMPONENT_TYPE.file,
        ...id,
        file: { url: n.file },
        ...(n.spoiler === undefined ? {} : { spoiler: n.spoiler }),
      }

    case 'button': {
      const style = n.style as keyof typeof BUTTON_STYLE
      const base = {
        type: COMPONENT_TYPE.button,
        ...id,
        style: BUTTON_STYLE[style],
        ...(n.disabled === undefined ? {} : { disabled: n.disabled }),
      }
      if (style === 'link') {
        return {
          ...base,
          url: n.url,
          ...(n.label === undefined ? {} : { label: n.label }),
          ...(n.emoji === undefined ? {} : { emoji: encodeEmoji(n.emoji) }),
        }
      }
      if (style === 'premium') {
        // Premium buttons carry a SKU and nothing else: label, emoji, and url are all forbidden.
        return { ...base, sku_id: n.skuId }
      }
      return {
        ...base,
        custom_id: options.resolveCustomId?.(n.action, path) ?? `unbound:${path}`,
        ...(n.label === undefined ? {} : { label: n.label }),
        ...(n.emoji === undefined ? {} : { emoji: encodeEmoji(n.emoji) }),
      }
    }

    case 'stringSelect':
    case 'userSelect':
    case 'roleSelect':
    case 'mentionableSelect':
    case 'channelSelect': {
      const selectTypes = {
        stringSelect: COMPONENT_TYPE.stringSelect,
        userSelect: COMPONENT_TYPE.userSelect,
        roleSelect: COMPONENT_TYPE.roleSelect,
        mentionableSelect: COMPONENT_TYPE.mentionableSelect,
        channelSelect: COMPONENT_TYPE.channelSelect,
      }
      return {
        type: selectTypes[n.type as keyof typeof selectTypes],
        ...id,
        custom_id: options.resolveCustomId?.(n.action, path) ?? `unbound:${path}`,
        ...(n.placeholder === undefined ? {} : { placeholder: n.placeholder }),
        ...(n.minValues === undefined ? {} : { min_values: n.minValues }),
        ...(n.maxValues === undefined ? {} : { max_values: n.maxValues }),
        ...(n.disabled === undefined ? {} : { disabled: n.disabled }),
        ...(n.channelTypes === undefined ? {} : { channel_types: n.channelTypes }),
        ...(n.options === undefined
          ? {}
          : {
              options: (n.options as ReadonlyArray<Record<string, unknown>>).map((o) => ({
                label: o.label,
                value: o.value,
                ...(o.description === undefined ? {} : { description: o.description }),
                ...(o.emoji === undefined ? {} : { emoji: encodeEmoji(o.emoji) }),
                ...(o.default === undefined ? {} : { default: o.default }),
              })),
            }),
      }
    }

    case 'section':
      return {
        type: COMPONENT_TYPE.section,
        ...id,
        components: (n.components as ReadonlyArray<unknown>).map((c, i) =>
          encodeComponent(c, `${path}.components.${i}`, options),
        ),
        accessory: encodeComponent(n.accessory, `${path}.accessory`, options),
      }

    case 'actionRow':
      return {
        type: COMPONENT_TYPE.actionRow,
        ...id,
        components: (n.components as ReadonlyArray<unknown>).map((c, i) =>
          encodeComponent(c, `${path}.components.${i}`, options),
        ),
      }

    case 'container':
      return {
        type: COMPONENT_TYPE.container,
        ...id,
        // Discord's wire field is a decimal integer; `null` clears it.
        ...(n.accentColor === undefined ? {} : { accent_color: n.accentColor }),
        ...(n.spoiler === undefined ? {} : { spoiler: n.spoiler }),
        components: (n.components as ReadonlyArray<unknown>).map((c, i) =>
          encodeComponent(c, `${path}.components.${i}`, options),
        ),
      }

    default:
      throw new Error(`Unencodable component type ${JSON.stringify(n.type)} at ${path}`)
  }
}

export const encodeComponentsV2 = (
  components: ReadonlyArray<ComponentsV2TopLevel>,
  attachments: ReadonlyArray<AttachmentInput>,
  allowedMentions: AllowedMentions | undefined,
  options: EncodeOptions = {},
): Effect.Effect<EncodedMessage, ValidationError> =>
  Effect.gen(function* () {
    const report = validateComponentsV2(components, attachments)
    if (report.errors.length > 0) {
      return yield* Effect.fail(
        new ValidationError({
          message: 'The Components V2 layout is not valid.',
          issues: report.errors,
        }),
      )
    }

    const mentions = yield* encodeAllowedMentions(
      allowedMentions,
      options.allowBroadMentions ?? false,
    )

    const payload: Record<string, unknown> = {
      // Set automatically and never toggleable by an author. It is also set-only: once a message
      // carries it, no edit can remove it.
      flags: IS_COMPONENTS_V2,
      components: components.map((c, i) => encodeComponent(c, `components.${i}`, options)),
      allowed_mentions: mentions,
    }

    if (options.upgradingFromLegacy === true) {
      // All four must be cleared in the same request or Discord answers 400.
      payload.content = null
      payload.poll = null
      payload.embeds = []
      payload.sticker_ids = []
    }

    return { payload, attachments, report, bindings: report.bindings }
  })

const legacyForbiddenUnderV2 = ['content', 'embeds', 'stickerIds', 'poll'] as const

export const encodePresentation = (
  presentation: MessagePresentation,
  options: EncodeOptions = {},
): Effect.Effect<EncodedMessage, ValidationError> => {
  if (presentation.type === 'template') {
    return Effect.fail(
      new ValidationError({
        message: 'A template presentation must be rendered before it can be encoded.',
        issues: ['presentation: render it with discord_message_template_render first.'],
      }),
    )
  }

  if (presentation.type === 'components_v2') {
    // Belt and braces: the schema already makes these unrepresentable, but a presentation can
    // arrive from a rendered template, and the failure is worth naming precisely.
    const present = legacyForbiddenUnderV2.filter(
      (k) => (presentation as unknown as Record<string, unknown>)[k] !== undefined,
    )
    if (present.length > 0) {
      return Effect.fail(
        new ValidationError({
          message: 'Components V2 cannot carry legacy message fields.',
          issues: present.map(
            (k) =>
              `${k}: Components V2 rejects content, embeds, sticker_ids, and poll outright — they are refused, not ignored. Express this as a text component instead.`,
          ),
        }),
      )
    }
    return encodeComponentsV2(
      presentation.components,
      presentation.attachments ?? [],
      presentation.allowedMentions,
      options,
    )
  }

  return Effect.gen(function* () {
    const mentions = yield* encodeAllowedMentions(
      presentation.allowedMentions,
      options.allowBroadMentions ?? false,
    )
    const payload: Record<string, unknown> = {
      ...(presentation.content === undefined ? {} : { content: presentation.content }),
      ...(presentation.embeds === undefined ? {} : { embeds: presentation.embeds }),
      ...(presentation.components === undefined
        ? {}
        : {
            components: presentation.components.map((c, i) =>
              encodeComponent(c, `components.${i}`, options),
            ),
          }),
      allowed_mentions: mentions,
    }

    return {
      payload,
      attachments: presentation.attachments ?? [],
      report: {
        errors: [],
        warnings: [],
        componentCount: presentation.components?.length ?? 0,
        maxDepth: presentation.components === undefined ? 0 : 2,
        referencedAttachments: [],
        numericIds: [],
        bindings: [],
        totalTextChars: presentation.content?.length ?? 0,
      },
      bindings: [],
    }
  })
}
