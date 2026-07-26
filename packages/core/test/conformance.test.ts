import { Effect, Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import { Snowflake } from '../src/ids.ts'
import { McpInput } from '../src/mcp/schema.ts'

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

  it('is idempotent, so registering a shared schema twice is safe', () => {
    const schema = Schema.Struct({ a: Schema.String })
    expect(McpInput(schema)).toBe(McpInput(schema))
  })
})
