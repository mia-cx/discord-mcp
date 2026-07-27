import { MessageFlags } from 'discord-api-types/v10'
import type {
  ActionRowComponent,
  ButtonComponent,
  ComponentsV2TopLevel,
  ContainerChild,
  MessagePresentation,
  ModalPresentation,
  SelectComponent,
} from './types.js'
import { validateMessage, validateModal } from './validation.js'

const buttonStyles = {
  primary: 1,
  secondary: 2,
  success: 3,
  danger: 4,
  link: 5,
  premium: 6,
} as const

const selectTypes = {
  string: 3,
  user: 5,
  role: 6,
  mentionable: 7,
  channel: 8,
} as const

const customId = (
  action: { readonly type: 'workflow' | 'event'; readonly key: string },
  bindings: ReadonlyArray<{ customId: string; action: typeof action }>,
): string => {
  const binding = bindings.find(
    ({ action: candidate }) => candidate.type === action.type && candidate.key === action.key,
  )
  if (!binding) throw new Error('validated interaction binding is missing')
  return binding.customId
}

const encodeButton = (
  button: ButtonComponent,
  bindings: ReadonlyArray<{
    customId: string
    action: { type: 'workflow' | 'event'; key: string }
  }>,
): Record<string, unknown> => {
  const output: Record<string, unknown> = {
    type: 2,
    style: buttonStyles[button.style],
  }
  if (button.id !== undefined) output.id = button.id
  if (button.disabled !== undefined) output.disabled = button.disabled
  if ('label' in button) output.label = button.label
  if ('emoji' in button && button.emoji !== undefined) output.emoji = button.emoji
  if (button.style === 'link') output.url = button.url
  else if (button.style === 'premium') output.sku_id = button.skuId
  else output.custom_id = customId(button.action, bindings)
  return output
}

const encodeSelect = (
  select: SelectComponent,
  bindings: ReadonlyArray<{
    customId: string
    action: { type: 'workflow' | 'event'; key: string }
  }>,
): Record<string, unknown> => {
  const output: Record<string, unknown> = {
    type: selectTypes[select.kind],
    custom_id: customId(select.action, bindings),
  }
  if (select.id !== undefined) output.id = select.id
  if (select.placeholder !== undefined) output.placeholder = select.placeholder
  if (select.minValues !== undefined) output.min_values = select.minValues
  if (select.maxValues !== undefined) output.max_values = select.maxValues
  if (select.disabled !== undefined) output.disabled = select.disabled
  if (select.options !== undefined) output.options = select.options
  if (select.channelTypes !== undefined) output.channel_types = select.channelTypes
  return output
}

const encodeActionRow = (
  row: ActionRowComponent,
  bindings: ReadonlyArray<{
    customId: string
    action: { type: 'workflow' | 'event'; key: string }
  }>,
): Record<string, unknown> => ({
  type: 1,
  ...(row.id === undefined ? {} : { id: row.id }),
  components: row.components.map((component) =>
    component.type === 'button'
      ? encodeButton(component, bindings)
      : encodeSelect(component, bindings),
  ),
})

const encodeComponent = (
  component: ComponentsV2TopLevel | ContainerChild,
  bindings: ReadonlyArray<{
    customId: string
    action: { type: 'workflow' | 'event'; key: string }
  }>,
): Record<string, unknown> => {
  const id = component.id === undefined ? {} : { id: component.id }
  switch (component.type) {
    case 'text':
      return { type: 10, ...id, content: component.content }
    case 'actionRow':
      return encodeActionRow(component, bindings)
    case 'section':
      return {
        type: 9,
        ...id,
        components: component.components.map((child) => encodeComponent(child, bindings)),
        accessory:
          component.accessory.type === 'button'
            ? encodeButton(component.accessory, bindings)
            : {
                type: 11,
                ...(component.accessory.id === undefined ? {} : { id: component.accessory.id }),
                media: component.accessory.media,
                ...(component.accessory.description === undefined
                  ? {}
                  : { description: component.accessory.description }),
                ...(component.accessory.spoiler === undefined
                  ? {}
                  : { spoiler: component.accessory.spoiler }),
              },
      }
    case 'mediaGallery':
      return { type: 12, ...id, items: component.items }
    case 'file':
      return {
        type: 13,
        ...id,
        file: component.file,
        ...(component.spoiler === undefined ? {} : { spoiler: component.spoiler }),
      }
    case 'separator':
      return {
        type: 14,
        ...id,
        ...(component.divider === undefined ? {} : { divider: component.divider }),
        ...(component.spacing === undefined
          ? {}
          : { spacing: component.spacing === 'small' ? 1 : 2 }),
      }
    case 'container':
      return {
        type: 17,
        ...id,
        ...(component.accentColor === undefined ? {} : { accent_color: component.accentColor }),
        ...(component.spoiler === undefined ? {} : { spoiler: component.spoiler }),
        components: component.components.map((child) => encodeComponent(child, bindings)),
      }
  }
}

export interface EncodedMessage {
  readonly payload: Record<string, unknown>
  readonly report: ReturnType<typeof validateMessage>
  readonly layout: string
}

export interface EncodedModal {
  readonly payload: Record<string, unknown>
  readonly report: ReturnType<typeof validateModal>
}

export const encodeModal = (modal: ModalPresentation, namespace = 'modal'): EncodedModal => {
  const report = validateModal(modal, namespace)
  const customId = report.interactiveBindings[0]?.customId
  if (!customId) throw new Error('validated modal action binding is missing')
  return {
    payload: {
      title: modal.title,
      custom_id: customId,
      components: modal.components.map((component) => {
        if (component.type === 'text') return { type: 10, content: component.content }
        const input = component.component
        const common = { custom_id: input.key }
        let encoded: Record<string, unknown>
        switch (input.type) {
          case 'textInput':
            encoded = {
              type: 4,
              ...common,
              style: input.style === 'short' ? 1 : 2,
              ...(input.required === undefined ? {} : { required: input.required }),
              ...(input.minLength === undefined ? {} : { min_length: input.minLength }),
              ...(input.maxLength === undefined ? {} : { max_length: input.maxLength }),
              ...(input.placeholder === undefined ? {} : { placeholder: input.placeholder }),
              ...(input.value === undefined ? {} : { value: input.value }),
            }
            break
          case 'select':
            encoded = {
              type: selectTypes[input.kind],
              ...common,
              ...(input.placeholder === undefined ? {} : { placeholder: input.placeholder }),
              ...(input.minValues === undefined ? {} : { min_values: input.minValues }),
              ...(input.maxValues === undefined ? {} : { max_values: input.maxValues }),
              ...(input.options === undefined ? {} : { options: input.options }),
              ...(input.channelTypes === undefined ? {} : { channel_types: input.channelTypes }),
            }
            break
          case 'fileUpload':
            encoded = {
              type: 19,
              ...common,
              ...(input.required === undefined ? {} : { required: input.required }),
              ...(input.minValues === undefined ? {} : { min_values: input.minValues }),
              ...(input.maxValues === undefined ? {} : { max_values: input.maxValues }),
            }
            break
          case 'radioGroup':
            encoded = {
              type: 21,
              ...common,
              options: input.options,
              ...(input.required === undefined ? {} : { required: input.required }),
            }
            break
          case 'checkboxGroup':
            encoded = {
              type: 22,
              ...common,
              options: input.options,
              ...(input.required === undefined ? {} : { required: input.required }),
              ...(input.minValues === undefined ? {} : { min_values: input.minValues }),
              ...(input.maxValues === undefined ? {} : { max_values: input.maxValues }),
            }
            break
          case 'checkbox':
            encoded = {
              type: 23,
              ...common,
              ...(input.default === undefined ? {} : { default: input.default }),
            }
            break
        }
        return {
          type: 18,
          label: component.label,
          ...(component.description === undefined ? {} : { description: component.description }),
          component: encoded,
        }
      }),
    },
    report,
  }
}

const safeAllowedMentions = (presentation: Exclude<MessagePresentation, { type: 'template' }>) => ({
  parse: presentation.allowedMentions?.parse ?? [],
  users: presentation.allowedMentions?.users ?? [],
  roles: presentation.allowedMentions?.roles ?? [],
  replied_user: presentation.allowedMentions?.repliedUser ?? false,
})

const encodedAttachments = (report: ReturnType<typeof validateMessage>) =>
  report.attachmentManifest.map(({ filename }, id) => ({ id, filename }))

const renderNode = (
  component: ComponentsV2TopLevel | ContainerChild,
  prefix = '',
): ReadonlyArray<string> => {
  const label =
    component.type === 'text'
      ? `text ${JSON.stringify(component.content.slice(0, 60))}`
      : component.type === 'actionRow'
        ? `action row (${component.components.length})`
        : component.type === 'section'
          ? 'section'
          : component.type === 'mediaGallery'
            ? `media gallery (${component.items.length})`
            : component.type === 'file'
              ? `file ${component.file.url}`
              : component.type === 'separator'
                ? 'separator'
                : `container${component.accentColor == null ? '' : ` #${component.accentColor.toString(16).padStart(6, '0')}`}`
  const lines = [`${prefix}${label}`]
  if (component.type === 'container' || component.type === 'section') {
    const children =
      component.type === 'container'
        ? component.components
        : [...component.components, component.accessory]
    children.forEach((child, index) => {
      const last = index === children.length - 1
      const branch = last ? '└─ ' : '├─ '
      if (child.type === 'button') {
        lines.push(`${prefix}${branch}button ${'label' in child ? child.label : 'premium'}`)
      } else if (child.type === 'thumbnail') {
        lines.push(`${prefix}${branch}thumbnail ${child.media.url}`)
      } else {
        lines.push(...renderNode(child, `${prefix}${branch}`))
      }
    })
  } else if (component.type === 'actionRow') {
    for (const child of component.components) {
      lines.push(
        `${prefix}└─ ${child.type === 'button' ? `button ${'label' in child ? child.label : 'premium'}` : `${child.kind} select`}`,
      )
    }
  }
  return lines
}

export const encodeMessage = (
  presentation: Exclude<MessagePresentation, { type: 'template' }>,
  namespace = 'message',
): EncodedMessage => {
  const report = validateMessage(presentation, namespace)
  if (presentation.type === 'legacy') {
    return {
      payload: {
        ...(presentation.content === undefined ? {} : { content: presentation.content }),
        ...(presentation.embeds === undefined ? {} : { embeds: presentation.embeds }),
        ...(presentation.components === undefined ? {} : { components: presentation.components }),
        ...(presentation.poll === undefined ? {} : { poll: presentation.poll }),
        ...(report.attachmentManifest.length === 0
          ? {}
          : { attachments: encodedAttachments(report) }),
        allowed_mentions: safeAllowedMentions(presentation),
      },
      report,
      layout: presentation.content ?? '[legacy message]',
    }
  }
  return {
    payload: {
      flags: MessageFlags.IsComponentsV2,
      components: presentation.components.map((component) =>
        encodeComponent(component, report.interactiveBindings),
      ),
      ...(report.attachmentManifest.length === 0
        ? {}
        : { attachments: encodedAttachments(report) }),
      allowed_mentions: safeAllowedMentions(presentation),
    },
    report,
    layout: presentation.components.flatMap((component) => renderNode(component)).join('\n'),
  }
}

export const encodeV2Upgrade = (
  presentation: Extract<MessagePresentation, { type: 'components_v2' }>,
  namespace = 'message-edit',
): EncodedMessage => {
  const encoded = encodeMessage(presentation, namespace)
  return {
    ...encoded,
    payload: {
      ...encoded.payload,
      content: null,
      poll: null,
      embeds: [],
      sticker_ids: [],
    },
  }
}
