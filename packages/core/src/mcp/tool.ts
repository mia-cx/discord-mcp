import type { StandardJSONSchemaV1, StandardSchemaV1 } from '@standard-schema/spec'
import { Context, type Effect, type Schema } from 'effect'
import { ValidationError } from '../errors.js'
import { toJsonSchema } from './schema.js'

export type RiskClass = 'read' | 'write' | 'destructive' | 'bot_admin' | 'credential'
export type Toolset = 'operator' | 'automation' | 'admin' | 'api'

export interface ToolAnnotations {
  readonly readOnlyHint?: boolean
  readonly destructiveHint?: boolean
  readonly idempotentHint?: boolean
  readonly openWorldHint?: boolean
}

export interface ToolDef<A, Out, R = never> {
  readonly name: string
  readonly title: string
  readonly description: string
  readonly toolset: Toolset
  readonly gate?: 'always' | 'gateway' | 'workflows'
  readonly risk: RiskClass
  readonly scopes: ReadonlyArray<string>
  readonly annotations: ToolAnnotations
  readonly input: Schema.ConstraintDecoder<A, never>
  readonly output?: Schema.Top
  readonly handler: (args: A) => Effect.Effect<Out, unknown, R>
}

export const defineTool = <A, Out, R>(definition: ToolDef<A, Out, R>) => definition

const toolName = /^[a-z0-9_]{1,64}$/

export type McpStandardSchema = StandardSchemaV1<unknown, unknown> &
  StandardJSONSchemaV1<unknown, unknown>

export interface RegisteredToolMetadata {
  readonly title: string
  readonly description: string
  readonly inputSchema: McpStandardSchema
  readonly outputSchema: McpStandardSchema
  readonly annotations?: ToolAnnotations
}

export interface ToolRegistryService {
  readonly prepare: (
    name: string,
    definition: RegisteredToolMetadata,
  ) => RegisteredToolMetadata | undefined
  readonly names: () => ReadonlySet<string>
}

/** Startup-owned registry used by the MCP application layer. */
export class ToolRegistry extends Context.Service<ToolRegistry, ToolRegistryService>()(
  '@discord-mcp/core/ToolRegistry',
) {}

const compileStandardSchema = (
  tool: string,
  kind: 'input' | 'output',
  schema: McpStandardSchema,
): Record<string, unknown> => {
  try {
    const generated = schema['~standard'].jsonSchema[kind]({ target: 'draft-2020-12' })
    const alternatives = Array.isArray(generated.anyOf)
      ? generated.anyOf
      : Array.isArray(generated.oneOf)
        ? generated.oneOf
        : undefined
    const objectUnion =
      kind === 'output' &&
      alternatives !== undefined &&
      alternatives.length > 0 &&
      alternatives.every(
        (alternative) =>
          typeof alternative === 'object' &&
          alternative !== null &&
          (alternative as { readonly type?: unknown }).type === 'object',
      )
    if (generated.type !== 'object' && !objectUnion) {
      throw new ValidationError(`${kind} schema root must have type "object"`)
    }
    return objectUnion ? { ...generated, type: 'object' } : generated
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    throw new ValidationError(`Cannot register MCP tool "${tool}": ${message}`)
  }
}

export const makeToolRegistry = (options?: {
  readonly enabled?: (name: string) => boolean
}): ToolRegistryService => {
  const registered = new Set<string>()
  const compiled = new WeakMap<
    object,
    Partial<Record<'input' | 'output', Record<string, unknown>>>
  >()
  const prepareSchema = (
    tool: string,
    kind: 'input' | 'output',
    schema: McpStandardSchema,
  ): McpStandardSchema => {
    const cached = compiled.get(schema)?.[kind] ?? compileStandardSchema(tool, kind, schema)
    compiled.set(schema, { ...compiled.get(schema), [kind]: cached })
    const standard = schema['~standard']
    const prepared = Object.create(schema) as McpStandardSchema
    Object.defineProperty(prepared, '~standard', {
      enumerable: false,
      value: {
        ...standard,
        jsonSchema: {
          ...standard.jsonSchema,
          [kind]: () => cached,
        },
      },
    })
    return prepared
  }
  return {
    prepare: (name, definition) => {
      if (options?.enabled && !options.enabled(name)) return undefined
      if (!toolName.test(name)) throw new ValidationError(`Invalid MCP tool name: ${name}`)
      if (registered.has(name)) throw new ValidationError(`Duplicate MCP tool name: ${name}`)
      if (definition.title.trim().length === 0) {
        throw new ValidationError(`Cannot register MCP tool "${name}": title must not be empty`)
      }
      if (definition.description.trim().length === 0) {
        throw new ValidationError(
          `Cannot register MCP tool "${name}": description must not be empty`,
        )
      }
      const prepared = {
        ...definition,
        inputSchema: prepareSchema(name, 'input', definition.inputSchema),
        outputSchema: prepareSchema(name, 'output', definition.outputSchema),
      }
      registered.add(name)
      return prepared
    },
    names: () => new Set(registered),
  }
}

/** Validate tool metadata and eagerly compile all schemas before accepting connections. */
export const validateToolRegistry = (
  tools: ReadonlyArray<{ readonly name: string; readonly input: Schema.Constraint }>,
): ReadonlyMap<string, Record<string, unknown>> => {
  const names = new Set<string>()
  const schemas = new Map<string, Record<string, unknown>>()
  for (const tool of tools) {
    if (!toolName.test(tool.name)) {
      throw new ValidationError(`Invalid MCP tool name: ${tool.name}`)
    }
    if (names.has(tool.name)) {
      throw new ValidationError(`Duplicate MCP tool name: ${tool.name}`)
    }
    names.add(tool.name)
    try {
      const schema = toJsonSchema(tool.input)
      if (schema.type !== 'object') {
        throw new ValidationError('input schema root must have type "object"')
      }
      schemas.set(tool.name, schema)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      throw new ValidationError(`Cannot register MCP tool "${tool.name}": ${message}`)
    }
  }
  return schemas
}
