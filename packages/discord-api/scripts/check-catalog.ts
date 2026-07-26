/**
 * `pnpm spec:check` — the CI gates from PLAN.md, run against the committed catalog.
 *
 * These exist because every one of them is a mistake that would otherwise reach an agent as a
 * confusing Discord error rather than a build failure.
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  source as generatedSource,
  packedOperations,
  tokenTable,
} from '../src/catalog/generated/index.ts'
import { type SchemaMap, unpackOperation } from '../src/catalog/types.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '../../..')
const VENDOR = join(ROOT, 'vendor/discord')
const GENERATED = join(HERE, '../src/catalog/generated')

const failures: string[] = []
const fail = (gate: string, detail: string) => failures.push(`${gate}: ${detail}`)

const spec = JSON.parse(readFileSync(join(VENDOR, 'openapi.json'), 'utf8')) as {
  paths: Record<string, Record<string, { operationId?: string } | undefined>>
}
const source = JSON.parse(readFileSync(join(VENDOR, 'source.json'), 'utf8')) as {
  commit: string
  sha256: string
  counts: Record<string, number>
}
const operations = packedOperations.map(unpackOperation)
const byId = new Map(operations.map((o) => [o.operationId, o]))

// --- the pinned SHA must match the vendored file --------------------------------------------
const digest = createHash('sha256')
  .update(readFileSync(join(VENDOR, 'openapi.json')))
  .digest('hex')
if (digest !== source.sha256) {
  fail('pinned digest', `openapi.json hashes to ${digest} but source.json records ${source.sha256}`)
}
if (generatedSource.commit !== source.commit) {
  fail(
    'pinned commit',
    `catalog was generated from ${generatedSource.commit}, vendor pins ${source.commit}`,
  )
}

// --- every vendored operation has exactly one catalog entry ---------------------------------
const vendored = new Set<string>()
for (const path of Object.keys(spec.paths)) {
  for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
    const id = spec.paths[path]?.[method]?.operationId
    if (id !== undefined) vendored.add(id)
  }
}
for (const id of vendored) if (!byId.has(id)) fail('coverage', `${id} has no catalog entry`)
for (const op of operations)
  if (!vendored.has(op.operationId))
    fail('coverage', `${op.operationId} is not in the vendored spec`)
if (operations.length !== source.counts.operations) {
  fail(
    'counts',
    `catalog has ${operations.length} operations, source.json records ${source.counts.operations}`,
  )
}
if (new Set(operations.map((o) => o.operationId)).size !== operations.length) {
  fail('coverage', 'duplicate operation IDs in the catalog')
}

for (const op of operations) {
  // --- risk and auth classification ---------------------------------------------------------
  if (op.risk === undefined) fail('risk', `${op.operationId} has no risk class`)
  if (op.auth.length === 0) {
    fail(
      'auth',
      `${op.operationId} cannot be executed by any supported auth mode. PLAN.md prohibits claiming coverage for it.`,
    )
  }

  // --- the path-item merge invariant --------------------------------------------------------
  for (const match of op.path.matchAll(/\{([^}]+)\}/g)) {
    const name = match[1] as string
    if (!op.pathParams.includes(name)) {
      fail(
        'path-item merge',
        `${op.operationId}: template "${op.path}" declares {${name}} but the entry does not. Operation-level parameters are query-only; 130 of 150 paths carry theirs on the path item.`,
      )
    }
  }
  if (!op.path.startsWith('/'))
    fail('route', `${op.operationId}: path "${op.path}" does not start with /`)

  // --- no sensitive parameter is exposed as an ordinary string ------------------------------
  for (const name of [...op.pathParams, ...op.queryParams]) {
    const sensitive = /token|secret|code$|password/.test(name)
    if (sensitive && !op.sensitiveParams.includes(name)) {
      fail(
        'sensitive parameters',
        `${op.operationId}: "${name}" looks like a credential but is not marked sensitive, so it would be accepted as a plain MCP string.`,
      )
    }
  }

  // --- token indices resolve ----------------------------------------------------------------
  for (const index of op.tokens) {
    if (tokenTable[index] === undefined)
      fail('token table', `${op.operationId}: token index ${index} is out of range`)
  }
}

// --- the five bot-incompatible operations are recorded as such -------------------------------
const OAUTH_ONLY = [
  'get_current_user_application_entitlements',
  'get_application_user_role_connection',
  'update_application_user_role_connection',
  'delete_application_user_role_connection',
  'get_my_guild_member',
]
for (const id of OAUTH_ONLY) {
  const op = byId.get(id)
  if (op === undefined) {
    fail('bot-incompatible', `${id} is missing from the catalog`)
    continue
  }
  if (op.auth.includes('bot')) fail('bot-incompatible', `${id} must not accept a bot token`)
  if (!op.auth.includes('oauth2'))
    fail('bot-incompatible', `${id} must be reachable with an OAuth2 bearer`)
}
const unexpectedlyOauthOnly = operations.filter(
  (o) => !o.auth.includes('bot') && !OAUTH_ONLY.includes(o.operationId),
)
for (const op of unexpectedlyOauthOnly) {
  fail(
    'bot-incompatible',
    `${op.operationId} rejects a bot token but is not in the expected set of five. The pin changed; re-derive the list.`,
  )
}

// --- schema closures resolve ------------------------------------------------------------------
const schemaMap = JSON.parse(readFileSync(join(GENERATED, 'schemas.json'), 'utf8')) as SchemaMap
for (const [operationId, closure] of Object.entries(schemaMap.closures)) {
  for (const name of closure) {
    if (!(name in schemaMap.definitions))
      fail('schema closure', `${operationId} references unknown schema ${name}`)
  }
}

// --- generated output matches committed output ------------------------------------------------
const before = readFileSync(join(GENERATED, 'index.ts'), 'utf8')
const beforeSchemas = readFileSync(join(GENERATED, 'schemas.json'), 'utf8')
execFileSync('node', ['--experimental-strip-types', join(HERE, 'generate-catalog.ts')], {
  stdio: 'ignore',
  cwd: ROOT,
})
if (readFileSync(join(GENERATED, 'index.ts'), 'utf8') !== before) {
  fail(
    'determinism',
    'regenerating index.ts produced different output; commit the regenerated catalog',
  )
}
if (readFileSync(join(GENERATED, 'schemas.json'), 'utf8') !== beforeSchemas) {
  fail(
    'determinism',
    'regenerating schemas.json produced different output; commit the regenerated catalog',
  )
}

if (failures.length > 0) {
  process.stderr.write(
    `spec:check failed with ${failures.length} problem(s):\n${failures.map((f) => `  - ${f}`).join('\n')}\n`,
  )
  process.exit(1)
}
process.stderr.write(
  `spec:check passed: ${operations.length} operations, all classified, path-item merge intact, ${OAUTH_ONLY.length} bot-incompatible operations recorded, output deterministic.\n`,
)
