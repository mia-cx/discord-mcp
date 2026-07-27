import { Schema } from 'effect'

const JsonValueSchema: Schema.Codec<unknown, unknown> = Schema.suspend(() =>
  Schema.Union([
    Schema.Null,
    Schema.Boolean,
    Schema.Finite,
    Schema.String,
    Schema.Array(JsonValueSchema),
    Schema.Record(Schema.String, JsonValueSchema),
  ]),
).annotate({ identifier: 'DiscordPresentationJsonValue' })

const bounded = (minimum: number, maximum: number) =>
  Schema.String.pipe(Schema.check(Schema.isMinLength(minimum), Schema.isMaxLength(maximum)))
const Snowflake = Schema.String.pipe(Schema.check(Schema.isPattern(/^\d{17,21}$/)))
const ComponentId = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))
const withId = { id: Schema.optionalKey(ComponentId) }

export const InteractionActionSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal('workflow'), key: bounded(1, 100) }),
  Schema.Struct({ type: Schema.Literal('event'), key: bounded(1, 100) }),
])

const Emoji = Schema.Struct({
  id: Schema.optionalKey(Snowflake),
  name: Schema.optionalKey(Schema.String),
  animated: Schema.optionalKey(Schema.Boolean),
})

const Text = Schema.Struct({
  type: Schema.Literal('text'),
  ...withId,
  content: bounded(1, 4_000),
}).annotate({
  title: 'Text display',
  description: 'Markdown text for a Components V2 message or modal.',
})

const InteractiveButton = Schema.Struct({
  type: Schema.Literal('button'),
  ...withId,
  style: Schema.Literals(['primary', 'secondary', 'success', 'danger']),
  label: bounded(1, 80),
  emoji: Schema.optionalKey(Emoji),
  disabled: Schema.optionalKey(Schema.Boolean),
  action: InteractionActionSchema,
})
const LinkButton = Schema.Struct({
  type: Schema.Literal('button'),
  ...withId,
  style: Schema.Literal('link'),
  label: bounded(1, 80),
  url: Schema.String,
  emoji: Schema.optionalKey(Emoji),
  disabled: Schema.optionalKey(Schema.Boolean),
})
const PremiumButton = Schema.Struct({
  type: Schema.Literal('button'),
  ...withId,
  style: Schema.Literal('premium'),
  skuId: Snowflake,
  disabled: Schema.optionalKey(Schema.Boolean),
})
export const ButtonComponentSchema = Schema.Union([InteractiveButton, LinkButton, PremiumButton])

const SelectOption = Schema.Struct({
  label: bounded(1, 100),
  value: bounded(1, 100),
  description: Schema.optionalKey(bounded(1, 100)),
  emoji: Schema.optionalKey(Emoji),
  default: Schema.optionalKey(Schema.Boolean),
})
const SelectBase = {
  type: Schema.Literal('select'),
  ...withId,
  action: InteractionActionSchema,
  placeholder: Schema.optionalKey(bounded(1, 150)),
  minValues: Schema.optionalKey(Schema.Int),
  maxValues: Schema.optionalKey(Schema.Int),
  disabled: Schema.optionalKey(Schema.Boolean),
}
const StringSelect = Schema.Struct({
  ...SelectBase,
  kind: Schema.Literal('string'),
  options: Schema.Array(SelectOption).pipe(
    Schema.check(Schema.isMinLength(1), Schema.isMaxLength(25)),
  ),
})
const EntitySelect = Schema.Struct({
  ...SelectBase,
  kind: Schema.Literals(['user', 'role', 'mentionable', 'channel']),
  channelTypes: Schema.optionalKey(Schema.Array(Schema.Int)),
})
export const SelectComponentSchema = Schema.Union([StringSelect, EntitySelect])

const ActionRow = Schema.Struct({
  type: Schema.Literal('actionRow'),
  ...withId,
  components: Schema.Array(Schema.Union([ButtonComponentSchema, SelectComponentSchema])),
})
const Thumbnail = Schema.Struct({
  type: Schema.Literal('thumbnail'),
  ...withId,
  media: Schema.Struct({ url: Schema.String }),
  description: Schema.optionalKey(bounded(1, 1_024)),
  spoiler: Schema.optionalKey(Schema.Boolean),
})
const Section = Schema.Struct({
  type: Schema.Literal('section'),
  ...withId,
  components: Schema.Array(Text).pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(3))),
  accessory: Schema.Union([ButtonComponentSchema, Thumbnail]),
})
const MediaGalleryItem = Schema.Struct({
  media: Schema.Struct({ url: Schema.String }),
  description: Schema.optionalKey(bounded(1, 1_024)),
  spoiler: Schema.optionalKey(Schema.Boolean),
})
const MediaGallery = Schema.Struct({
  type: Schema.Literal('mediaGallery'),
  ...withId,
  items: Schema.Array(MediaGalleryItem).pipe(
    Schema.check(Schema.isMinLength(1), Schema.isMaxLength(10)),
  ),
})
const File = Schema.Struct({
  type: Schema.Literal('file'),
  ...withId,
  file: Schema.Struct({ url: Schema.String }),
  spoiler: Schema.optionalKey(Schema.Boolean),
})
const Separator = Schema.Struct({
  type: Schema.Literal('separator'),
  ...withId,
  divider: Schema.optionalKey(Schema.Boolean),
  spacing: Schema.optionalKey(Schema.Literals(['small', 'large'])),
})
const ContainerChild = Schema.Union([ActionRow, File, MediaGallery, Section, Separator, Text])
const Container = Schema.Struct({
  type: Schema.Literal('container'),
  ...withId,
  accentColor: Schema.optionalKey(Schema.NullOr(Schema.Int)),
  spoiler: Schema.optionalKey(Schema.Boolean),
  components: Schema.Array(ContainerChild),
})
export const ComponentsV2TopLevelSchema = Schema.Union([
  ActionRow,
  Container,
  File,
  MediaGallery,
  Section,
  Separator,
  Text,
])

export const AttachmentInputSchema = Schema.Union([
  Schema.Struct({
    source: Schema.Literal('inline'),
    filename: bounded(1, 255),
    data: bounded(1, 12 * 1024 * 1024),
    mimeType: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    source: Schema.Literal('blob'),
    blobId: Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-f0-9]{64}$/))),
    filename: bounded(1, 255),
  }),
])
const AllowedMentions = Schema.Struct({
  users: Schema.optionalKey(Schema.Array(Snowflake)),
  roles: Schema.optionalKey(Schema.Array(Snowflake)),
  parse: Schema.optionalKey(Schema.Array(Schema.Literals(['everyone', 'users', 'roles']))),
  repliedUser: Schema.optionalKey(Schema.Boolean),
})
const AttachmentsAndMentions = {
  attachments: Schema.optionalKey(Schema.Array(AttachmentInputSchema)),
  allowedMentions: Schema.optionalKey(AllowedMentions),
}

export const MessagePresentationSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal('legacy'),
    content: Schema.optionalKey(bounded(1, 2_000)),
    embeds: Schema.optionalKey(Schema.Array(Schema.Record(Schema.String, JsonValueSchema))),
    components: Schema.optionalKey(Schema.Array(Schema.Record(Schema.String, JsonValueSchema))),
    poll: Schema.optionalKey(Schema.Record(Schema.String, JsonValueSchema)),
    ...AttachmentsAndMentions,
  }),
  Schema.Struct({
    type: Schema.Literal('components_v2'),
    components: Schema.Array(ComponentsV2TopLevelSchema).pipe(Schema.check(Schema.isMinLength(1))),
    ...AttachmentsAndMentions,
  }),
  Schema.Struct({
    type: Schema.Literal('template'),
    templateId: bounded(1, 100),
    revision: Schema.optionalKey(Schema.Int),
    variables: JsonValueSchema,
  }),
]).annotate({
  title: 'Discord message presentation',
  description: 'A legacy message, semantic Components V2 layout, or published template reference.',
})

const ModalTextInput = Schema.Struct({
  type: Schema.Literal('textInput'),
  key: bounded(1, 100),
  style: Schema.Literals(['short', 'paragraph']),
  required: Schema.optionalKey(Schema.Boolean),
  minLength: Schema.optionalKey(Schema.Int),
  maxLength: Schema.optionalKey(Schema.Int),
  placeholder: Schema.optionalKey(bounded(1, 100)),
  value: Schema.optionalKey(bounded(0, 4_000)),
})
const ModalSelect = Schema.Struct({
  type: Schema.Literal('select'),
  key: bounded(1, 100),
  kind: Schema.Literals(['string', 'user', 'role', 'mentionable', 'channel']),
  placeholder: Schema.optionalKey(bounded(1, 100)),
  minValues: Schema.optionalKey(Schema.Int),
  maxValues: Schema.optionalKey(Schema.Int),
  options: Schema.optionalKey(Schema.Array(SelectOption)),
  channelTypes: Schema.optionalKey(Schema.Array(Schema.Int)),
})
const FileUpload = Schema.Struct({
  type: Schema.Literal('fileUpload'),
  key: bounded(1, 100),
  required: Schema.optionalKey(Schema.Boolean),
  minValues: Schema.optionalKey(Schema.Int),
  maxValues: Schema.optionalKey(Schema.Int),
})
const RadioGroup = Schema.Struct({
  type: Schema.Literal('radioGroup'),
  key: bounded(1, 100),
  required: Schema.optionalKey(Schema.Boolean),
  options: Schema.Array(SelectOption),
})
const CheckboxGroup = Schema.Struct({
  type: Schema.Literal('checkboxGroup'),
  key: bounded(1, 100),
  required: Schema.optionalKey(Schema.Boolean),
  minValues: Schema.optionalKey(Schema.Int),
  maxValues: Schema.optionalKey(Schema.Int),
  options: Schema.Array(SelectOption),
})
const Checkbox = Schema.Struct({
  type: Schema.Literal('checkbox'),
  key: bounded(1, 100),
  default: Schema.optionalKey(Schema.Boolean),
})
const Label = Schema.Struct({
  type: Schema.Literal('label'),
  label: bounded(1, 45),
  description: Schema.optionalKey(bounded(1, 100)),
  component: Schema.Union([
    ModalTextInput,
    ModalSelect,
    FileUpload,
    RadioGroup,
    CheckboxGroup,
    Checkbox,
  ]),
})
export const ModalPresentationSchema = Schema.Struct({
  title: bounded(1, 45),
  action: InteractionActionSchema,
  components: Schema.Array(Schema.Union([Text, Label])).pipe(
    Schema.check(Schema.isMinLength(1), Schema.isMaxLength(5)),
  ),
}).annotate({
  title: 'Discord modal presentation',
  description: 'A semantic modal layout containing text displays and labeled modal inputs.',
})

const StringVariable = Schema.Struct({
  type: Schema.Literal('string'),
  minLength: Schema.optionalKey(Schema.Int),
  maxLength: Schema.optionalKey(Schema.Int),
  default: Schema.optionalKey(Schema.String),
})
const NumberVariable = Schema.Struct({
  type: Schema.Literal('number'),
  minimum: Schema.optionalKey(Schema.Number),
  maximum: Schema.optionalKey(Schema.Number),
  default: Schema.optionalKey(Schema.Number),
})
const BooleanVariable = Schema.Struct({
  type: Schema.Literal('boolean'),
  default: Schema.optionalKey(Schema.Boolean),
})
const SnowflakeVariable = Schema.Struct({
  type: Schema.Literal('snowflake'),
  default: Schema.optionalKey(Snowflake),
})
const UrlVariable = Schema.Struct({
  type: Schema.Literal('url'),
  default: Schema.optionalKey(Schema.String),
})
const TimestampVariable = Schema.Struct({
  type: Schema.Literal('timestamp'),
  default: Schema.optionalKey(Schema.String),
})
const EnumVariable = Schema.Struct({
  type: Schema.Literal('enum'),
  values: Schema.Array(Schema.String).pipe(Schema.check(Schema.isMinLength(1))),
  default: Schema.optionalKey(Schema.String),
})

export const VariableSchemaAst: Schema.Codec<unknown, unknown> = Schema.suspend(() =>
  Schema.Union([
    StringVariable,
    NumberVariable,
    BooleanVariable,
    SnowflakeVariable,
    UrlVariable,
    TimestampVariable,
    EnumVariable,
    Schema.Struct({
      type: Schema.Literal('array'),
      items: VariableSchemaAst,
      maxItems: Schema.optionalKey(Schema.Int),
      default: Schema.optionalKey(Schema.Array(JsonValueSchema)),
    }),
    Schema.Struct({
      type: Schema.Literal('object'),
      properties: Schema.Record(Schema.String, VariableSchemaAst),
      required: Schema.optionalKey(Schema.Array(Schema.String)),
      default: Schema.optionalKey(Schema.Record(Schema.String, JsonValueSchema)),
    }),
    Schema.Struct({
      type: Schema.Literal('optional'),
      value: VariableSchemaAst,
      default: Schema.optionalKey(JsonValueSchema),
    }),
  ]),
).annotate({ identifier: 'DiscordMessageTemplateVariableSchema' })

export const MessageTemplateDocumentSchema = Schema.Struct({
  variableSchema: Schema.Record(Schema.String, VariableSchemaAst),
  presentation: JsonValueSchema.annotate({
    description:
      'A legacy or Components V2 presentation AST whose leaf values may be {$variable, context} references.',
  }),
}) as Schema.ConstraintDecoder<
  {
    readonly variableSchema: Readonly<Record<string, unknown>>
    readonly presentation: unknown
  },
  never
>
