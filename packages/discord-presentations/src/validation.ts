import { createHash } from 'node:crypto'
import { Schema } from 'effect'
import type {
  ActionRowComponent,
  AttachmentInput,
  ButtonComponent,
  ComponentsV2TopLevel,
  ContainerChild,
  InteractionAction,
  MessagePresentation,
  ModalPresentation,
  SelectComponent,
} from './types.js'

export interface ValidationIssue {
  readonly path: string
  readonly message: string
}

export class PresentationError extends Schema.TaggedErrorClass<PresentationError>()(
  'PresentationError',
  {
    message: Schema.String,
    issues: Schema.Array(
      Schema.Struct({
        path: Schema.String,
        message: Schema.String,
      }),
    ),
  },
) {
  constructor(issues: ReadonlyArray<ValidationIssue>) {
    super({
      message: issues.map(({ path, message }) => `${path}: ${message}`).join('\n'),
      issues,
    })
  }
}

export { PresentationError as PresentationValidationError }

export interface MentionAnalysis {
  readonly users: ReadonlyArray<string>
  readonly roles: ReadonlyArray<string>
  readonly broad: ReadonlyArray<'everyone' | 'here'>
}

export interface ValidationReport {
  readonly componentCount: number
  readonly warnings: ReadonlyArray<string>
  readonly mentions: MentionAnalysis
  readonly attachmentManifest: ReadonlyArray<{ filename: string; source: 'inline' | 'blob' }>
  readonly interactiveBindings: ReadonlyArray<{
    customId: string
    action: InteractionAction
  }>
}

const customIdFor = (namespace: string, action: InteractionAction): string => {
  const digest = createHash('sha256')
    .update(`${namespace}\0${action.type}\0${action.key}`)
    .digest('base64url')
    .slice(0, 32)
  return `dcmcp_${digest}`
}

const normalizeFilename = (filename: string): string =>
  filename
    .normalize('NFKC')
    .replaceAll(/[^A-Za-z0-9._-]/g, '_')
    .replaceAll(/^\.+/g, '')
    .slice(0, 100)

const attachmentUrl = /^attachment:\/\/([^/]+)$/
const httpsUrl = /^https:\/\//
const snowflake = /^\d{17,21}$/

const validateAttachments = (
  attachments: ReadonlyArray<AttachmentInput>,
  issues: Array<ValidationIssue>,
): ReadonlyArray<{ filename: string; source: 'inline' | 'blob' }> => {
  const names = new Set<string>()
  return attachments.map((attachment, index) => {
    const filename = normalizeFilename(attachment.filename)
    if (filename.length === 0) {
      issues.push({
        path: `attachments.${index}.filename`,
        message: 'must contain a safe filename',
      })
    }
    if (names.has(filename)) {
      issues.push({
        path: `attachments.${index}.filename`,
        message: `normalizes to duplicate filename "${filename}"`,
      })
    }
    names.add(filename)
    if (attachment.source === 'inline') {
      if (attachment.data.length === 0) {
        issues.push({ path: `attachments.${index}.data`, message: 'must not be empty' })
      } else {
        try {
          const bytes = Buffer.from(attachment.data, 'base64')
          if (bytes.length > 8 * 1024 * 1024) {
            issues.push({
              path: `attachments.${index}.data`,
              message: 'inline attachment exceeds 8 MiB; use a blob reference',
            })
          }
          if (
            bytes.toString('base64').replaceAll('=', '') !== attachment.data.replaceAll('=', '')
          ) {
            throw new Error('non-canonical base64')
          }
        } catch {
          issues.push({ path: `attachments.${index}.data`, message: 'must be valid base64' })
        }
      }
    } else if (!/^[a-f0-9]{64}$/.test(attachment.blobId)) {
      issues.push({
        path: `attachments.${index}.blobId`,
        message: 'must be a SHA-256 content-addressed blob identifier',
      })
    }
    return { filename, source: attachment.source }
  })
}

const collectMentions = (
  text: string,
  analysis: { users: Set<string>; roles: Set<string>; broad: Set<'everyone' | 'here'> },
) => {
  for (const match of text.matchAll(/<@!?(\d{17,21})>/g)) {
    const value = match[1]
    if (value !== undefined) analysis.users.add(value)
  }
  for (const match of text.matchAll(/<@&(\d{17,21})>/g)) {
    const value = match[1]
    if (value !== undefined) analysis.roles.add(value)
  }
  if (/(?:^|\s)@everyone\b/.test(text)) analysis.broad.add('everyone')
  if (/(?:^|\s)@here\b/.test(text)) analysis.broad.add('here')
}

interface ComponentState {
  count: number
  textCharacters: number
  ids: Set<number>
  customIds: Set<string>
  bindings: Array<{ customId: string; action: InteractionAction }>
  references: Map<string, number>
}

const length = (
  value: string | undefined,
  min: number,
  max: number,
  path: string,
  issues: Array<ValidationIssue>,
) => {
  if (value === undefined || value.length < min || value.length > max) {
    issues.push({ path, message: `must contain ${min}–${max} characters` })
  }
}

const validateMediaUrl = (
  url: string,
  path: string,
  fileOnly: boolean,
  state: ComponentState,
  issues: Array<ValidationIssue>,
) => {
  const match = attachmentUrl.exec(url)
  if (match?.[1]) {
    state.references.set(match[1], (state.references.get(match[1]) ?? 0) + 1)
  } else if (fileOnly || !httpsUrl.test(url)) {
    issues.push({
      path,
      message: fileOnly
        ? 'must use attachment://filename'
        : 'must use https:// or attachment://filename',
    })
  }
}

const addIdentity = (
  component: { readonly id?: number },
  path: string,
  state: ComponentState,
  issues: Array<ValidationIssue>,
) => {
  state.count += 1
  if (component.id !== undefined) {
    if (!Number.isInteger(component.id) || component.id < 0) {
      issues.push({ path: `${path}.id`, message: 'must be a non-negative integer' })
    } else if (state.ids.has(component.id)) {
      issues.push({ path: `${path}.id`, message: `duplicate component id ${component.id}` })
    }
    state.ids.add(component.id)
  }
}

const addAction = (
  action: InteractionAction,
  path: string,
  namespace: string,
  state: ComponentState,
  issues: Array<ValidationIssue>,
) => {
  length(action.key, 1, 100, `${path}.key`, issues)
  const customId = customIdFor(namespace, action)
  if (state.customIds.has(customId)) {
    issues.push({ path, message: 'produces a duplicate interactive custom_id' })
  }
  state.customIds.add(customId)
  state.bindings.push({ customId, action })
}

const validateButton = (
  button: ButtonComponent,
  path: string,
  namespace: string,
  state: ComponentState,
  issues: Array<ValidationIssue>,
) => {
  addIdentity(button, path, state, issues)
  if (button.style === 'premium') {
    if (!snowflake.test(button.skuId)) {
      issues.push({ path: `${path}.skuId`, message: 'must be a Discord snowflake' })
    }
    return
  }
  length(button.label, 1, 80, `${path}.label`, issues)
  if (button.style === 'link') {
    if (!httpsUrl.test(button.url)) {
      issues.push({ path: `${path}.url`, message: 'must be an https:// URL' })
    }
    return
  }
  addAction(button.action, `${path}.action`, namespace, state, issues)
}

const validateSelect = (
  select: SelectComponent,
  path: string,
  namespace: string,
  state: ComponentState,
  issues: Array<ValidationIssue>,
) => {
  addIdentity(select, path, state, issues)
  addAction(select.action, `${path}.action`, namespace, state, issues)
  if (select.placeholder !== undefined)
    length(select.placeholder, 1, 150, `${path}.placeholder`, issues)
  const min = select.minValues ?? 1
  const max = select.maxValues ?? 1
  if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max > 25 || min > max) {
    issues.push({ path, message: 'minValues/maxValues must be integers with 0 ≤ min ≤ max ≤ 25' })
  }
  if (select.kind === 'string') {
    if (!select.options || select.options.length < 1 || select.options.length > 25) {
      issues.push({ path: `${path}.options`, message: 'string selects require 1–25 options' })
    }
    const values = new Set<string>()
    for (const [index, option] of (select.options ?? []).entries()) {
      length(option.label, 1, 100, `${path}.options.${index}.label`, issues)
      length(option.value, 1, 100, `${path}.options.${index}.value`, issues)
      if (option.description !== undefined) {
        length(option.description, 1, 100, `${path}.options.${index}.description`, issues)
      }
      if (values.has(option.value)) {
        issues.push({ path: `${path}.options.${index}.value`, message: 'must be unique' })
      }
      values.add(option.value)
    }
  } else if (select.options !== undefined) {
    issues.push({ path: `${path}.options`, message: 'is only valid for string selects' })
  }
}

const validateActionRow = (
  row: ActionRowComponent,
  path: string,
  namespace: string,
  state: ComponentState,
  issues: Array<ValidationIssue>,
) => {
  addIdentity(row, path, state, issues)
  const buttons = row.components.filter((component) => component.type === 'button')
  const selects = row.components.filter((component) => component.type === 'select')
  if (
    !(
      (buttons.length >= 1 && buttons.length <= 5 && selects.length === 0) ||
      (selects.length === 1 && buttons.length === 0)
    )
  ) {
    issues.push({
      path: `${path}.components`,
      message: 'must contain 1–5 buttons or exactly one select',
    })
  }
  for (const [index, component] of row.components.entries()) {
    if (component.type === 'button') {
      validateButton(component, `${path}.components.${index}`, namespace, state, issues)
    } else {
      validateSelect(component, `${path}.components.${index}`, namespace, state, issues)
    }
  }
}

const validateComponent = (
  component: ComponentsV2TopLevel | ContainerChild,
  path: string,
  namespace: string,
  state: ComponentState,
  issues: Array<ValidationIssue>,
  warnings: Array<string>,
  mentions: { users: Set<string>; roles: Set<string>; broad: Set<'everyone' | 'here'> },
) => {
  switch (component.type) {
    case 'text':
      addIdentity(component, path, state, issues)
      length(component.content, 1, 4_000, `${path}.content`, issues)
      state.textCharacters += component.content.length
      collectMentions(component.content, mentions)
      break
    case 'actionRow':
      validateActionRow(component, path, namespace, state, issues)
      break
    case 'section':
      addIdentity(component, path, state, issues)
      if (component.components.length < 1 || component.components.length > 3) {
        issues.push({ path: `${path}.components`, message: 'must contain 1–3 text components' })
      }
      for (const [index, text] of component.components.entries()) {
        validateComponent(
          text,
          `${path}.components.${index}`,
          namespace,
          state,
          issues,
          warnings,
          mentions,
        )
      }
      if (component.accessory.type === 'button') {
        validateButton(component.accessory, `${path}.accessory`, namespace, state, issues)
      } else {
        addIdentity(component.accessory, `${path}.accessory`, state, issues)
        if (component.accessory.description !== undefined) {
          length(component.accessory.description, 1, 1_024, `${path}.accessory.description`, issues)
        }
        validateMediaUrl(
          component.accessory.media.url,
          `${path}.accessory.media.url`,
          false,
          state,
          issues,
        )
      }
      break
    case 'mediaGallery':
      addIdentity(component, path, state, issues)
      if (component.items.length < 1 || component.items.length > 10) {
        issues.push({ path: `${path}.items`, message: 'must contain 1–10 media items' })
      }
      for (const [index, item] of component.items.entries()) {
        if (item.description !== undefined) {
          length(item.description, 1, 1_024, `${path}.items.${index}.description`, issues)
        }
        validateMediaUrl(item.media.url, `${path}.items.${index}.media.url`, false, state, issues)
      }
      break
    case 'file':
      addIdentity(component, path, state, issues)
      validateMediaUrl(component.file.url, `${path}.file.url`, true, state, issues)
      break
    case 'separator':
      addIdentity(component, path, state, issues)
      break
    case 'container':
      addIdentity(component, path, state, issues)
      if (
        component.accentColor !== undefined &&
        component.accentColor !== null &&
        (!Number.isInteger(component.accentColor) ||
          component.accentColor < 0 ||
          component.accentColor > 0xffffff)
      ) {
        issues.push({
          path: `${path}.accentColor`,
          message: 'must be an integer from 0 to 16777215',
        })
      }
      if (component.components.length > 10) {
        warnings.push(`${path} has more than the advisory limit of 10 children`)
      }
      for (const [index, child] of component.components.entries()) {
        validateComponent(
          child,
          `${path}.components.${index}`,
          namespace,
          state,
          issues,
          warnings,
          mentions,
        )
      }
      break
  }
}

export const validateMessage = (
  presentation: MessagePresentation,
  namespace = 'validation',
): ValidationReport => {
  const issues: Array<ValidationIssue> = []
  const warnings: Array<string> = []
  const mentions = {
    users: new Set<string>(),
    roles: new Set<string>(),
    broad: new Set<'everyone' | 'here'>(),
  }
  const attachments =
    presentation.type === 'template'
      ? []
      : validateAttachments(presentation.attachments ?? [], issues)
  const state: ComponentState = {
    count: 0,
    textCharacters: 0,
    ids: new Set(),
    customIds: new Set(),
    bindings: [],
    references: new Map(),
  }

  if (presentation.type === 'template') {
    length(presentation.templateId, 1, 100, 'templateId', issues)
  } else if (presentation.type === 'legacy') {
    if (
      presentation.content === undefined &&
      presentation.embeds === undefined &&
      presentation.components === undefined &&
      presentation.poll === undefined &&
      attachments.length === 0
    ) {
      issues.push({
        path: 'presentation',
        message: 'legacy message must contain content or another payload',
      })
    }
    if (presentation.content !== undefined) {
      length(presentation.content, 1, 2_000, 'content', issues)
      collectMentions(presentation.content, mentions)
    }
  } else {
    if (presentation.components.length < 1) {
      issues.push({ path: 'components', message: 'must contain at least one component' })
    }
    if (presentation.components.length > 10) {
      warnings.push('message has more than the advisory limit of 10 top-level components')
    }
    for (const [index, component] of presentation.components.entries()) {
      validateComponent(
        component,
        `components.${index}`,
        namespace,
        state,
        issues,
        warnings,
        mentions,
      )
    }
    if (state.count > 40) {
      issues.push({
        path: 'components',
        message: `contains ${state.count} components; maximum is 40`,
      })
    }
    if (state.textCharacters > 4_000) {
      warnings.push(
        `message contains ${state.textCharacters} text characters; advisory budget is 4000`,
      )
    }
    const attachmentNames = new Set(attachments.map(({ filename }) => filename))
    for (const [reference, count] of state.references) {
      if (!attachmentNames.has(reference)) {
        issues.push({ path: 'components', message: `references missing attachment "${reference}"` })
      } else if (count !== 1) {
        issues.push({
          path: 'components',
          message: `attachment "${reference}" must be referenced exactly once`,
        })
      }
    }
    for (const { filename } of attachments) {
      if (!state.references.has(filename)) {
        warnings.push(
          `attachment "${filename}" is not referenced and will be invisible in Components V2`,
        )
      }
    }
  }

  const broadRequested =
    presentation.type === 'template' ? [] : (presentation.allowedMentions?.parse ?? [])
  if (mentions.broad.size > 0 && !broadRequested.includes('everyone')) {
    warnings.push(
      'broad mention text is present but safe allowed-mentions defaults prevent notification',
    )
  }

  if (issues.length > 0) throw new PresentationError(issues)
  return {
    componentCount: state.count,
    warnings,
    mentions: {
      users: [...mentions.users],
      roles: [...mentions.roles],
      broad: [...mentions.broad],
    },
    attachmentManifest: attachments,
    interactiveBindings: state.bindings,
  }
}

export const validateModal = (modal: ModalPresentation, namespace = 'modal'): ValidationReport => {
  const issues: Array<ValidationIssue> = []
  length(modal.title, 1, 45, 'title', issues)
  if (modal.components.length < 1 || modal.components.length > 5) {
    issues.push({ path: 'components', message: 'modal must contain 1–5 top-level components' })
  }
  const keys = new Set<string>()
  for (const [index, component] of modal.components.entries()) {
    if (component.type === 'text') {
      length(component.content, 1, 4_000, `components.${index}.content`, issues)
      continue
    }
    length(component.label, 1, 45, `components.${index}.label`, issues)
    if (component.description !== undefined) {
      length(component.description, 1, 100, `components.${index}.description`, issues)
    }
    const input = component.component
    length(input.key, 1, 100, `components.${index}.component.key`, issues)
    if (keys.has(input.key)) {
      issues.push({ path: `components.${index}.component.key`, message: 'must be unique' })
    }
    keys.add(input.key)
    if (input.type === 'select') {
      const state: ComponentState = {
        count: 0,
        textCharacters: 0,
        ids: new Set(),
        customIds: new Set(),
        bindings: [],
        references: new Map(),
      }
      validateSelect(
        {
          ...input,
          action: { type: 'event', key: input.key },
        },
        `components.${index}.component`,
        namespace,
        state,
        issues,
      )
    } else if (input.type === 'textInput') {
      const min = input.minLength ?? 0
      const max = input.maxLength ?? 4_000
      if (min < 0 || max > 4_000 || min > max) {
        issues.push({
          path: `components.${index}.component`,
          message: 'text input lengths must satisfy 0 ≤ minLength ≤ maxLength ≤ 4000',
        })
      }
      if (input.placeholder !== undefined) {
        length(input.placeholder, 1, 100, `components.${index}.component.placeholder`, issues)
      }
      if (input.value !== undefined) {
        length(input.value, 0, 4_000, `components.${index}.component.value`, issues)
      }
    } else if (input.type === 'fileUpload') {
      const min = input.minValues ?? (input.required === false ? 0 : 1)
      const max = input.maxValues ?? 1
      if (min < 0 || max > 10 || min > max) {
        issues.push({
          path: `components.${index}.component`,
          message: 'file upload counts must satisfy 0 ≤ minValues ≤ maxValues ≤ 10',
        })
      }
    } else if (input.type === 'radioGroup' || input.type === 'checkboxGroup') {
      if (input.options.length < 1 || input.options.length > 25) {
        issues.push({
          path: `components.${index}.component.options`,
          message: 'choice groups require 1–25 options',
        })
      }
      const values = new Set<string>()
      for (const [optionIndex, option] of input.options.entries()) {
        length(
          option.label,
          1,
          100,
          `components.${index}.component.options.${optionIndex}.label`,
          issues,
        )
        length(
          option.value,
          1,
          100,
          `components.${index}.component.options.${optionIndex}.value`,
          issues,
        )
        if (values.has(option.value)) {
          issues.push({
            path: `components.${index}.component.options.${optionIndex}.value`,
            message: 'must be unique',
          })
        }
        values.add(option.value)
      }
      if (input.type === 'checkboxGroup') {
        const min = input.minValues ?? (input.required === false ? 0 : 1)
        const max = input.maxValues ?? input.options.length
        if (min < 0 || max > input.options.length || min > max) {
          issues.push({
            path: `components.${index}.component`,
            message: 'checkbox counts must fit the configured options',
          })
        }
      }
    }
  }
  if (issues.length > 0) throw new PresentationError(issues)
  return {
    componentCount: modal.components.length,
    warnings: [],
    mentions: { users: [], roles: [], broad: [] },
    attachmentManifest: [],
    interactiveBindings: [{ customId: customIdFor(namespace, modal.action), action: modal.action }],
  }
}
