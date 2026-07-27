import type { StandardJSONSchemaV1, StandardSchemaV1 } from '@standard-schema/spec'
import { Schema } from 'effect'

/** Convert an Effect Schema into the Standard Schema object consumed by MCP v2. */
export const McpInput = <S extends Schema.ConstraintDecoder<unknown, never>>(
  schema: S,
): S & StandardSchemaV1<S['Encoded'], S['Type']> & StandardJSONSchemaV1<S['Encoded'], S['Type']> =>
  Schema.toStandardJSONSchemaV1(
    Schema.toStandardSchemaV1(schema, {
      parseOptions: { errors: 'all', onExcessProperty: 'error' },
    }),
  )

/** Produce a standalone draft-2020-12 schema with its definitions embedded. */
export const toJsonSchema = (schema: Schema.Constraint): Record<string, unknown> => {
  const document = Schema.toJsonSchemaDocument(schema)
  const output: Record<string, unknown> = { ...document.schema }
  if (Object.keys(document.definitions).length > 0) {
    output.$defs = document.definitions
  }
  return output
}
