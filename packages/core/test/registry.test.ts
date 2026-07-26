import { Effect, Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import { selectTools, ToolRegistrationError, validateTool } from '../src/mcp/registry.ts'
import { type AnyToolDef, defineTool } from '../src/mcp/tool.ts'

const base = {
  title: 'x',
  description: 'x',
  toolset: 'operator',
  risk: 'read',
  scopes: [],
  annotations: {},
  handler: () => Effect.succeed({}),
} as const

const tool = (over: Partial<AnyToolDef>): AnyToolDef =>
  defineTool({
    ...base,
    name: 'ok_tool',
    input: Schema.Struct({}),
    ...over,
  } as AnyToolDef)

describe('validateTool', () => {
  it('accepts an object-rooted schema and returns the advertised JSON Schema', () => {
    const schema = validateTool(tool({ input: Schema.Struct({ a: Schema.String }) }))
    expect(schema.type).toBe('object')
    expect(schema.properties).toHaveProperty('a')
  })

  it('rejects a non-object root at startup, naming the tool', () => {
    // MCP itself only fails at tools/list, where the failure would break discovery for every tool
    // on the server. Catching it here is the whole point of eager validation.
    expect(() => validateTool(tool({ name: 'bad_root', input: Schema.String as never }))).toThrow(
      ToolRegistrationError,
    )
    expect(() => validateTool(tool({ name: 'bad_root', input: Schema.String as never }))).toThrow(
      /bad_root/,
    )
  })

  it('rejects a name MCP would not accept', () => {
    expect(() => validateTool(tool({ name: 'Not-Valid' }))).toThrow(/Not-Valid/)
    expect(() => validateTool(tool({ name: '' }))).toThrow(ToolRegistrationError)
  })

  it('advertises constraints and descriptions at the property level', () => {
    // Effect emits every check as an `allOf` entry and carries a trailing `.annotate()` into it,
    // so without hoisting a constrained field's description hides at `.allOf[0].description` and
    // most clients render nothing for exactly the parameter that needed explaining.
    const schema = validateTool(
      tool({
        input: Schema.Struct({
          id: Schema.String.pipe(Schema.check(Schema.isMinLength(3))).annotate({
            description: 'the id',
          }),
          optional: Schema.optionalKey(Schema.Int),
        }),
      }),
    )

    expect(schema.required).toEqual(['id'])
    const properties = schema.properties as Record<string, Record<string, unknown>>
    expect(properties.id?.minLength).toBe(3)
    expect(properties.id?.description).toBe('the id')
  })
})

describe('selectTools', () => {
  const tools = [
    tool({ name: 'op', toolset: 'operator' }),
    tool({ name: 'api', toolset: 'api' }),
    tool({ name: 'gated', toolset: 'operator', gate: 'gateway' }),
  ]

  it('filters by toolset', () => {
    const selected = selectTools(tools, {
      toolsets: new Set(['operator']),
      enabledGates: new Set(['always']),
    })
    expect(selected.map((t) => t.name)).toEqual(['op'])
  })

  it('withholds tools whose subsystem is not enabled', () => {
    const selected = selectTools(tools, {
      toolsets: new Set(['operator']),
      enabledGates: new Set(['always', 'gateway']),
    })
    expect(selected.map((t) => t.name)).toEqual(['op', 'gated'])
  })
})
