import type { ComponentsV2TopLevel } from './schema.ts'

/**
 * Render a component tree as ASCII.
 *
 * A model that just described a layout in JSON cannot see what it built. Showing the structure
 * back is the difference between iterating on a picture and iterating on a guess — and it costs
 * no Discord request.
 */

const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`

const firstLine = (text: string): string => text.split('\n')[0] ?? ''

const describe = (node: Record<string, unknown>): string => {
  switch (node.type) {
    case 'text':
      return `Text  "${truncate(firstLine(String(node.content)), 56)}"`
    case 'separator':
      return `Separator${node.divider === false ? ' (no line)' : ''}${node.spacing === 'large' ? ' large' : ''}`
    case 'thumbnail':
      return `Thumbnail  ${truncate(String(node.media), 48)}`
    case 'file':
      return `File  ${truncate(String(node.file), 48)}`
    case 'mediaGallery':
      return `MediaGallery  ${(node.items as ReadonlyArray<unknown>).length} item(s)`
    case 'section':
      return 'Section'
    case 'actionRow':
      return 'ActionRow'
    case 'container': {
      const colour =
        node.accentColor === undefined
          ? ''
          : `  accent #${Number(node.accentColor).toString(16).padStart(6, '0')}`
      return `Container${colour}${node.spoiler === true ? '  (spoiler)' : ''}`
    }
    case 'button': {
      const style = String(node.style)
      const label = node.label === undefined ? '' : ` "${truncate(String(node.label), 32)}"`
      const target =
        style === 'link'
          ? ` -> ${truncate(String(node.url), 40)}`
          : style === 'premium'
            ? ` -> sku ${String(node.skuId)}`
            : ` -> ${describeAction(node.action)}`
      return `Button[${style}]${label}${target}`
    }
    default: {
      if (String(node.type).endsWith('Select')) {
        const options =
          node.options === undefined
            ? ''
            : ` (${(node.options as ReadonlyArray<unknown>).length} options)`
        return `${String(node.type)}${options} -> ${describeAction(node.action)}`
      }
      return String(node.type)
    }
  }
}

const describeAction = (action: unknown): string => {
  const a = action as { type?: string; key?: string } | undefined
  return a === undefined ? 'UNBOUND' : `${a.type}:${a.key}`
}

const childrenOf = (
  node: Record<string, unknown>,
): ReadonlyArray<[string, Record<string, unknown>]> => {
  const out: [string, Record<string, unknown>][] = []
  const components = node.components as ReadonlyArray<Record<string, unknown>> | undefined
  if (components !== undefined) for (const c of components) out.push(['', c])
  const accessory = node.accessory as Record<string, unknown> | undefined
  if (accessory !== undefined) out.push(['accessory: ', accessory])
  return out
}

const renderNode = (
  node: Record<string, unknown>,
  prefix: string,
  isLast: boolean,
  lines: string[],
  label = '',
): void => {
  lines.push(`${prefix}${isLast ? '└─ ' : '├─ '}${label}${describe(node)}`)

  const children = childrenOf(node)
  const childPrefix = `${prefix}${isLast ? '   ' : '│  '}`
  children.forEach(([childLabel, child], i) => {
    renderNode(child, childPrefix, i === children.length - 1, lines, childLabel)
  })
}

export const asciiLayout = (components: ReadonlyArray<ComponentsV2TopLevel>): string => {
  if (components.length === 0) return '(empty message)'

  const lines: string[] = ['message']
  components.forEach((node, i) => {
    renderNode(node as Record<string, unknown>, '', i === components.length - 1, lines)
  })
  return lines.join('\n')
}
