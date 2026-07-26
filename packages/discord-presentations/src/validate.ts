import { ADVISORY_LIMITS, HARD_LIMITS, NON_INTERACTIVE_BUTTON_STYLES } from './limits.ts'
import type { AttachmentInput, ComponentsV2TopLevel } from './schema.ts'

/**
 * Structural validation of a Components V2 tree.
 *
 * Rejections here are ones Discord documents and enforces, so failing locally converts a 400 with
 * a nested error blob into a path-addressed message. Warnings are limits Discord does *not*
 * document — they exist so an upstream change can never break a send that was always valid.
 */

export interface ValidationReport {
  readonly errors: ReadonlyArray<string>
  readonly warnings: ReadonlyArray<string>
  readonly componentCount: number
  readonly maxDepth: number
  /** `attachment://` filenames referenced by some component. */
  readonly referencedAttachments: ReadonlyArray<string>
  /** Explicitly supplied numeric component IDs. */
  readonly numericIds: ReadonlyArray<number>
  /** Actions every interactive component binds to, for the control plane to compile. */
  readonly bindings: ReadonlyArray<{ readonly path: string; readonly action: unknown }>
  readonly totalTextChars: number
}

type Node = ComponentsV2TopLevel | Record<string, unknown>

const ATTACHMENT_PROTOCOL = 'attachment://'

interface Walk {
  errors: string[]
  warnings: string[]
  count: number
  maxDepth: number
  attachments: string[]
  ids: number[]
  customIdPaths: Map<string, string>
  bindings: { path: string; action: unknown }[]
  textChars: number
}

const mediaName = (media: unknown): string | undefined =>
  typeof media === 'string' && media.startsWith(ATTACHMENT_PROTOCOL)
    ? media.slice(ATTACHMENT_PROTOCOL.length)
    : undefined

const isButton = (n: Node): boolean => (n as { type?: string }).type === 'button'
const isSelect = (n: Node): boolean =>
  String((n as { type?: string }).type ?? '').endsWith('Select')

const walkNode = (node: Node, path: string, depth: number, w: Walk): void => {
  w.count += 1
  w.maxDepth = Math.max(w.maxDepth, depth)

  const type = (node as { type?: string }).type
  const id = (node as { id?: number }).id
  if (typeof id === 'number') w.ids.push(id)

  switch (type) {
    case 'text': {
      w.textChars += String((node as { content: string }).content).length
      return
    }

    case 'thumbnail': {
      const name = mediaName((node as { media: unknown }).media)
      if (name !== undefined) w.attachments.push(name)
      return
    }

    case 'file': {
      const name = mediaName((node as { file: unknown }).file)
      if (name === undefined) {
        w.errors.push(
          `${path}.file: must be "attachment://<filename>"; Discord rejects https URLs here.`,
        )
      } else {
        w.attachments.push(name)
      }
      return
    }

    case 'mediaGallery': {
      const items = (node as { items: ReadonlyArray<{ media: unknown }> }).items
      for (const item of items) {
        const name = mediaName(item.media)
        if (name !== undefined) w.attachments.push(name)
      }
      // Each gallery item is a component for counting purposes.
      w.count += items.length
      return
    }

    case 'separator':
      return

    case 'button': {
      const style = (node as { style: string }).style
      if (!NON_INTERACTIVE_BUTTON_STYLES.has(style)) {
        const action = (node as { action?: unknown }).action
        if (action === undefined) {
          w.errors.push(
            `${path}: a ${style} button fires an interaction and must bind to a workflow action or an inbox key.`,
          )
        } else {
          w.bindings.push({ path, action })
        }
      }
      return
    }

    case 'section': {
      const components = (node as { components: ReadonlyArray<Node> }).components
      const accessory = (node as { accessory?: Node }).accessory

      if (accessory === undefined) {
        w.errors.push(`${path}.accessory: required. Discord rejects a Section without one.`)
      } else {
        walkNode(accessory, `${path}.accessory`, depth + 1, w)
      }
      components.forEach((child, i) => {
        if ((child as { type?: string }).type === 'section') {
          w.errors.push(`${path}.components.${i}: a Section cannot nest inside a Section.`)
          return
        }
        walkNode(child, `${path}.components.${i}`, depth + 1, w)
      })
      return
    }

    case 'actionRow': {
      const components = (node as { components: ReadonlyArray<Node> }).components
      const buttons = components.filter(isButton).length
      const selects = components.filter(isSelect).length

      // Five buttons XOR one select. Discord permits no mix at all.
      if (selects > 0 && buttons > 0) {
        w.errors.push(
          `${path}: an ActionRow holds five buttons or one select, never a mix of both.`,
        )
      }
      if (selects > HARD_LIMITS.actionRowSelects) {
        w.errors.push(
          `${path}: an ActionRow holds at most ${HARD_LIMITS.actionRowSelects} select, got ${selects}.`,
        )
      }
      if (buttons > HARD_LIMITS.actionRowButtons) {
        w.errors.push(
          `${path}: an ActionRow holds at most ${HARD_LIMITS.actionRowButtons} buttons, got ${buttons}.`,
        )
      }
      components.forEach((child, i) => {
        walkNode(child, `${path}.components.${i}`, depth + 1, w)
      })
      return
    }

    case 'container': {
      const components = (node as { components: ReadonlyArray<Node> }).components
      if (components.length > ADVISORY_LIMITS.containerChildren) {
        // JSDoc only, unenforced by Discord.
        w.warnings.push(
          `${path}: ${components.length} children. A Container is documented as holding ${ADVISORY_LIMITS.containerChildren}, but only in a JSDoc comment and Discord does not enforce it.`,
        )
      }
      components.forEach((child, i) => {
        const childType = (child as { type?: string }).type
        if (childType === 'container') {
          w.errors.push(`${path}.components.${i}: a Container cannot nest inside a Container.`)
          return
        }
        if (childType === 'thumbnail') {
          w.errors.push(
            `${path}.components.${i}: a Thumbnail is reachable only as a Section accessory, never as a Container child.`,
          )
          return
        }
        walkNode(child, `${path}.components.${i}`, depth + 1, w)
      })
      return
    }

    default: {
      // Selects and anything else with nested children.
      if (isSelect(node)) {
        const action = (node as { action?: unknown }).action
        if (action !== undefined) w.bindings.push({ path, action })
      }
    }
  }
}

export const validateComponentsV2 = (
  components: ReadonlyArray<ComponentsV2TopLevel>,
  attachments: ReadonlyArray<AttachmentInput> = [],
): ValidationReport => {
  const w: Walk = {
    errors: [],
    warnings: [],
    count: 0,
    maxDepth: 0,
    attachments: [],
    ids: [],
    customIdPaths: new Map(),
    bindings: [],
    textChars: 0,
  }

  components.forEach((node, i) => {
    const type = (node as { type?: string }).type
    if (type === 'thumbnail') {
      w.errors.push(
        `components.${i}: a Thumbnail is reachable only as a Section accessory, never at the top level.`,
      )
      return
    }
    walkNode(node, `components.${i}`, 1, w)
  })

  if (w.count > HARD_LIMITS.totalComponents) {
    w.errors.push(
      `${w.count} components in total; Discord's limit is ${HARD_LIMITS.totalComponents}, counted recursively across the whole tree.`,
    )
  }
  if (w.maxDepth > HARD_LIMITS.maxDepth) {
    w.errors.push(
      `Nesting is ${w.maxDepth} deep; Discord's maximum effective depth is ${HARD_LIMITS.maxDepth}.`,
    )
  }

  const duplicateIds = w.ids.filter((id, i) => w.ids.indexOf(id) !== i)
  if (duplicateIds.length > 0) {
    w.errors.push(
      `Duplicate explicit component id(s): ${[...new Set(duplicateIds)].join(', ')}. Explicit ids must be unique, or omit them and let Discord assign.`,
    )
  }

  // Attachment references must resolve exactly once each. In V2 an uploaded file that nothing
  // references uploads successfully and renders nowhere — the most common silent failure there is.
  const supplied = attachments.map((a) => a.filename)
  const referenced = w.attachments

  for (const name of new Set(referenced)) {
    const refCount = referenced.filter((n) => n === name).length
    if (!supplied.includes(name)) {
      w.errors.push(
        `A component references attachment://${name} but no attachment with that filename was supplied.`,
      )
    } else if (refCount > 1) {
      w.errors.push(
        `attachment://${name} is referenced ${refCount} times; each attachment must be referenced exactly once.`,
      )
    }
  }
  for (const name of supplied) {
    if (!referenced.includes(name)) {
      w.warnings.push(
        `Attachment "${name}" is referenced by no component. Under Components V2 it will upload and be invisible — V1 auto-rendered attachments, V2 does not.`,
      )
    }
  }

  if (components.length > ADVISORY_LIMITS.topLevelComponents) {
    w.warnings.push(
      `${components.length} top-level components. An April 2025 changelog stated ${ADVISORY_LIMITS.topLevelComponents}, but the same changelog's "30 total" has since been raised, so this is advisory.`,
    )
  }
  if (w.textChars > ADVISORY_LIMITS.messageWideTextChars) {
    w.warnings.push(
      `${w.textChars} characters of text across the message. A message-wide ${ADVISORY_LIMITS.messageWideTextChars}-character budget is widely reported but undocumented; only the per-TextDisplay limit is verifiable.`,
    )
  }

  return {
    errors: w.errors,
    warnings: w.warnings,
    componentCount: w.count,
    maxDepth: w.maxDepth,
    referencedAttachments: [...new Set(w.attachments)],
    numericIds: w.ids,
    bindings: w.bindings,
    totalTextChars: w.textChars,
  }
}
