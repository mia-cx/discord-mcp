/**
 * `pnpm spec:generate` — distil the vendored OpenAPI document into the catalog, deterministically.
 *
 * Determinism is a CI check, not a nicety: `spec:check` regenerates and diffs, so any
 * nondeterminism here becomes a permanently failing build. Everything is sorted; nothing depends
 * on object insertion order, time, or the filesystem.
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  AuthMode,
  CatalogIndex,
  HttpMethod,
  OperationDetail,
  OperationEntry,
  PackedOperation,
  SchemaMap,
} from '../src/types.ts'
import {
  authModes,
  classifyFamily,
  classifyPagination,
  classifyRisk,
  hasGloss,
  isSensitiveParam,
  searchTokens,
  sensitiveParams,
  supportsAuditLogReason,
} from './classify.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '../../..')
const VENDOR = join(ROOT, 'vendor/discord')
const OUT = join(HERE, '../src/generated')

const METHODS: ReadonlyArray<HttpMethod> = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']

interface Spec {
  info: { version: string }
  paths: Record<string, Record<string, unknown> & { parameters?: ReadonlyArray<RawParameter> }>
  components: { schemas: Record<string, unknown> }
}

interface RawParameter {
  name: string
  in: 'path' | 'query' | 'header' | 'cookie'
  required?: boolean
  description?: string
  schema?: unknown
}

interface RawOperation {
  operationId: string
  description?: string
  parameters?: ReadonlyArray<RawParameter>
  security?: ReadonlyArray<Record<string, unknown>>
  requestBody?: {
    required?: boolean
    content: Record<string, { schema?: { $ref?: string } & Record<string, unknown> }>
  }
  responses?: Record<string, { content?: Record<string, { schema?: { $ref?: string } }> }>
}

interface Override {
  readonly reason: string
  readonly risk?: OperationEntry['risk']
  readonly family?: OperationEntry['family']
  readonly auth?: ReadonlyArray<AuthMode>
  readonly curatedTool?: string
  readonly sensitiveParams?: ReadonlyArray<string>
}

const refName = (ref: string | undefined): string | undefined =>
  ref?.startsWith('#/components/schemas/') ? ref.slice('#/components/schemas/'.length) : undefined

/** Collect every `$ref` target reachable from a node, following the graph without inlining it. */
const collectRefs = (node: unknown, into: Set<string>): void => {
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, into)
    return
  }
  if (node === null || typeof node !== 'object') return

  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === '$ref' && typeof value === 'string') {
      const name = refName(value)
      if (name !== undefined) into.add(name)
      continue
    }
    collectRefs(value, into)
  }
}

/**
 * Transitive closure of the schemas an operation needs.
 *
 * Bounded by the visited set, which is what makes it terminate on Discord's recursive schemas
 * (`Channel.parent`, `Message.referenced_message`, the component tree).
 */
const closureOf = (roots: ReadonlyArray<string>, schemas: Record<string, unknown>): string[] => {
  const seen = new Set<string>()
  const queue = [...roots]

  while (queue.length > 0) {
    const name = queue.pop()
    if (name === undefined || seen.has(name)) continue
    seen.add(name)

    const direct = new Set<string>()
    collectRefs(schemas[name], direct)
    for (const next of direct) if (!seen.has(next)) queue.push(next)
  }
  return [...seen].sort()
}

/** Request fields holding a permission bitfield, which Discord sends and accepts as a string. */
const BITFIELD_FIELDS = new Set(['allow', 'deny', 'permissions', 'default_member_permissions'])

/**
 * Rewrite `#/components/schemas/X` to `#/$defs/X` so the map is a self-contained JSON Schema, and
 * correct two spec errors that would reject valid bodies: an empty `enum`, which no validator
 * compiles, and permission bitfields typed only as integers.
 */
const rewriteRefs = (node: unknown, field?: string): unknown => {
  if (Array.isArray(node)) return node.map((item) => rewriteRefs(item))
  if (node === null || typeof node !== 'object') return node

  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === 'enum' && Array.isArray(value) && value.length === 0) continue
    out[key] =
      key === '$ref' && typeof value === 'string' && value.startsWith('#/components/schemas/')
        ? `#/$defs/${value.slice('#/components/schemas/'.length)}`
        : key === 'properties' && value !== null && typeof value === 'object'
          ? Object.fromEntries(
              Object.entries(value).map(([name, schema]) => [name, rewriteRefs(schema, name)]),
            )
          : rewriteRefs(value)
  }
  const types = [out.type].flat()
  if (BITFIELD_FIELDS.has(field ?? '') && types.includes('integer') && !types.includes('string')) {
    out.type = [...types, 'string']
    out.pattern = '^[0-9]+$'
  }
  return out
}

/**
 * Merge a path item's parameters with its operation's.
 *
 * 130 of 150 paths carry their path parameters on the path item, and operation-level parameters
 * are query-only. Reading `op.parameters` alone yields zero path parameters for those.
 */
const mergeParameters = (
  inherited: ReadonlyArray<RawParameter>,
  op: RawOperation,
  path: string,
  method: HttpMethod,
) => {
  const merged = [...inherited, ...(op.parameters ?? [])]
  const pathParams = [...new Set(merged.filter((p) => p.in === 'path').map((p) => p.name))].sort()
  const query = merged.filter((p) => p.in === 'query')

  // Every {param} in the template must be present, or a dispatch would build a URL with a literal
  // brace in it and Discord would answer 404 for a reason nobody could see.
  const missing = [...path.matchAll(/\{([^}]+)\}/g)]
    .map((m) => m[1] as string)
    .filter((t) => !pathParams.includes(t))
  if (missing.length > 0) {
    throw new Error(
      `${op.operationId} (${method} ${path}): path template declares {${missing.join('}, {')}} but the merged parameters do not define ${missing.length === 1 ? 'it' : 'them'}. This is the path-item merge bug.`,
    )
  }

  return {
    merged,
    pathParams,
    queryParams: [...new Set(query.map((p) => p.name))].sort(),
    requiredQuery: [...new Set(query.filter((p) => p.required === true).map((p) => p.name))].sort(),
  }
}

/** Schema references an operation's request body and success response point at. */
const schemaRefs = (op: RawOperation) => {
  const bodyContent = op.requestBody?.content ?? {}
  const contentTypes = Object.keys(bodyContent).sort()
  const bodyRef = contentTypes
    .map((ct) => refName(bodyContent[ct]?.schema?.$ref))
    .find((n): n is string => n !== undefined)
  // A JSON body declared inline rather than by reference still has a schema to validate against.
  const jsonBody = bodyContent['application/json']?.schema
  const inlineBody = bodyRef === undefined && jsonBody?.$ref === undefined ? jsonBody : undefined

  const okResponse =
    op.responses?.['200'] ?? op.responses?.['201'] ?? op.responses?.['204'] ?? undefined

  return {
    contentTypes,
    bodyRef,
    inlineBody,
    responseRef: refName(Object.values(okResponse?.content ?? {})[0]?.schema?.$ref),
  }
}

/** Prose and parameter schemas, which live in the lazy tier rather than the static index. */
const detailOf = (
  op: RawOperation,
  merged: ReadonlyArray<RawParameter>,
  inlineBody: Record<string, unknown> | undefined,
): OperationDetail | undefined => {
  const querySchemas: Record<string, unknown> = {}
  const paramDescriptions: Record<string, string> = {}
  for (const p of merged) {
    if (p.in === 'query' && p.schema !== undefined) querySchemas[p.name] = p.schema
    if (p.description !== undefined) paramDescriptions[p.name] = p.description
  }
  const empty =
    op.description === undefined &&
    inlineBody === undefined &&
    Object.keys(querySchemas).length === 0 &&
    Object.keys(paramDescriptions).length === 0

  return empty
    ? undefined
    : {
        ...(op.description === undefined ? {} : { description: op.description }),
        ...(inlineBody === undefined
          ? {}
          : { bodySchema: rewriteRefs(inlineBody) as Record<string, unknown> }),
        querySchemas,
        paramDescriptions,
      }
}

const writeOutput = (
  index: CatalogIndex,
  schemaMap: SchemaMap,
  operations: ReadonlyArray<OperationEntry>,
) => {
  const packed: PackedOperation[] = operations.map((o) => [
    o.operationId,
    o.method,
    o.path,
    o.pathParams,
    o.queryParams,
    o.requiredQuery,
    o.requestBody ?? 0,
    o.responseSchemaName ?? 0,
    o.auth,
    o.oauthScopes,
    o.risk,
    o.family,
    o.pagination,
    o.auditLogReason ? 1 : 0,
    o.sensitiveParams,
    o.tokens,
    o.curatedTool ?? 0,
    o.override ?? 0,
  ])

  writeFileSync(
    join(OUT, 'index.ts'),
    [
      '// GENERATED by pnpm spec:generate. Do not edit.',
      `// Source: discord/discord-api-spec@${index.source.commit}`,
      '//',
      '// Operations are positional tuples; see PackedOperation in ../types.ts for the field order.',
      "import type { PackedOperation } from '../types.ts'",
      '',
      `export const tokenTable: ReadonlyArray<string> = ${JSON.stringify(index.tokenTable)}`,
      '',
      `export const source = ${JSON.stringify(index.source)} as const`,
      '',
      `export const packedOperations: ReadonlyArray<PackedOperation> = ${JSON.stringify(packed)}`,
      '',
    ].join('\n'),
  )
  // A module rather than a `.json` file, so every runtime and bundler loads it without a
  // filesystem or import attributes. `JSON.parse` over one string literal parses faster than an
  // object literal and keeps the type checker off 400 KiB of nested schema.
  writeFileSync(
    join(OUT, 'schemas.ts'),
    [
      '// GENERATED by pnpm spec:generate. Do not edit.',
      `// Source: discord/discord-api-spec@${index.source.commit}`,
      "import type { SchemaMap } from '../types.ts'",
      '',
      `export const schemaMap: SchemaMap = JSON.parse(${JSON.stringify(JSON.stringify(schemaMap))})`,
      '',
    ].join('\n'),
  )
}

/**
 * Gates that must hold for the committed catalog to be trustworthy.
 *
 * Enforced at generation as well as in `spec:check`, so a bad catalog cannot be committed in the
 * first place.
 */
const assertInvariants = (operations: ReadonlyArray<OperationEntry>) => {
  for (const op of operations) {
    const exposed = [...op.pathParams, ...op.queryParams].filter(
      (n) => isSensitiveParam(n) && !op.sensitiveParams.includes(n),
    )
    if (exposed.length > 0) {
      throw new Error(
        `${op.operationId} would expose sensitive parameter(s) ${exposed.join(', ')} as ordinary strings. They must resolve through secret references.`,
      )
    }
  }
}

const report = (
  operations: ReadonlyArray<OperationEntry>,
  spec: Spec,
  definitionCount: number,
  warnings: ReadonlyArray<string>,
) => {
  process.stderr.write(
    [
      `operations:        ${operations.length}`,
      `paths:             ${Object.keys(spec.paths).length}`,
      `component schemas: ${definitionCount}`,
      `static index:      ${Math.round(readFileSync(join(OUT, 'index.ts')).length / 1024)} KiB`,
      `lazy schema map:   ${Math.round(readFileSync(join(OUT, 'schemas.ts')).length / 1024)} KiB`,
      '',
      ...(warnings.length === 0
        ? ['no search-quality warnings']
        : [`${warnings.length} search-quality warnings:`, ...warnings.map((w) => `  ${w}`)]),
      '',
    ].join('\n'),
  )
}

interface BuildContext {
  readonly spec: Spec
  readonly overrides: Record<string, Override>
  readonly closures: Record<string, ReadonlyArray<string>>
  readonly details: Record<string, OperationDetail>
  readonly warnings: string[]
  readonly internToken: (token: string) => number
}

/** Build one catalog entry, recording its schema closure, detail, and any search-quality warning. */
const buildOperation = (
  op: RawOperation,
  method: HttpMethod,
  path: string,
  inherited: ReadonlyArray<RawParameter>,
  ctx: BuildContext,
): OperationEntry => {
  const { merged, pathParams, queryParams, requiredQuery } = mergeParameters(
    inherited,
    op,
    path,
    method,
  )
  const { contentTypes, bodyRef, inlineBody, responseRef } = schemaRefs(op)

  const detail = detailOf(op, merged, inlineBody)
  if (detail !== undefined) ctx.details[op.operationId] = detail

  const inlineRefs = new Set<string>()
  collectRefs(inlineBody, inlineRefs)
  const roots = [bodyRef, responseRef, ...inlineRefs].filter((n): n is string => n !== undefined)
  if (roots.length > 0) ctx.closures[op.operationId] = closureOf(roots, ctx.spec.components.schemas)

  const override = ctx.overrides[op.operationId]
  const derived = authModes(op.security)
  const auth = override?.auth ?? derived.auth

  if (auth.length === 0) {
    throw new Error(
      `${op.operationId} has no executable auth mode. PLAN.md prohibits claiming coverage for an operation no configured auth profile can execute; add an override with a reason or exclude it.`,
    )
  }
  if (!hasGloss(op.operationId) && override?.curatedTool === undefined) {
    ctx.warnings.push(
      `${op.operationId}: no gloss entry and no curated tool — natural-language search will not find it.`,
    )
  }

  return {
    operationId: op.operationId,
    method,
    path,
    pathParams,
    queryParams,
    requiredQuery,
    ...(op.requestBody === undefined
      ? {}
      : {
          requestBody: {
            required: op.requestBody.required ?? false,
            contentTypes,
            ...(bodyRef === undefined ? {} : { schemaName: bodyRef }),
            multipart: contentTypes.includes('multipart/form-data'),
          },
        }),
    ...(responseRef === undefined ? {} : { responseSchemaName: responseRef }),
    auth,
    oauthScopes: derived.oauthScopes,
    risk: override?.risk ?? classifyRisk(op.operationId, method, path),
    family: override?.family ?? classifyFamily(path),
    pagination: classifyPagination(queryParams),
    auditLogReason: supportsAuditLogReason(method, path),
    sensitiveParams: override?.sensitiveParams ?? sensitiveParams([...pathParams, ...queryParams]),
    ...(override === undefined
      ? {}
      : {
          override: {
            fields: Object.keys(override)
              .filter((k) => k !== 'reason')
              .sort(),
            reason: override.reason,
          },
        }),
    tokens: searchTokens(op.operationId, method, path).map(ctx.internToken),
    ...(override?.curatedTool === undefined ? {} : { curatedTool: override.curatedTool }),
  }
}

const main = () => {
  const raw = readFileSync(join(VENDOR, 'openapi.json'))
  const spec = JSON.parse(raw.toString('utf8')) as Spec
  const source = JSON.parse(readFileSync(join(VENDOR, 'source.json'), 'utf8')) as {
    commit: string
    sha256: string
    counts: Record<string, number>
  }

  const digest = createHash('sha256').update(raw).digest('hex')
  if (digest !== source.sha256) {
    throw new Error(
      `vendor/discord/openapi.json does not match the digest recorded in source.json.\n  recorded: ${source.sha256}\n  actual:   ${digest}\nThe vendored spec was edited by hand or replaced without re-pinning. Run spec:drift.`,
    )
  }

  const overrides = JSON.parse(readFileSync(join(VENDOR, 'overrides.json'), 'utf8')) as Record<
    string,
    Override
  >

  // Interned token table: 3117 instances over 243 distinct strings.
  const tokenIds = new Map<string, number>()
  const internToken = (token: string): number => {
    const existing = tokenIds.get(token)
    if (existing !== undefined) return existing
    const id = tokenIds.size
    tokenIds.set(token, id)
    return id
  }

  const operations: OperationEntry[] = []
  const warnings: string[] = []
  const closures: Record<string, ReadonlyArray<string>> = {}
  const details: Record<string, OperationDetail> = {}

  const ctx: BuildContext = { spec, overrides, closures, details, warnings, internToken }

  for (const path of Object.keys(spec.paths).sort()) {
    const pathItem = spec.paths[path]
    if (pathItem === undefined) continue

    for (const method of METHODS) {
      const op = pathItem[method.toLowerCase()] as RawOperation | undefined
      if (op === undefined) continue
      operations.push(buildOperation(op, method, path, pathItem.parameters ?? [], ctx))
    }
  }

  operations.sort((a, b) => a.operationId.localeCompare(b.operationId))
  assertInvariants(operations)

  const definitions: Record<string, unknown> = {}
  for (const name of Object.keys(spec.components.schemas).sort()) {
    definitions[name] = rewriteRefs(spec.components.schemas[name])
  }

  writeOutput(
    {
      tokenTable: [...tokenIds.keys()],
      source: {
        commit: source.commit,
        sha256: source.sha256,
        apiVersion: spec.info.version,
        counts: source.counts,
      },
      operations,
    },
    {
      definitions,
      closures: Object.fromEntries(Object.entries(closures).sort(([a], [b]) => a.localeCompare(b))),
      details: Object.fromEntries(Object.entries(details).sort(([a], [b]) => a.localeCompare(b))),
    },
    operations,
  )

  report(operations, spec, Object.keys(definitions).length, warnings)
}

main()
