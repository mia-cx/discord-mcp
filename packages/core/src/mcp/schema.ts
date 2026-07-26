import type { StandardJSONSchemaV1, StandardSchemaV1 } from '@standard-schema/spec'
import { Schema } from 'effect'

/**
 * A schema that can cross the MCP boundary.
 *
 * MCP validates synchronously against a plain value, so a schema whose decoding needs Effect
 * services cannot be advertised. Encoding that as a constraint makes the restriction a type
 * error at the `defineTool` call site rather than a runtime surprise.
 */
export type McpSchema = Schema.Top & { readonly DecodingServices: never }

/**
 * Effect Schema -> `StandardSchemaWithJSON`, exactly what MCP v2's `registerTool` consumes.
 *
 * MCP requires both `~standard.validate` and `~standard.jsonSchema` on one `~standard` object.
 * `toStandardSchemaV1` attaches the first, `toStandardJSONSchemaV1` the second, to the same
 * object. Both mutate and return the input schema, so this is idempotent. There is no adapter
 * package; the bridge is these two calls.
 */
export const McpInput = <S extends McpSchema>(
  s: S,
): StandardSchemaV1<S['Encoded'], S['Type']> & StandardJSONSchemaV1<S['Encoded'], S['Type']> & S =>
  Schema.toStandardJSONSchemaV1(Schema.toStandardSchemaV1(s))

/** JSON Schema target MCP v2 asks for when it serialises a tool schema. */
const MCP_JSON_SCHEMA_TARGET = 'draft-2020-12' as const

/**
 * Standalone self-contained JSON Schema, for the operation catalog, elicitation, and MCP
 * resources.
 *
 * v4 removed `topLevelReferenceStrategy`, so definitions arrive in a sibling record and we merge
 * them into `$defs` ourselves. `$defs`-embedded is what MCP means by self-contained — internal
 * `#/$defs/` references are legal, and Discord's component schemas are recursive, so inlining
 * would not terminate.
 */
export const toJsonSchema = (s: McpSchema): Record<string, unknown> => {
  const doc = Schema.toJsonSchemaDocument(s)
  const out: Record<string, unknown> = { ...doc.schema }
  if (Object.keys(doc.definitions).length > 0) out.$defs = doc.definitions
  return out
}

/** JSON Schema keywords whose values combine rather than replace, so they must not be merged up. */
const NON_MERGEABLE = new Set(['allOf', 'anyOf', 'oneOf', 'not', '$ref'])

/**
 * Lift a schema's `allOf` members into the schema itself when it is safe to do so.
 *
 * Effect v4 emits every `Schema.check` as an `allOf` entry, and carries any annotation applied
 * after a check into that entry. A `Snowflake` field annotated at its use site therefore advertises
 * its `description` at `properties.guildId.allOf[0].description`, while an unchecked field
 * advertises it at `properties.withCounts.description`. Clients that render property-level
 * descriptions — which is most of them — then show help for the easy parameter and nothing for the
 * constrained one that actually needed explaining.
 *
 * Merging is semantically neutral: a conjunction of flat keyword sets means the same thing inline.
 * It is skipped whenever a key would collide or a member carries combinator keywords, so nothing
 * is silently reinterpreted.
 */
const hoistAllOf = (node: unknown): unknown => {
  if (Array.isArray(node)) return node.map(hoistAllOf)
  if (node === null || typeof node !== 'object') return node

  const schema = Object.fromEntries(
    Object.entries(node as Record<string, unknown>).map(([k, v]) => [k, hoistAllOf(v)]),
  )

  const members = schema.allOf
  if (!Array.isArray(members) || members.length === 0) return schema

  const merged: Record<string, unknown> = {}
  for (const member of members) {
    if (member === null || typeof member !== 'object' || Array.isArray(member)) return schema
    for (const [key, value] of Object.entries(member as Record<string, unknown>)) {
      if (NON_MERGEABLE.has(key) || key in schema || key in merged) return schema
      merged[key] = value
    }
  }

  const { allOf: _dropped, ...rest } = schema
  return { ...rest, ...merged }
}

/**
 * The JSON Schema MCP will actually advertise for a tool input.
 *
 * Built eagerly by the registry so an unrepresentable schema fails startup rather than at
 * `tools/list`, where a single bad schema breaks discovery for every tool on the server.
 */
export const toMcpInputJsonSchema = (s: McpSchema): Record<string, unknown> =>
  mcpToolInput(s)['~standard'].jsonSchema.input({ target: MCP_JSON_SCHEMA_TARGET }) as Record<
    string,
    unknown
  >

/**
 * What the registry actually hands to `registerTool`.
 *
 * A thin wrapper rather than a mutation: `toStandardJSONSchemaV1` writes onto the schema object
 * itself, so patching in place would change the shared schema for every other consumer. MCP reads
 * nothing but `~standard`, so a structural stand-in is sufficient and side-effect free.
 */
export const mcpToolInput = <S extends McpSchema>(s: S): StandardSchemaWithJSON<S> => {
  const std = McpInput(s)['~standard']
  return {
    '~standard': {
      ...std,
      jsonSchema: {
        input: (options) => hoistAllOf(std.jsonSchema.input(options)),
        output: (options) => hoistAllOf(std.jsonSchema.output(options)),
      },
    },
  } as StandardSchemaWithJSON<S>
}

/** The shape MCP v2's `registerTool` consumes: validation and JSON Schema on one `~standard`. */
export type StandardSchemaWithJSON<S extends McpSchema> = StandardSchemaV1<
  S['Encoded'],
  S['Type']
> &
  StandardJSONSchemaV1<S['Encoded'], S['Type']>
