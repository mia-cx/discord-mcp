import { Effect, Exit, Layer, ManagedRuntime, Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import { DiscordToolResultSchema } from '../result.js'
import { McpInput, toJsonSchema } from './schema.js'
import { makeToolRegistry, ToolRegistry, validateToolRegistry } from './tool.js'

describe('Effect to MCP schema bridge', () => {
  const Input = Schema.Struct({
    name: Schema.String.pipe(Schema.check(Schema.isMinLength(2))),
    count: Schema.optionalKey(Schema.Int),
  })

  it('advertises a self-contained object schema', () => {
    const json = toJsonSchema(Input)
    expect(json.type).toBe('object')
    expect(json.required).toEqual(['name'])
  })

  it('uses the same decoder for MCP and direct Effect validation', async () => {
    const input = McpInput(Input)
    expect(await input['~standard'].validate({ name: 'ok', count: 2 })).toEqual({
      value: { name: 'ok', count: 2 },
    })
    const invalid = await input['~standard'].validate({ name: '' })
    expect('issues' in invalid).toBe(true)
  })

  it('rejects mixed success and failure tool-result envelopes', async () => {
    const output = McpInput(DiscordToolResultSchema(Schema.Struct({ value: Schema.String })))
    const success = {
      ok: true,
      data: { value: 'accepted' },
      meta: { requestId: 'request', authProfile: 'bot', truncated: false },
      warnings: [],
    }
    expect(await output['~standard'].validate(success)).toEqual({ value: success })
    expect(
      'issues' in
        (await output['~standard'].validate({
          ...success,
          error: { code: 'INVALID', message: 'mixed', retryable: false },
        })),
    ).toBe(true)
    expect(
      'issues' in
        (await output['~standard'].validate({
          ok: false,
          data: { value: 'forbidden' },
          error: { code: 'INVALID', message: 'failed', retryable: false },
          meta: { requestId: 'request' },
        })),
    ).toBe(true)
  })

  it('fails startup with the offending tool name for a non-object root', () => {
    expect(() => validateToolRegistry([{ name: 'bad_tool', input: Schema.String }])).toThrow(
      'Cannot register MCP tool "bad_tool"',
    )
  })

  it('provides an eager, gated registry as an Effect service', async () => {
    const registry = makeToolRegistry({ enabled: (name) => name !== 'hidden_tool' })
    const definition = {
      title: 'Visible',
      description: 'A complete test registration.',
      inputSchema: McpInput(Input),
      outputSchema: McpInput(Schema.Struct({ ok: Schema.Boolean })),
    }
    expect(registry.prepare('hidden_tool', definition)).toBeUndefined()
    expect(registry.prepare('visible_tool', definition)).toMatchObject({
      title: 'Visible',
      description: 'A complete test registration.',
    })
    expect(() => registry.prepare('visible_tool', definition)).toThrow('Duplicate MCP tool name')
    expect(() =>
      registry.prepare('scalar_tool', {
        ...definition,
        inputSchema: McpInput(Schema.String),
      }),
    ).toThrow('input schema root')

    const runtime = ManagedRuntime.make(Layer.succeed(ToolRegistry, registry))
    expect(
      await runtime.runPromise(ToolRegistry.useSync((service) => [...service.names()])),
    ).toEqual(['visible_tool'])
    await runtime.dispose()
  })

  it('supports AbortSignal cancellation through ManagedRuntime.runPromiseExit', async () => {
    const runtime = ManagedRuntime.make(Layer.empty)
    const controller = new AbortController()
    const pending = runtime.runPromiseExit(Effect.never, { signal: controller.signal })
    controller.abort()
    expect(Exit.isFailure(await pending)).toBe(true)
    await runtime.dispose()
  })
})
