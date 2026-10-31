import { Context, Effect, Layer, Schema } from 'effect'
import { packedOperations, source, tokenTable } from './generated/index.ts'
import {
  type AuthMode,
  type HttpMethod,
  type OperationEntry,
  type OperationFamily,
  type RiskClass,
  type SchemaMap,
  unpackOperation,
} from './types.ts'

/** No cataloged operation has this ID. `suggestion` tells a model what to do instead of guessing. */
export class OperationNotFoundError extends Schema.TaggedErrorClass<OperationNotFoundError>()(
  'OperationNotFoundError',
  {
    operationId: Schema.String,
    suggestion: Schema.String,
  },
) {}

export interface SearchQuery {
  readonly query?: string
  readonly method?: HttpMethod
  readonly family?: OperationFamily
  readonly auth?: AuthMode
  readonly risk?: RiskClass
  readonly limit: number
  readonly cursor?: string
}

export interface SearchHit {
  readonly operation: OperationEntry
  readonly score: number
}

/**
 * Score an operation against a query.
 *
 * An exact operation-id match always wins, because an agent that already knows the id is asking to
 * confirm it, not to browse. That check runs against the *raw* query, not the tokenised one:
 * operation IDs contain underscores, so `"get_guild"` tokenises to `['get','guild']` and would
 * otherwise lose to `get_guild_widget`, which matches both terms and carries more tokens.
 *
 * Everything else is token overlap, so `"kick someone"` reaches `delete_guild_member` through the
 * gloss rather than through string similarity, which would never make that jump.
 */
const scoreOperation = (
  op: OperationEntry,
  raw: string,
  terms: ReadonlyArray<string>,
  tokens: Set<string>,
): number => {
  const id = op.operationId.toLowerCase()
  if (raw !== '' && id === raw) return 1000
  if (terms.length === 0) return 1

  let score = 0
  const path = op.path.toLowerCase()

  for (const term of terms) {
    if (id.includes(term)) score += 10
    if (path.includes(term)) score += 4
    if (tokens.has(term)) score += 3
    else if ([...tokens].some((t) => t.startsWith(term) || term.startsWith(t))) score += 1
  }
  // Shorter IDs matching the same terms are the more direct answer: a query for "guild" means
  // get_guild before get_guild_widget_settings.
  score -= Math.min(id.length / 20, 4)
  // A curated tool is a better answer than a raw operation whenever both match.
  return score > 0 && op.curatedTool !== undefined ? score + 2 : score
}

export class OperationCatalog extends Context.Service<
  OperationCatalog,
  {
    readonly all: ReadonlyArray<OperationEntry>
    readonly get: (operationId: string) => Effect.Effect<OperationEntry, OperationNotFoundError>
    readonly search: (q: SearchQuery) => { hits: ReadonlyArray<SearchHit>; nextCursor?: string }
    /** Loads and memoizes the ~400 KiB schema map on first use. */
    readonly schemas: Effect.Effect<SchemaMap>
    /** A self-contained JSON Schema for one operation's body, with a scoped `$defs` closure. */
    readonly bodySchema: (
      operationId: string,
    ) => Effect.Effect<Record<string, unknown> | undefined, OperationNotFoundError>
    readonly source: typeof source
  }
>()('discord-api/OperationCatalog') {
  static readonly layer = Layer.effect(OperationCatalog)(
    Effect.gen(function* () {
      const all = packedOperations.map(unpackOperation)
      const byId = new Map(all.map((o) => [o.operationId, o]))
      const tokensOf = new Map(
        all.map((o) => [o.operationId, new Set(o.tokens.map((i) => tokenTable[i] as string))]),
      )

      const get = (operationId: string) => {
        const found = byId.get(operationId)
        return found === undefined
          ? Effect.fail(
              new OperationNotFoundError({
                operationId,
                suggestion:
                  'Do not guess another ID. Call discord_api_search with words describing what you want; it searches a maintained gloss, so plain language works.',
              }),
            )
          : Effect.succeed(found)
      }

      const search = (q: SearchQuery) => {
        const raw = (q.query ?? '').trim().toLowerCase()
        const terms = raw.split(/[^a-z0-9]+/).filter((t) => t.length > 1)

        const scored: SearchHit[] = []
        for (const op of all) {
          if (q.method !== undefined && op.method !== q.method) continue
          if (q.family !== undefined && op.family !== q.family) continue
          if (q.risk !== undefined && op.risk !== q.risk) continue
          if (q.auth !== undefined && !op.auth.includes(q.auth)) continue

          const score = scoreOperation(op, raw, terms, tokensOf.get(op.operationId) ?? new Set())
          if (score > 0) scored.push({ operation: op, score })
        }

        // Ties break on operation ID so paging is stable across calls.
        scored.sort(
          (a, b) =>
            b.score - a.score || a.operation.operationId.localeCompare(b.operation.operationId),
        )

        const start = q.cursor === undefined ? 0 : Number.parseInt(q.cursor, 10) || 0
        const page = scored.slice(start, start + q.limit)
        const next = start + q.limit
        return {
          hits: page,
          ...(next < scored.length ? { nextCursor: String(next) } : {}),
        }
      }

      // Memoized so the 400 KiB map is parsed at most once, and only if something asks for it.
      const schemas = yield* Effect.cached(
        Effect.promise(async () => {
          const { schemaMap } = await import('./generated/schemas.ts')
          return schemaMap
        }),
      )

      const bodySchema = (operationId: string) =>
        Effect.gen(function* () {
          const op = yield* get(operationId)
          if (op.requestBody === undefined) return undefined

          const map = yield* schemas
          const inline = map.details[operationId]?.bodySchema
          const name = op.requestBody.schemaName
          if (name === undefined && inline === undefined) return undefined
          const closure = map.closures[operationId] ?? []
          const defs: Record<string, unknown> = {}
          for (const ref of closure) defs[ref] = map.definitions[ref]

          // A `$ref` to the root plus its scoped closure, rather than an inlined tree: Discord's
          // schemas are recursive, so inlining would not terminate.
          return name === undefined
            ? { ...inline, $defs: defs }
            : { $ref: `#/$defs/${name}`, $defs: defs }
        })

      return { all, get, search, schemas, bodySchema, source }
    }),
  )
}
