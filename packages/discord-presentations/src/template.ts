import { createHash } from 'node:crypto'
import { Schema } from 'effect'
import type { MessagePresentation } from './types.js'
import { validateMessage } from './validation.js'

export type VariableSchema =
  | {
      readonly type: 'string'
      readonly minLength?: number
      readonly maxLength?: number
      readonly default?: string
    }
  | {
      readonly type: 'number'
      readonly minimum?: number
      readonly maximum?: number
      readonly default?: number
    }
  | { readonly type: 'boolean'; readonly default?: boolean }
  | { readonly type: 'snowflake'; readonly default?: string }
  | { readonly type: 'url'; readonly default?: string }
  | { readonly type: 'timestamp'; readonly default?: string }
  | { readonly type: 'enum'; readonly values: ReadonlyArray<string>; readonly default?: string }
  | {
      readonly type: 'array'
      readonly items: VariableSchema
      readonly maxItems?: number
      readonly default?: ReadonlyArray<unknown>
    }
  | {
      readonly type: 'object'
      readonly properties: Readonly<Record<string, VariableSchema>>
      readonly required?: ReadonlyArray<string>
      readonly default?: Readonly<Record<string, unknown>>
    }
  | { readonly type: 'optional'; readonly value: VariableSchema; readonly default?: unknown }

export type InterpolationContext =
  | 'plainText'
  | 'discordMarkdown'
  | 'inlineCode'
  | 'codeBlock'
  | 'url'
  | 'mentionUser'
  | 'mentionRole'

export interface VariableReference {
  readonly $variable: string
  readonly context: InterpolationContext
}

export interface MessageTemplateDocument {
  readonly variableSchema: Readonly<Record<string, VariableSchema>>
  readonly presentation: unknown
}

export class TemplateError extends Schema.TaggedErrorClass<TemplateError>()('TemplateError', {
  message: Schema.String,
}) {
  constructor(message: string) {
    super({ message })
  }
}

const own = (value: object, key: string): boolean => Object.hasOwn(value, key)

const decodeVariable = (schema: VariableSchema, input: unknown, path: string): unknown => {
  const value = input === undefined && 'default' in schema ? schema.default : input
  if (schema.type === 'optional' && value === undefined) return undefined
  switch (schema.type) {
    case 'string':
      if (typeof value !== 'string') throw new TemplateError(`${path} must be a string`)
      if (value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? 4_000)) {
        throw new TemplateError(`${path} has an invalid length`)
      }
      return value
    case 'number':
      if (
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        value < (schema.minimum ?? -Infinity) ||
        value > (schema.maximum ?? Infinity)
      ) {
        throw new TemplateError(`${path} must be a number in the configured range`)
      }
      return value
    case 'boolean':
      if (typeof value !== 'boolean') throw new TemplateError(`${path} must be a boolean`)
      return value
    case 'snowflake':
      if (typeof value !== 'string' || !/^\d{17,21}$/.test(value)) {
        throw new TemplateError(`${path} must be a Discord snowflake`)
      }
      return value
    case 'url':
      if (typeof value !== 'string') throw new TemplateError(`${path} must be an https URL`)
      try {
        if (new URL(value).protocol !== 'https:') throw new Error('not https')
      } catch {
        throw new TemplateError(`${path} must be an https URL`)
      }
      return value
    case 'timestamp':
      if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
        throw new TemplateError(`${path} must be an ISO timestamp`)
      }
      return value
    case 'enum':
      if (typeof value !== 'string' || !schema.values.includes(value)) {
        throw new TemplateError(`${path} must be one of: ${schema.values.join(', ')}`)
      }
      return value
    case 'array':
      if (!Array.isArray(value) || value.length > (schema.maxItems ?? 100)) {
        throw new TemplateError(`${path} must be a bounded array`)
      }
      return value.map((item, index) => decodeVariable(schema.items, item, `${path}.${index}`))
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new TemplateError(`${path} must be an object`)
      }
      const record = value as Record<string, unknown>
      for (const key of Object.keys(record)) {
        if (!own(schema.properties, key)) throw new TemplateError(`${path}.${key} is not declared`)
      }
      const output: Record<string, unknown> = {}
      for (const [key, child] of Object.entries(schema.properties)) {
        const decoded = decodeVariable(child, record[key], `${path}.${key}`)
        if (decoded === undefined && (schema.required ?? []).includes(key)) {
          throw new TemplateError(`${path}.${key} is required`)
        }
        if (decoded !== undefined) output[key] = decoded
      }
      return output
    }
    case 'optional':
      return decodeVariable(schema.value, value, path)
  }
}

const format = (value: unknown, context: InterpolationContext): string => {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  switch (context) {
    case 'discordMarkdown':
      return text
    case 'plainText':
      return text.replaceAll(/([\\`*_{}[\]()<>#+\-.!|~])/g, '\\$1')
    case 'inlineCode':
      return text.replaceAll('`', '\\`').replaceAll('\n', ' ')
    case 'codeBlock':
      return text.replaceAll('```', '``\u200b`')
    case 'url':
      return encodeURIComponent(text)
    case 'mentionUser':
      if (!/^\d{17,21}$/.test(text))
        throw new TemplateError('user mention value must be a snowflake')
      return `<@${text}>`
    case 'mentionRole':
      if (!/^\d{17,21}$/.test(text))
        throw new TemplateError('role mention value must be a snowflake')
      return `<@&${text}>`
  }
}

const isReference = (value: unknown): value is VariableReference =>
  typeof value === 'object' &&
  value !== null &&
  Object.keys(value).length === 2 &&
  typeof (value as Record<string, unknown>).$variable === 'string' &&
  typeof (value as Record<string, unknown>).context === 'string'

const resolvePath = (variables: Readonly<Record<string, unknown>>, path: string): unknown => {
  let value: unknown = variables
  for (const segment of path.split('.')) {
    if (typeof value !== 'object' || value === null || !own(value, segment)) {
      throw new TemplateError(`Unknown template variable: ${path}`)
    }
    value = (value as Record<string, unknown>)[segment]
  }
  return value
}

const interpolate = (node: unknown, variables: Readonly<Record<string, unknown>>): unknown => {
  if (isReference(node)) return format(resolvePath(variables, node.$variable), node.context)
  if (Array.isArray(node)) return node.map((child) => interpolate(child, variables))
  if (typeof node === 'object' && node !== null) {
    return Object.fromEntries(
      Object.entries(node).map(([key, child]) => [key, interpolate(child, variables)]),
    )
  }
  return node
}

export const renderTemplate = (
  document: MessageTemplateDocument,
  input: unknown,
): {
  readonly presentation: Exclude<MessagePresentation, { type: 'template' }>
  readonly digest: string
  readonly warnings: ReadonlyArray<string>
} => {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new TemplateError('template variables must be an object')
  }
  const values = input as Record<string, unknown>
  for (const key of Object.keys(values)) {
    if (!own(document.variableSchema, key))
      throw new TemplateError(`variables.${key} is not declared`)
  }
  const variables: Record<string, unknown> = {}
  for (const [key, schema] of Object.entries(document.variableSchema)) {
    const decoded = decodeVariable(schema, values[key], `variables.${key}`)
    if (decoded !== undefined) variables[key] = decoded
  }
  const presentation = interpolate(document.presentation, variables) as Exclude<
    MessagePresentation,
    { type: 'template' }
  >
  if (presentation.type !== 'legacy' && presentation.type !== 'components_v2') {
    throw new TemplateError('template must render a legacy or Components V2 presentation')
  }
  const report = validateMessage(presentation, 'template-render')
  return {
    presentation,
    digest: createHash('sha256').update(JSON.stringify(document)).digest('hex'),
    warnings: report.warnings,
  }
}
