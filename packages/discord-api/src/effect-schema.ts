import { DiscordToolResultSchema, JsonValueSchema } from '@discord-mcp/core'
import { Schema } from 'effect'
import type { CatalogOperation, CatalogParameter } from './catalog.js'
import schemasJson from './generated/schemas.json' with { type: 'json' }

type JsonSchema = Readonly<Record<string, unknown>>

const componentSchemas = schemasJson as Readonly<Record<string, JsonSchema>>

const asSchema = (value: unknown): JsonSchema =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as JsonSchema) : {}

const asSchemas = (value: unknown): ReadonlyArray<JsonSchema> =>
  Array.isArray(value) ? value.map(asSchema) : []

const literalSchema = (value: unknown): Schema.Top => {
  if (value === null) return Schema.Null
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return Schema.Literal(value)
  }
  return JsonValueSchema
}

const componentName = (reference: unknown): string | undefined =>
  typeof reference === 'string' ? /^#\/components\/schemas\/(.+)$/.exec(reference)?.[1] : undefined

const withDescription = (schema: Schema.Top, source: JsonSchema): Schema.Top =>
  typeof source.description === 'string'
    ? schema.pipe(Schema.annotate({ description: source.description }))
    : schema

const constrainedString = (source: JsonSchema): Schema.Top => {
  let output = Schema.String
  if (typeof source.minLength === 'number') {
    output = output.pipe(Schema.check(Schema.isMinLength(source.minLength)))
  }
  if (typeof source.maxLength === 'number') {
    output = output.pipe(Schema.check(Schema.isMaxLength(source.maxLength)))
  }
  if (typeof source.pattern === 'string') {
    output = output.pipe(Schema.check(Schema.isPattern(new RegExp(source.pattern))))
  }
  return output
}

const constrainedNumber = (source: JsonSchema, integer: boolean): Schema.Top => {
  let output = Schema.Number
  if (typeof source.minimum === 'number') {
    output = output.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(source.minimum)))
  }
  if (typeof source.maximum === 'number') {
    output = output.pipe(Schema.check(Schema.isLessThanOrEqualTo(source.maximum)))
  }
  return integer ? output.pipe(Schema.check(Schema.isInt())) : output
}

const arraySchema = (item: Schema.Top, source: JsonSchema): Schema.Top => {
  let output = Schema.Array(item)
  if (typeof source.minItems === 'number') {
    output = output.pipe(Schema.check(Schema.isMinLength(source.minItems)))
  }
  if (typeof source.maxItems === 'number') {
    output = output.pipe(Schema.check(Schema.isMaxLength(source.maxItems)))
  }
  return output
}

const mergeAllOfObjects = (
  members: ReadonlyArray<JsonSchema>,
  seen = new Set<string>(),
): JsonSchema | undefined => {
  const properties: Record<string, unknown> = {}
  const required = new Set<string>()
  for (const member of members) {
    const reference = componentName(member.$ref)
    if (reference) {
      if (seen.has(reference)) return undefined
      const target = componentSchemas[reference]
      if (!target) return undefined
      const nested = mergeAllOfObjects([target], new Set([...seen, reference]))
      if (!nested) return undefined
      Object.assign(properties, asSchema(nested.properties))
      for (const key of Array.isArray(nested.required) ? nested.required : []) {
        if (typeof key === 'string') required.add(key)
      }
      continue
    }
    if (Array.isArray(member.allOf)) {
      const nested = mergeAllOfObjects(asSchemas(member.allOf), seen)
      if (!nested) return undefined
      Object.assign(properties, asSchema(nested.properties))
      for (const key of Array.isArray(nested.required) ? nested.required : []) {
        if (typeof key === 'string') required.add(key)
      }
      continue
    }
    if (member.type !== 'object' && member.properties === undefined) return undefined
    Object.assign(properties, asSchema(member.properties))
    for (const key of Array.isArray(member.required) ? member.required : []) {
      if (typeof key === 'string') required.add(key)
    }
  }
  return { type: 'object', properties, required: [...required] }
}

export interface EffectSchemaOptions {
  readonly omitObjectKeys?: ReadonlySet<string>
}

export const effectSchemaFromJson = (
  source: JsonSchema,
  options: EffectSchemaOptions = {},
  cache = new Map<string, Schema.Top>(),
): Schema.Top => {
  const reference = componentName(source.$ref)
  if (reference) {
    const cached = cache.get(reference)
    if (cached) return cached
    let resolved: Schema.Top = JsonValueSchema
    const suspended = Schema.suspend(() => resolved)
    cache.set(reference, suspended)
    resolved = effectSchemaFromJson(componentSchemas[reference] ?? {}, options, cache)
    return suspended
  }
  if (source.const !== undefined) return withDescription(literalSchema(source.const), source)
  if (Array.isArray(source.enum) && source.enum.length > 0) {
    return withDescription(Schema.Union(source.enum.map(literalSchema)), source)
  }
  const alternatives = asSchemas(source.oneOf ?? source.anyOf)
  if (alternatives.length > 0) {
    return withDescription(
      Schema.Union(alternatives.map((member) => effectSchemaFromJson(member, options, cache))),
      source,
    )
  }
  if (Array.isArray(source.allOf)) {
    const members = asSchemas(source.allOf)
    const merged = mergeAllOfObjects(members)
    if (merged) return effectSchemaFromJson(merged, options, cache)
    if (members.length > 0) return effectSchemaFromJson(members[0] ?? {}, options, cache)
  }
  if (Array.isArray(source.type)) {
    return withDescription(
      Schema.Union(
        source.type.map((type) =>
          effectSchemaFromJson({ ...source, type, description: undefined }, options, cache),
        ),
      ),
      source,
    )
  }
  let output: Schema.Top
  switch (source.type) {
    case 'null':
      output = Schema.Null
      break
    case 'boolean':
      output = Schema.Boolean
      break
    case 'integer':
      output = constrainedNumber(source, true)
      break
    case 'number':
      output = constrainedNumber(source, false)
      break
    case 'array':
      output = arraySchema(effectSchemaFromJson(asSchema(source.items), options, cache), source)
      break
    default: {
      if (source.type !== 'object' && source.properties === undefined) {
        output = JsonValueSchema
        break
      }
      const required = new Set(
        (Array.isArray(source.required) ? source.required : []).filter(
          (value): value is string => typeof value === 'string',
        ),
      )
      const fields: Record<string, Schema.Top> = {}
      for (const [key, child] of Object.entries(asSchema(source.properties))) {
        if (options.omitObjectKeys?.has(key)) continue
        const childSchema = effectSchemaFromJson(asSchema(child), {}, cache)
        fields[key] = required.has(key) ? childSchema : Schema.optionalKey(childSchema)
      }
      const struct = Schema.Struct(fields)
      output =
        source.additionalProperties === undefined || source.additionalProperties === false
          ? struct
          : Schema.StructWithRest(struct, [
              Schema.Record(
                Schema.String,
                source.additionalProperties === true
                  ? JsonValueSchema
                  : effectSchemaFromJson(asSchema(source.additionalProperties), {}, cache),
              ),
            ])
      break
    }
  }
  if (source.type === 'string' || source.type === undefined) {
    if (source.type === 'string') output = constrainedString(source)
  }
  return withDescription(output, source)
}

const fieldsForParameters = (
  parameters: ReadonlyArray<CatalogParameter>,
): Schema.Struct<Record<string, Schema.Top>> | undefined => {
  if (parameters.length === 0) return undefined
  const fields: Record<string, Schema.Top> = {}
  for (const parameter of parameters) {
    const schema = effectSchemaFromJson(parameter.schema)
    fields[parameter.name] = parameter.required ? schema : Schema.optionalKey(schema)
  }
  return Schema.Struct(fields)
}

const preferredRequestSchema = (operation: CatalogOperation): JsonSchema | undefined => {
  for (const contentType of [
    'application/json',
    'application/x-www-form-urlencoded',
    'multipart/form-data',
  ]) {
    const schema = operation.body[contentType]
    if (schema) return schema
  }
  return undefined
}

const preferredResponseSchema = (operation: CatalogOperation): JsonSchema | undefined => {
  for (const [status, content] of Object.entries(operation.responseBodies)) {
    if (!/^2\d\d$/.test(status)) continue
    const schema = content['application/json']
    if (schema) return schema
  }
  return undefined
}

const Files = Schema.Array(
  Schema.Struct({
    blobId: Schema.String,
    filename: Schema.optionalKey(Schema.String),
    contentType: Schema.optionalKey(Schema.String),
  }),
).pipe(Schema.check(Schema.isMaxLength(10)))

export const curatedOperationInputSchema = (
  operation: CatalogOperation,
): Schema.Struct<Record<string, Schema.Top>> => {
  const fields: Record<string, Schema.Top> = {
    authProfile: Schema.optionalKey(Schema.String),
    authMode: Schema.optionalKey(Schema.Union(operation.auth.map(literalSchema))),
    previewOnly: Schema.optionalKey(Schema.Boolean),
  }
  const pathParameters = operation.parameters.filter(
    (parameter) => parameter.in === 'path' && !parameter.sensitive,
  )
  const queryParameters = operation.parameters.filter((parameter) => parameter.in === 'query')
  const path = fieldsForParameters(pathParameters)
  const query = fieldsForParameters(queryParameters)
  if (path) {
    fields.path = pathParameters.some((parameter) => parameter.required)
      ? path
      : Schema.optionalKey(path)
  }
  if (query) {
    fields.query = queryParameters.some((parameter) => parameter.required)
      ? query
      : Schema.optionalKey(query)
  }
  const request = preferredRequestSchema(operation)
  if (request) {
    const sensitiveKeys = new Set(
      operation.sensitiveBodyFields.map((field) => field.slice('body.'.length)),
    )
    const body = effectSchemaFromJson(request, { omitObjectKeys: sensitiveKeys })
    fields.body = operation.bodyRequired ? body : Schema.optionalKey(body)
  }
  const sensitive = [
    ...operation.parameters
      .filter((parameter) => parameter.in === 'path' && parameter.sensitive)
      .map((parameter) => ({ name: parameter.name, required: parameter.required })),
    ...operation.sensitiveBodyFields.map((name) => ({ name, required: false })),
  ]
  if (sensitive.length > 0) {
    const secretFields: Record<string, Schema.Top> = {}
    for (const field of sensitive) {
      secretFields[field.name] = field.required ? Schema.String : Schema.optionalKey(Schema.String)
    }
    const secrets = Schema.Struct(secretFields)
    fields.secretRefs = sensitive.some((field) => field.required)
      ? secrets
      : Schema.optionalKey(secrets)
  }
  if (operation.auditLogReason) fields.auditLogReason = Schema.optionalKey(Schema.String)
  if (operation.risk === 'destructive' || operation.risk === 'bot_admin') {
    fields.previewToken = Schema.optionalKey(Schema.String)
  }
  if (operation.body['multipart/form-data']) fields.files = Schema.optionalKey(Files)
  return Schema.Struct(fields)
}

const Preview = Schema.Struct({
  operation: JsonValueSchema,
  normalized: JsonValueSchema,
  previewToken: Schema.optionalKey(Schema.String),
  expiresInMs: Schema.optionalKey(Schema.Number),
})

export const curatedOperationDataSchema = (operation: CatalogOperation): Schema.Top => {
  const response = preferredResponseSchema(operation)
  return response
    ? Schema.Union([effectSchemaFromJson(response), Preview])
    : Schema.Union([Schema.Null, Preview])
}

export const curatedOperationOutputSchema = (operation: CatalogOperation): Schema.Top =>
  DiscordToolResultSchema(
    curatedOperationDataSchema(operation) as unknown as Schema.ConstraintDecoder<unknown, never>,
  )
