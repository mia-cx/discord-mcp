import { parse } from 'acorn'
import { transform } from 'esbuild'

const COLLECTOR_ISSUE =
  'source: collectors and awaitMessages wait for later events, but each event runs in a fresh isolate, so they never fire. Handle the later event in its own listener.'
const ATTACHMENT_ISSUE =
  "source: discord.js uploads a URL attachment as a file, and workflows can't upload files. Put the URL in the message content or an embed."

/** discord.js names that collect later events: collector classes and the methods that make one. */
const COLLECTORS = new Set([
  'MessageCollector',
  'ReactionCollector',
  'InteractionCollector',
  'createMessageCollector',
  'createReactionCollector',
  'createMessageComponentCollector',
  'awaitMessages',
  'awaitReactions',
  'awaitMessageComponent',
  'awaitModalSubmit',
])
/** Calls whose first argument discord.js treats as a file to upload. */
const FILE_TAKERS = new Set(['AttachmentBuilder', 'setFile'])
const URL_TEXT = /^https?:\/\//i

type Node = { readonly type: string } & Readonly<Record<string, unknown>>

const isNode = (value: unknown): value is Node =>
  typeof value === 'object' && value !== null && typeof (value as Node).type === 'string'

/** Every node under `root`, without recursion, so deep nesting can't overflow the stack. */
function* nodes(root: Node) {
  const stack = [root]
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    yield node
    for (const value of Object.values(node)) {
      for (const child of Array.isArray(value) ? value : [value])
        if (isNode(child)) stack.push(child)
    }
  }
}

const text = (node: unknown) =>
  isNode(node) && node.type === 'Literal' && typeof node.value === 'string' ? node.value : undefined

/** A property's or member's name: `a.name`, `a['name']`, `{ name: … }`, `{ 'name': … }`. */
const nameOf = (key: unknown, computed: unknown) =>
  computed !== true && isNode(key) && key.type === 'Identifier' ? String(key.name) : text(key)

/** A string that starts with a URL: a literal, a template, or either with more appended. */
const isUrl = (node: unknown): boolean => {
  if (!isNode(node)) return false
  if (node.type === 'BinaryExpression' && node.operator === '+') return isUrl(node.left)
  if (node.type === 'TemplateLiteral') {
    const [first] = node.quasis as ReadonlyArray<{ value: { cooked?: string } }>
    return URL_TEXT.test(first?.value.cooked ?? '')
  }
  return URL_TEXT.test(text(node) ?? '')
}

const collects = (node: Node) =>
  (node.type === 'Identifier' && COLLECTORS.has(String(node.name))) ||
  (node.type === 'MemberExpression' &&
    node.computed === true &&
    COLLECTORS.has(text(node.property) ?? ''))

const uploadsUrl = (node: Node) => {
  if (node.type === 'Property') {
    const key = nameOf(node.key, node.computed)
    if (key === 'attachment') return isUrl(node.value)
    return (
      key === 'files' &&
      isNode(node.value) &&
      node.value.type === 'ArrayExpression' &&
      (node.value.elements as ReadonlyArray<unknown>).some(isUrl)
    )
  }
  if (node.type !== 'NewExpression' && node.type !== 'CallExpression') return false
  const callee = node.callee as Node
  const name =
    callee.type === 'MemberExpression'
      ? nameOf(callee.property, callee.computed)
      : nameOf(callee, false)
  return FILE_TAKERS.has(name ?? '') && isUrl((node.arguments as ReadonlyArray<unknown>)[0])
}

/**
 * What in a workflow's own source can't work when each event runs in a fresh isolate: collectors
 * and `awaitMessages`, and URL attachments. Read from its syntax, so text that only mentions them
 * passes, and names reached through an import alias or namespace are caught. Code that builds the
 * call at runtime, or a dependency that makes it, still gets past. Source that does not compile
 * yields nothing here; bundling reports why.
 */
export const unsupportedUses = async (source: string): Promise<ReadonlyArray<string>> => {
  // CommonJS output turns every imported binding into a property of its module, `a.MessageCollector`.
  const compiled = await transform(source, {
    loader: 'ts',
    format: 'cjs',
    logLevel: 'silent',
  }).catch(() => undefined)
  if (compiled === undefined) return []
  const found = new Set<string>()
  for (const node of nodes(parse(compiled.code, { ecmaVersion: 'latest' }) as unknown as Node)) {
    if (collects(node)) found.add(COLLECTOR_ISSUE)
    if (uploadsUrl(node)) found.add(ATTACHMENT_ISSUE)
  }
  return [...found]
}
