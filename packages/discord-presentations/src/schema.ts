import { Snowflake } from '@discord-mcp/core'
import { Schema } from 'effect'
import { HARD_LIMITS } from './limits.ts'

/**
 * Components V2 with **semantic discriminators** — `text`, `section`, `container` — rather than
 * Discord's numeric types.
 *
 * A model emits `type: "text"` correctly far more often than `type: 10`, and the numeric mapping
 * is a detail the encoder should own rather than something an author has to remember. The schema
 * also models allowed child and accessory relationships *structurally*, so an illegal tree is a
 * decode failure with a field path rather than a Discord 400 with a nested error blob.
 */

/**
 * Length bounds for any schema whose `Type` has a `length` — strings and arrays alike.
 *
 * Generic over the schema rather than the element type, because `Schema.check` rebuilds `self` and
 * a non-generic helper would erase the schema's own type on the way through.
 */
const bounded =
  <S extends Schema.Top & { readonly Type: { readonly length: number } }>(
    min: number,
    max: number,
  ) =>
  (self: S): S['Rebuild'] =>
    Schema.check<S>(Schema.isMinLength(min), Schema.isMaxLength(max))(self)

/**
 * Server-generated opaque handle. Authors never construct one.
 *
 * Discord round-trips `custom_id` through the client, so anything encoded in it is untrusted input
 * on the way back. Treating it as trusted data would be a genuine vulnerability; state lives
 * server-side and this is only a lookup key.
 */
export const CustomId = Schema.String.pipe(
  bounded(HARD_LIMITS.customIdMinChars, HARD_LIMITS.customIdMaxChars),
)

/** What an interactive component does when used. The control plane compiles this to a handle. */
export const ComponentAction = Schema.Union([
  Schema.Struct({
    type: Schema.Literal('workflow'),
    key: Schema.String.pipe(bounded(1, 64)).annotate({
      description: 'Logical action name declared by a published workflow revision.',
    }),
  }),
  Schema.Struct({
    type: Schema.Literal('inbox'),
    key: Schema.String.pipe(bounded(1, 64)).annotate({
      description: 'Persisted event-inbox key; interactions land in the durable inbox.',
    }),
  }),
]).annotate({
  title: 'ComponentAction',
  description:
    'Every interactive component binds to one of these. Link and premium buttons need no action because Discord never fires an interaction for them.',
})

const Emoji = Schema.Struct({
  id: Schema.optionalKey(Snowflake),
  name: Schema.optionalKey(Schema.String),
  animated: Schema.optionalKey(Schema.Boolean),
})

// ---------------------------------------------------------------- buttons

const buttonBase = {
  id: Schema.optionalKey(Schema.Int),
  label: Schema.optionalKey(Schema.String.pipe(bounded(1, HARD_LIMITS.buttonLabelChars))),
  emoji: Schema.optionalKey(Emoji),
  disabled: Schema.optionalKey(Schema.Boolean),
}

/**
 * A discriminated union on style, so the style↔field matrix is a type error rather than a 400.
 *
 * Styles 1–4 require `custom_id` and forbid `url`; style 5 requires `url` and forbids `custom_id`;
 * style 6 requires `sku_id` and forbids label, emoji, and url.
 */
const InteractiveButton = Schema.Struct({
  type: Schema.Literal('button'),
  style: Schema.Literals(['primary', 'secondary', 'success', 'danger']),
  ...buttonBase,
  action: ComponentAction,
})

const LinkButton = Schema.Struct({
  type: Schema.Literal('button'),
  style: Schema.Literal('link'),
  ...buttonBase,
  url: Schema.String.pipe(Schema.check(Schema.isStartsWith('http'))),
})

const PremiumButton = Schema.Struct({
  type: Schema.Literal('button'),
  style: Schema.Literal('premium'),
  id: Schema.optionalKey(Schema.Int),
  disabled: Schema.optionalKey(Schema.Boolean),
  skuId: Snowflake,
})

export const Button = Schema.Union([InteractiveButton, LinkButton, PremiumButton]).annotate({
  title: 'Button',
})

// ---------------------------------------------------------------- selects

const selectBase = {
  id: Schema.optionalKey(Schema.Int),
  action: ComponentAction,
  placeholder: Schema.optionalKey(Schema.String.pipe(bounded(1, 150))),
  minValues: Schema.optionalKey(
    Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 25 }))),
  ),
  maxValues: Schema.optionalKey(
    Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 25 }))),
  ),
  disabled: Schema.optionalKey(Schema.Boolean),
}

const StringSelectOption = Schema.Struct({
  label: Schema.String.pipe(bounded(1, 100)),
  value: Schema.String.pipe(bounded(1, 100)),
  description: Schema.optionalKey(Schema.String.pipe(bounded(1, 100))),
  emoji: Schema.optionalKey(Emoji),
  default: Schema.optionalKey(Schema.Boolean),
})

const StringSelect = Schema.Struct({
  type: Schema.Literal('stringSelect'),
  ...selectBase,
  options: Schema.Array(StringSelectOption).pipe(bounded(1, HARD_LIMITS.stringSelectOptions)),
})

const UserSelect = Schema.Struct({ type: Schema.Literal('userSelect'), ...selectBase })
const RoleSelect = Schema.Struct({ type: Schema.Literal('roleSelect'), ...selectBase })
const MentionableSelect = Schema.Struct({
  type: Schema.Literal('mentionableSelect'),
  ...selectBase,
})
const ChannelSelect = Schema.Struct({
  type: Schema.Literal('channelSelect'),
  ...selectBase,
  channelTypes: Schema.optionalKey(Schema.Array(Schema.Int)),
})

export const Select = Schema.Union([
  StringSelect,
  UserSelect,
  RoleSelect,
  MentionableSelect,
  ChannelSelect,
])

// ---------------------------------------------------------------- content components

export const Text = Schema.Struct({
  type: Schema.Literal('text'),
  id: Schema.optionalKey(Schema.Int),
  content: Schema.String.pipe(
    bounded(HARD_LIMITS.textDisplayMinChars, HARD_LIMITS.textDisplayMaxChars),
  ).annotate({
    description: 'Markdown. Mentions, custom emoji, headings, -# subtext.',
  }),
}).annotate({
  title: 'Text',
  description: 'Markdown block. The V2 replacement for message content and embed description.',
})

/**
 * `attachment://filename` or an https URL.
 *
 * File components accept **only** the attachment protocol; Thumbnail and MediaGallery accept
 * either.
 */
const MediaUrl = Schema.String.pipe(Schema.check(Schema.isMinLength(1))).annotate({
  description:
    'Either "attachment://<filename>" referencing an uploaded attachment, or an https URL.',
})

export const Thumbnail = Schema.Struct({
  type: Schema.Literal('thumbnail'),
  id: Schema.optionalKey(Schema.Int),
  media: MediaUrl,
  description: Schema.optionalKey(
    Schema.String.pipe(bounded(1, HARD_LIMITS.mediaDescriptionChars)),
  ),
  spoiler: Schema.optionalKey(Schema.Boolean),
}).annotate({
  title: 'Thumbnail',
  description: 'Reachable only as a Section accessory. It is not a top-level or container child.',
})

const MediaGalleryItem = Schema.Struct({
  media: MediaUrl,
  description: Schema.optionalKey(
    Schema.String.pipe(bounded(1, HARD_LIMITS.mediaDescriptionChars)),
  ),
  spoiler: Schema.optionalKey(Schema.Boolean),
})

export const MediaGallery = Schema.Struct({
  type: Schema.Literal('mediaGallery'),
  id: Schema.optionalKey(Schema.Int),
  items: Schema.Array(MediaGalleryItem).pipe(
    bounded(HARD_LIMITS.mediaGalleryMinItems, HARD_LIMITS.mediaGalleryMaxItems),
  ),
})

export const File = Schema.Struct({
  type: Schema.Literal('file'),
  id: Schema.optionalKey(Schema.Int),
  /**
   * Discord's wire field here is `file`, an unfurled media item — not `attachment_id` — and it
   * accepts the `attachment:` protocol only.
   */
  file: Schema.String.pipe(Schema.check(Schema.isStartsWith('attachment://'))).annotate({
    description: 'Must be "attachment://<filename>". https URLs are rejected by Discord here.',
  }),
  spoiler: Schema.optionalKey(Schema.Boolean),
})

export const Separator = Schema.Struct({
  type: Schema.Literal('separator'),
  id: Schema.optionalKey(Schema.Int),
  divider: Schema.optionalKey(Schema.Boolean),
  spacing: Schema.optionalKey(Schema.Literals(['small', 'large'])),
})

/** 1–3 TextDisplays plus a **required** accessory. Sections cannot nest. */
export const Section = Schema.Struct({
  type: Schema.Literal('section'),
  id: Schema.optionalKey(Schema.Int),
  components: Schema.Array(Text).pipe(
    bounded(HARD_LIMITS.sectionMinTextDisplays, HARD_LIMITS.sectionMaxTextDisplays),
  ),
  accessory: Schema.Union([Button, Thumbnail]).annotate({
    description: 'Required. A Section without an accessory is rejected by Discord.',
  }),
})

/** Five buttons XOR one select. The encoder enforces the exclusivity; the schema allows both. */
export const ActionRow = Schema.Struct({
  type: Schema.Literal('actionRow'),
  id: Schema.optionalKey(Schema.Int),
  components: Schema.Array(Schema.Union([Button, Select])).pipe(
    bounded(1, HARD_LIMITS.actionRowButtons),
  ),
})

/**
 * Containers cannot nest, and cannot hold a bare Thumbnail or Button — those are reachable only
 * through a Section accessory or an ActionRow. Expressing that structurally is what stops an
 * illegal tree before it becomes a 400.
 */
export const Container = Schema.Struct({
  type: Schema.Literal('container'),
  id: Schema.optionalKey(Schema.Int),
  accentColor: Schema.optionalKey(
    Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 0xff_ff_ff }))).annotate({
      description:
        'A decimal integer, not a hex string. Write it as 0x5865f2 in source; Discord receives 5793266.',
    }),
  ),
  spoiler: Schema.optionalKey(Schema.Boolean),
  components: Schema.Array(
    Schema.Union([ActionRow, Text, Section, MediaGallery, Separator, File]),
  ).pipe(Schema.check(Schema.isMinLength(1))),
})

export const ComponentsV2TopLevel = Schema.Union([
  ActionRow,
  Container,
  File,
  MediaGallery,
  Section,
  Separator,
  Text,
])
export type ComponentsV2TopLevel = typeof ComponentsV2TopLevel.Type

// ---------------------------------------------------------------- attachments and mentions

/**
 * MCP inputs never accept an arbitrary local filesystem path.
 *
 * The transport can be remote and authenticated, so a path would let a remote principal read
 * arbitrary server files. Bounded inline base64 or a named blob reference only.
 */
export const AttachmentInput = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('inline'),
    filename: Schema.String.pipe(bounded(1, 200)),
    contentType: Schema.optionalKey(Schema.String),
    base64: Schema.String.pipe(Schema.check(Schema.isMaxLength(8 * 1024 * 1024))),
    description: Schema.optionalKey(Schema.String.pipe(bounded(1, 1024))),
  }),
  Schema.Struct({
    kind: Schema.Literal('blob'),
    filename: Schema.String.pipe(bounded(1, 200)),
    blobId: Schema.String.pipe(bounded(1, 128)),
    description: Schema.optionalKey(Schema.String.pipe(bounded(1, 1024))),
  }),
])
export type AttachmentInput = typeof AttachmentInput.Type

/**
 * Mention policy. The default allows nothing.
 *
 * This is a safe default rather than a permission gate — Discord still governs whether the bot
 * *may* mention — but it prevents the most embarrassing accident available to an automated system.
 */
export const AllowedMentions = Schema.Struct({
  users: Schema.optionalKey(Schema.Array(Snowflake)),
  roles: Schema.optionalKey(Schema.Array(Snowflake)),
  everyone: Schema.optionalKey(
    Schema.Boolean.annotate({
      description: 'Requires the mentions:broad scope and an explicit request. Defaults to false.',
    }),
  ),
  repliedUser: Schema.optionalKey(Schema.Boolean),
})
export type AllowedMentions = typeof AllowedMentions.Type

// ---------------------------------------------------------------- legacy

const EmbedField = Schema.Struct({
  name: Schema.String.pipe(bounded(1, 256)),
  value: Schema.String.pipe(bounded(1, 1024)),
  inline: Schema.optionalKey(Schema.Boolean),
})

export const Embed = Schema.Struct({
  title: Schema.optionalKey(Schema.String.pipe(bounded(1, 256))),
  description: Schema.optionalKey(Schema.String.pipe(bounded(1, 4096))),
  url: Schema.optionalKey(Schema.String),
  color: Schema.optionalKey(
    Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 0xff_ff_ff }))),
  ),
  timestamp: Schema.optionalKey(Schema.String),
  footer: Schema.optionalKey(
    Schema.Struct({
      text: Schema.String.pipe(bounded(1, 2048)),
      iconUrl: Schema.optionalKey(Schema.String),
    }),
  ),
  image: Schema.optionalKey(Schema.Struct({ url: Schema.String })),
  thumbnail: Schema.optionalKey(Schema.Struct({ url: Schema.String })),
  author: Schema.optionalKey(
    Schema.Struct({
      name: Schema.String.pipe(bounded(1, 256)),
      url: Schema.optionalKey(Schema.String),
      iconUrl: Schema.optionalKey(Schema.String),
    }),
  ),
  fields: Schema.optionalKey(Schema.Array(EmbedField).pipe(Schema.check(Schema.isMaxLength(25)))),
})

// ---------------------------------------------------------------- the canonical type

export const LegacyPresentation = Schema.Struct({
  type: Schema.Literal('legacy'),
  content: Schema.optionalKey(Schema.String.pipe(bounded(1, 2000))),
  embeds: Schema.optionalKey(Schema.Array(Embed).pipe(Schema.check(Schema.isMaxLength(10)))),
  components: Schema.optionalKey(Schema.Array(ActionRow).pipe(Schema.check(Schema.isMaxLength(5)))),
  attachments: Schema.optionalKey(Schema.Array(AttachmentInput)),
  allowedMentions: Schema.optionalKey(AllowedMentions),
})

/**
 * Fields Discord rejects outright when `IS_COMPONENTS_V2` is set — they are refused, not ignored.
 *
 * Declared as `Never` rather than simply omitted, because MCP validates arguments against the
 * advertised schema *before* the handler runs and silently strips anything undeclared. An omitted
 * `content` would therefore vanish on the way in and the message would send without it, losing the
 * author's intent with no error anywhere. Declaring the key makes its presence a decode failure
 * that names it.
 */
const forbiddenUnderV2 = {
  content: Schema.optionalKey(
    Schema.Never.annotate({
      description:
        'Not allowed with Components V2. Use a text component instead; Discord rejects a message that sets both.',
    }),
  ),
  embeds: Schema.optionalKey(
    Schema.Never.annotate({
      description: 'Not allowed with Components V2. Use a container with text components instead.',
    }),
  ),
  stickerIds: Schema.optionalKey(
    Schema.Never.annotate({ description: 'Not allowed with Components V2.' }),
  ),
  poll: Schema.optionalKey(
    Schema.Never.annotate({ description: 'Not allowed with Components V2.' }),
  ),
}

export const ComponentsV2Presentation = Schema.Struct({
  type: Schema.Literal('components_v2'),
  components: Schema.Array(ComponentsV2TopLevel).pipe(Schema.check(Schema.isMinLength(1))),
  attachments: Schema.optionalKey(Schema.Array(AttachmentInput)),
  allowedMentions: Schema.optionalKey(AllowedMentions),
  ...forbiddenUnderV2,
})

export const TemplatePresentation = Schema.Struct({
  type: Schema.Literal('template'),
  templateId: Schema.String.pipe(bounded(1, 128)),
  revision: Schema.optionalKey(Schema.Int),
  variables: Schema.Unknown,
})

export const MessagePresentation = Schema.Union([
  LegacyPresentation,
  ComponentsV2Presentation,
  TemplatePresentation,
]).annotate({
  title: 'MessagePresentation',
  description:
    'One canonical shape for every way this server sends a message. Components V2 cannot carry content, embeds, stickers, or polls — Discord rejects the combination outright.',
})
export type MessagePresentation = typeof MessagePresentation.Type
export type ComponentsV2PresentationType = typeof ComponentsV2Presentation.Type
export type LegacyPresentationType = typeof LegacyPresentation.Type
