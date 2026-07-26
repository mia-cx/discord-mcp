import { ValidationError } from '@discord-mcp/core'
import { Effect, Schema } from 'effect'
import { MessagePresentation } from './schema.ts'

/**
 * Versioned message templates.
 *
 * A template holds a **declarative** variable-schema AST and a presentation AST with
 * `{{placeholders}}`. It cannot submit executable transforms, and no JavaScript expression or
 * general template language runs in the control plane — a template is data supplied by an agent,
 * and evaluating agent-supplied code in the process holding the bot token would be the single
 * worst decision available here.
 *
 * Interpolation is structural: each variable declares the context it will be rendered into, and
 * rendering escapes for exactly that context.
 */

const bounded =
  <S extends Schema.Top & { readonly Type: { readonly length: number } }>(
    min: number,
    max: number,
  ) =>
  (self: S): S['Rebuild'] =>
    Schema.check<S>(Schema.isMinLength(min), Schema.isMaxLength(max))(self)

/**
 * Where a value will end up, which decides how it is escaped.
 *
 * Getting this wrong is how a template becomes an injection vector: a user-supplied name rendered
 * as `discordMarkdown` can close a code fence or forge a mention.
 */
export const RenderContext = Schema.Literals([
  'plainText',
  'discordMarkdown',
  'inlineCode',
  'codeBlock',
  'url',
  'userMention',
  'roleMention',
  'channelMention',
])
export type RenderContext = typeof RenderContext.Type

const variableBase = {
  description: Schema.optionalKey(Schema.String.pipe(bounded(1, 200))),
  required: Schema.optionalKey(Schema.Boolean),
  context: Schema.optionalKey(RenderContext),
}

/**
 * The variable-schema AST.
 *
 * Deliberately a closed, serializable set. Anything expressive enough to compute would be
 * expressive enough to abuse.
 */
export const VariableNode: Schema.Codec<VariableNodeType> = Schema.suspend(() =>
  Schema.Union([
    Schema.Struct({
      kind: Schema.Literal('string'),
      ...variableBase,
      minLength: Schema.optionalKey(Schema.Int),
      maxLength: Schema.optionalKey(Schema.Int),
      default: Schema.optionalKey(Schema.String),
    }),
    Schema.Struct({
      kind: Schema.Literal('number'),
      ...variableBase,
      minimum: Schema.optionalKey(Schema.Number),
      maximum: Schema.optionalKey(Schema.Number),
      default: Schema.optionalKey(Schema.Number),
    }),
    Schema.Struct({
      kind: Schema.Literal('boolean'),
      ...variableBase,
      default: Schema.optionalKey(Schema.Boolean),
    }),
    Schema.Struct({ kind: Schema.Literal('snowflake'), ...variableBase }),
    Schema.Struct({ kind: Schema.Literal('url'), ...variableBase }),
    Schema.Struct({ kind: Schema.Literal('timestamp'), ...variableBase }),
    Schema.Struct({
      kind: Schema.Literal('enum'),
      ...variableBase,
      values: Schema.Array(Schema.String).pipe(bounded(1, 50)),
      default: Schema.optionalKey(Schema.String),
    }),
    Schema.Struct({ kind: Schema.Literal('array'), ...variableBase, items: VariableNode }),
    Schema.Struct({
      kind: Schema.Literal('object'),
      ...variableBase,
      properties: Schema.Record(Schema.String, VariableNode),
    }),
  ]),
) as Schema.Codec<VariableNodeType>

export type VariableNodeType =
  | {
      kind: 'string'
      description?: string
      required?: boolean
      context?: RenderContext
      minLength?: number
      maxLength?: number
      default?: string
    }
  | {
      kind: 'number'
      description?: string
      required?: boolean
      context?: RenderContext
      minimum?: number
      maximum?: number
      default?: number
    }
  | {
      kind: 'boolean'
      description?: string
      required?: boolean
      context?: RenderContext
      default?: boolean
    }
  | { kind: 'snowflake'; description?: string; required?: boolean; context?: RenderContext }
  | { kind: 'url'; description?: string; required?: boolean; context?: RenderContext }
  | { kind: 'timestamp'; description?: string; required?: boolean; context?: RenderContext }
  | {
      kind: 'enum'
      description?: string
      required?: boolean
      context?: RenderContext
      values: ReadonlyArray<string>
      default?: string
    }
  | {
      kind: 'array'
      description?: string
      required?: boolean
      context?: RenderContext
      items: VariableNodeType
    }
  | {
      kind: 'object'
      description?: string
      required?: boolean
      context?: RenderContext
      properties: Record<string, VariableNodeType>
    }

export const MessageTemplate = Schema.Struct({
  variables: Schema.Record(Schema.String, VariableNode),
  /** A presentation with `{{name}}` placeholders in its string fields. */
  presentation: MessagePresentation,
})
export type MessageTemplate = typeof MessageTemplate.Type

// ---------------------------------------------------------------- escaping

/** Characters Discord treats as markdown. Escaping them keeps a value inert. */
const MARKDOWN_SPECIALS = /([*_~`>|\\[\]()#-])/g

/**
 * Escape a rendered value for the context it lands in.
 *
 * `plainText` is the default and the safest: it neutralises markdown *and* the `@` that starts a
 * mention, so a user-supplied display name cannot forge a ping even if allowed-mentions were
 * misconfigured.
 */
export const escapeFor = (value: string, context: RenderContext): string => {
  switch (context) {
    case 'plainText':
      return value.replaceAll(MARKDOWN_SPECIALS, '\\$1').replaceAll('@', '@​')
    case 'discordMarkdown':
      // Explicitly trusted as markup. Only the author can choose this, never a variable's value.
      return value
    case 'inlineCode':
      // A backtick would close the span and let the rest render as markdown.
      return `\`${value.replaceAll('`', '')}\``
    case 'codeBlock':
      return `\`\`\`\n${value.replaceAll('```', '')}\n\`\`\``
    case 'url':
      return encodeURI(value)
    case 'userMention':
      return `<@${value.replaceAll(/\D/g, '')}>`
    case 'roleMention':
      return `<@&${value.replaceAll(/\D/g, '')}>`
    case 'channelMention':
      return `<#${value.replaceAll(/\D/g, '')}>`
  }
}

// ---------------------------------------------------------------- compilation

const SNOWFLAKE = /^\d{17,21}$/

/**
 * Validate supplied variables against the declared AST.
 *
 * Compiled to checks rather than to an Effect Schema, because the AST is data loaded at runtime
 * and building a schema per render would cost more than the validation it performs.
 */
export const validateVariables = (
  declared: Record<string, VariableNodeType>,
  supplied: unknown,
): Effect.Effect<Record<string, unknown>, ValidationError> => {
  const issues: string[] = []
  const values = (supplied ?? {}) as Record<string, unknown>
  const out: Record<string, unknown> = {}

  for (const [name, node] of Object.entries(declared)) {
    const provided = values[name]
    const value = provided ?? ('default' in node ? node.default : undefined)

    if (value === undefined) {
      if (node.required === true) issues.push(`variables.${name}: required but not supplied.`)
      continue
    }
    checkNode(`variables.${name}`, node, value, issues)
    out[name] = value
  }

  for (const name of Object.keys(values)) {
    if (!(name in declared)) {
      issues.push(
        `variables.${name}: not declared by this template. Declared variables are: ${Object.keys(declared).join(', ') || '(none)'}.`,
      )
    }
  }

  return issues.length === 0
    ? Effect.succeed(out)
    : Effect.fail(new ValidationError({ message: 'Template variables are not valid.', issues }))
}

/** Scalar kinds, each with the one rule that makes its values safe to interpolate. */
const SCALAR_CHECKS: Record<string, (value: unknown) => string | undefined> = {
  boolean: (v) => (typeof v === 'boolean' ? undefined : 'expected true or false.'),
  snowflake: (v) =>
    typeof v === 'string' && SNOWFLAKE.test(v)
      ? undefined
      : 'expected a Discord ID of 17-21 digits.',
  // http/https only: a `javascript:` value would otherwise become a clickable script link.
  url: (v) =>
    typeof v === 'string' && /^https?:\/\//.test(v) ? undefined : 'expected an http or https URL.',
  timestamp: (v) =>
    typeof v === 'string' && !Number.isNaN(Date.parse(v))
      ? undefined
      : 'expected an ISO 8601 timestamp.',
}

const checkString = (
  path: string,
  node: Extract<VariableNodeType, { kind: 'string' }>,
  value: unknown,
  issues: string[],
) => {
  if (typeof value !== 'string') return void issues.push(`${path}: expected a string.`)
  if (node.minLength !== undefined && value.length < node.minLength) {
    issues.push(`${path}: shorter than ${node.minLength} characters.`)
  }
  if (node.maxLength !== undefined && value.length > node.maxLength) {
    issues.push(`${path}: longer than ${node.maxLength} characters.`)
  }
}

const checkNumber = (
  path: string,
  node: Extract<VariableNodeType, { kind: 'number' }>,
  value: unknown,
  issues: string[],
) => {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return void issues.push(`${path}: expected a number.`)
  }
  if (node.minimum !== undefined && value < node.minimum) {
    issues.push(`${path}: below ${node.minimum}.`)
  }
  if (node.maximum !== undefined && value > node.maximum) {
    issues.push(`${path}: above ${node.maximum}.`)
  }
}

const checkObject = (
  path: string,
  node: Extract<VariableNodeType, { kind: 'object' }>,
  value: unknown,
  issues: string[],
) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return void issues.push(`${path}: expected an object.`)
  }
  for (const [key, child] of Object.entries(node.properties)) {
    const inner = (value as Record<string, unknown>)[key]
    if (inner === undefined) {
      if (child.required === true) issues.push(`${path}.${key}: required but not supplied.`)
      continue
    }
    checkNode(`${path}.${key}`, child, inner, issues)
  }
}

const checkNode = (
  path: string,
  node: VariableNodeType,
  value: unknown,
  issues: string[],
): void => {
  const scalar = SCALAR_CHECKS[node.kind]
  if (scalar !== undefined) {
    const problem = scalar(value)
    if (problem !== undefined) issues.push(`${path}: ${problem}`)
    return
  }

  switch (node.kind) {
    case 'string':
      checkString(path, node, value, issues)
      return
    case 'number':
      checkNumber(path, node, value, issues)
      return
    case 'enum':
      if (typeof value !== 'string' || !node.values.includes(value)) {
        issues.push(`${path}: expected one of ${node.values.join(', ')}.`)
      }
      return
    case 'array': {
      if (!Array.isArray(value)) return void issues.push(`${path}: expected an array.`)
      value.forEach((item, i) => {
        checkNode(`${path}.${i}`, node.items, item, issues)
      })
      return
    }
    case 'object':
      checkObject(path, node, value, issues)
  }
}

// ---------------------------------------------------------------- rendering

const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g

const lookup = (values: Record<string, unknown>, path: string): unknown =>
  path.split('.').reduce<unknown>((acc, part) => {
    if (acc === null || typeof acc !== 'object') return undefined
    return (acc as Record<string, unknown>)[part]
  }, values)

const contextFor = (declared: Record<string, VariableNodeType>, path: string): RenderContext => {
  const root = path.split('.')[0] as string
  // plainText is the default deliberately: a template author has to opt in to letting a value
  // carry markup, rather than opting out of it.
  return declared[root]?.context ?? 'plainText'
}

/** Substitute placeholders in every string of the presentation, escaping per declared context. */
const interpolate = (
  node: unknown,
  values: Record<string, unknown>,
  declared: Record<string, VariableNodeType>,
  issues: string[],
): unknown => {
  if (typeof node === 'string') {
    return node.replaceAll(PLACEHOLDER, (_match, path: string) => {
      const value = lookup(values, path)
      if (value === undefined) {
        issues.push(`presentation: {{${path}}} has no value and no default.`)
        return ''
      }
      return escapeFor(String(value), contextFor(declared, path))
    })
  }
  if (Array.isArray(node)) return node.map((item) => interpolate(item, values, declared, issues))
  if (node === null || typeof node !== 'object') return node

  return Object.fromEntries(
    Object.entries(node as Record<string, unknown>).map(([key, value]) => [
      key,
      interpolate(value, values, declared, issues),
    ]),
  )
}

/**
 * Render a template into a presentation.
 *
 * The result goes through the ordinary message validator afterwards — a template is a way of
 * producing a presentation, never a way of bypassing the checks one has to pass.
 */
export const renderTemplate = (
  template: MessageTemplate,
  suppliedVariables: unknown,
): Effect.Effect<typeof MessagePresentation.Type, ValidationError> =>
  Effect.gen(function* () {
    const declared = template.variables as Record<string, VariableNodeType>
    const values = yield* validateVariables(declared, suppliedVariables)

    const issues: string[] = []
    const rendered = interpolate(template.presentation, values, declared, issues)

    if (issues.length > 0) {
      return yield* Effect.fail(
        new ValidationError({ message: 'The template could not be rendered.', issues }),
      )
    }

    // Decode again: interpolation could in principle produce a string that violates a length
    // bound, and a template must not be able to emit a presentation a hand-authored send could not.
    return yield* Effect.mapError(
      Schema.decodeUnknownEffect(MessagePresentation, { errors: 'all' })(rendered),
      (cause) =>
        new ValidationError({
          message: 'The rendered template is not a valid presentation.',
          issues: [String(cause.issue)],
        }),
    )
  })
