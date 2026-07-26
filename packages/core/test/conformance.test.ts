import { Effect, Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import { Snowflake } from '../src/ids.ts'
import { McpInput, toMcpInputJsonSchema } from '../src/mcp/schema.ts'

/**
 * The property the whole bridge rests on: the JSON Schema MCP advertises and the Effect decoding a
 * handler performs must accept and reject exactly the same values.
 *
 * If they diverge, a model is told one contract and judged against another, and the resulting
 * errors are unattributable.
 */
const assertAgreement = async (
  schema: Schema.Struct<Schema.Struct.Fields>,
  fixtures: ReadonlyArray<unknown>,
) => {
  const bridged = McpInput(schema)
  const standard = bridged['~standard']
  const decode = Schema.decodeUnknownEffect(schema, { errors: 'all' })

  for (const fixture of fixtures) {
    const viaEffect = (await Effect.runPromiseExit(decode(fixture)))._tag === 'Success'
    const viaStandard = (await standard.validate(fixture)).issues === undefined

    expect(
      viaStandard,
      `disagreement on ${JSON.stringify(fixture)}: Effect ${viaEffect}, standard-schema ${viaStandard}`,
    ).toBe(viaEffect)
  }
}

describe('McpInput conformance', () => {
  it('agrees with Effect decoding on snowflake inputs', async () => {
    await assertAgreement(Schema.Struct({ guildId: Snowflake }), [
      { guildId: '123456789012345678' },
      { guildId: '12345678901234567890' },
      { guildId: '1234567890123456' }, // 16 digits: too short
      { guildId: '123456789012345678901234' }, // too long
      { guildId: 'abcdefghijklmnopqr' },
      { guildId: 123456789 },
      { guildId: null },
      {},
    ])
  })

  it('agrees on exact-optional versus nullable keys', async () => {
    await assertAgreement(
      Schema.Struct({
        required: Schema.String,
        exactOptional: Schema.optionalKey(Schema.Boolean),
        nullable: Schema.NullOr(Schema.Int),
      }),
      [
        { required: 'a', nullable: null },
        { required: 'a', nullable: 1, exactOptional: true },
        { required: 'a', nullable: 1, exactOptional: 'yes' },
        { required: 'a' },
        { nullable: null },
      ],
    )
  })

  it('agrees on nested structures and arrays', async () => {
    await assertAgreement(
      Schema.Struct({
        items: Schema.Array(Schema.Struct({ id: Snowflake, weight: Schema.Int })).pipe(
          Schema.check(Schema.isMaxLength(2)),
        ),
      }),
      [
        { items: [] },
        { items: [{ id: '123456789012345678', weight: 1 }] },
        { items: [{ id: 'bad', weight: 1 }] },
        { items: [{ id: '123456789012345678' }] },
        {
          items: [
            { id: '123456789012345678', weight: 1 },
            { id: '123456789012345678', weight: 2 },
            { id: '123456789012345678', weight: 3 },
          ],
        },
      ],
    )
  })

  it('advertises additionalProperties:false that nothing on the MCP path enforces', async () => {
    // Worth stating plainly, because it shapes how schemas must be written.
    //
    // `toStandardJSONSchemaV1` emits `additionalProperties: false`, but Effect decodes leniently by
    // default and MCP's `~standard.validate` is lenient too. Worse, MCP validates *before* the
    // handler runs and passes the validated value on, so excess keys are already gone by the time
    // our decode sees the arguments — `onExcessProperty: 'error'` in the registry cannot fire for
    // them on this path (it still guards direct handler calls from workflows and tests).
    //
    // The consequence: a field that must be *rejected* has to be declared, not omitted. See
    // `forbiddenUnderV2` in discord-presentations, where content/embeds/stickerIds/poll are
    // declared as `Never` so their presence is a decode failure that names them, instead of being
    // silently stripped and losing the author's intent.
    const schema = Schema.Struct({ a: Schema.String })
    const excess = { a: 'x', unexpectd: 1 }

    expect(toMcpInputJsonSchema(schema).additionalProperties).toBe(false)
    expect((await McpInput(schema)['~standard'].validate(excess)).issues).toBeUndefined()

    const lenient = await Effect.runPromiseExit(Schema.decodeUnknownEffect(schema)(excess))
    const strict = await Effect.runPromiseExit(
      Schema.decodeUnknownEffect(schema, { onExcessProperty: 'error', errors: 'all' })(excess),
    )
    expect(lenient._tag).toBe('Success')
    expect(strict._tag).toBe('Failure')
  })

  it('is idempotent, so registering a shared schema twice is safe', () => {
    const schema = Schema.Struct({ a: Schema.String })
    expect(McpInput(schema)).toBe(McpInput(schema))
  })
})
