/**
 * `pnpm spec:drift` — fetch upstream read-only and report what changed since the pin.
 *
 * It never writes to `vendor/`. Re-pinning is a deliberate act with a lockfile change and a full
 * test run behind it, not something a drift check does on your behalf.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const VENDOR = join(HERE, '../../../vendor/discord')
const UPSTREAM =
  'https://raw.githubusercontent.com/discord/discord-api-spec/main/specs/openapi.json'

interface Spec {
  paths: Record<string, Record<string, { operationId?: string } | undefined>>
  components: { schemas: Record<string, unknown> }
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const

const operationsOf = (spec: Spec) => {
  const out = new Map<string, string>()
  for (const path of Object.keys(spec.paths)) {
    for (const method of METHODS) {
      const id = spec.paths[path]?.[method]?.operationId
      if (id !== undefined) out.set(id, `${method.toUpperCase()} ${path}`)
    }
  }
  return out
}

const main = async () => {
  const pinned = JSON.parse(readFileSync(join(VENDOR, 'openapi.json'), 'utf8')) as Spec
  const source = JSON.parse(readFileSync(join(VENDOR, 'source.json'), 'utf8')) as { commit: string }

  const response = await fetch(UPSTREAM)
  if (!response.ok) {
    process.stderr.write(`Could not fetch upstream spec: HTTP ${response.status}\n`)
    process.exit(1)
  }
  const latest = (await response.json()) as Spec

  const before = operationsOf(pinned)
  const after = operationsOf(latest)

  const added = [...after.keys()].filter((id) => !before.has(id)).sort()
  const removed = [...before.keys()].filter((id) => !after.has(id)).sort()
  const moved = [...after.entries()]
    .filter(([id, route]) => before.has(id) && before.get(id) !== route)
    .sort()

  const beforeSchemas = new Set(Object.keys(pinned.components.schemas))
  const afterSchemas = new Set(Object.keys(latest.components.schemas))
  const schemasAdded = [...afterSchemas].filter((n) => !beforeSchemas.has(n)).sort()
  const schemasRemoved = [...beforeSchemas].filter((n) => !afterSchemas.has(n)).sort()
  const schemasChanged = [...afterSchemas]
    .filter(
      (n) =>
        beforeSchemas.has(n) &&
        JSON.stringify(pinned.components.schemas[n]) !==
          JSON.stringify(latest.components.schemas[n]),
    )
    .sort()

  const lines = [
    `pinned at ${source.commit}`,
    `operations: ${before.size} pinned, ${after.size} upstream`,
    '',
    ...(added.length === 0
      ? []
      : [`added (${added.length}):`, ...added.map((id) => `  + ${id}  ${after.get(id)}`)]),
    ...(removed.length === 0
      ? []
      : [
          `removed (${removed.length}) — these would break curated tools:`,
          ...removed.map((id) => `  - ${id}  ${before.get(id)}`),
        ]),
    ...(moved.length === 0
      ? []
      : [
          `moved (${moved.length}):`,
          ...moved.map(([id, route]) => `  ~ ${id}  ${before.get(id)} -> ${route}`),
        ]),
    ...(schemasAdded.length === 0 ? [] : [`schemas added: ${schemasAdded.length}`]),
    ...(schemasRemoved.length === 0 ? [] : [`schemas removed: ${schemasRemoved.join(', ')}`]),
    ...(schemasChanged.length === 0
      ? []
      : [
          `schemas changed (${schemasChanged.length}): ${schemasChanged.slice(0, 20).join(', ')}${schemasChanged.length > 20 ? ', …' : ''}`,
        ]),
  ]

  const clean =
    added.length === 0 &&
    removed.length === 0 &&
    moved.length === 0 &&
    schemasAdded.length === 0 &&
    schemasRemoved.length === 0 &&
    schemasChanged.length === 0

  process.stderr.write(
    `${lines.join('\n')}\n\n${clean ? 'No drift.' : 'Drift detected. Re-pin deliberately: update the commit and digest in source.json, run spec:generate, and run the full suite.'}\n`,
  )
}

await main()
