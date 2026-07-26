import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { PrincipalStore, SecretStore } from '@discord-mcp/auth'
import type { Scope } from '@discord-mcp/core'
import { AuditRepository, Database } from '@discord-mcp/persistence'
import { Effect } from 'effect'

/**
 * CLI commands.
 *
 * The CLI is the only process allowed to read an arbitrary local path, and only one the operator
 * typed. MCP inputs never accept a filesystem path: the transport can be remote and authenticated,
 * so accepting one there would let a remote principal read arbitrary server files.
 *
 * Output goes to stdout here — unlike the server, which owns stdout for JSON-RPC.
 */

export type Services = PrincipalStore | SecretStore | AuditRepository | Database

const write = (line: string) =>
  Effect.sync(() => {
    process.stdout.write(`${line}\n`)
  })

const table = (rows: ReadonlyArray<Record<string, unknown>>) => {
  if (rows.length === 0) return write('(none)')
  const columns = Object.keys(rows[0] as Record<string, unknown>)
  const widths = columns.map((c) =>
    Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length)),
  )
  const line = (cells: ReadonlyArray<string>) =>
    cells.map((cell, i) => cell.padEnd(widths[i] as number)).join('  ')

  return Effect.all([
    write(line(columns)),
    write(line(widths.map((w) => '-'.repeat(w)))),
    ...rows.map((r) => write(line(columns.map((c) => String(r[c] ?? ''))))),
  ]).pipe(Effect.asVoid)
}

// ---------------------------------------------------------------- principals

export const principalCreate = (args: {
  readonly id: string
  readonly name: string
  readonly scopes: ReadonlyArray<string>
}) =>
  Effect.gen(function* () {
    const store = yield* PrincipalStore
    const principal = yield* store.create({
      id: args.id,
      kind: 'pat',
      displayName: args.name,
      scopes: args.scopes as ReadonlyArray<Scope>,
    })
    yield* write(
      `Created principal ${principal.id} with scopes: ${[...principal.scopes].join(', ')}`,
    )
  })

export const principalList = Effect.gen(function* () {
  const store = yield* PrincipalStore
  const principals = yield* store.list()
  yield* table(principals.map((p) => ({ id: p.id, kind: p.kind, scopes: [...p.scopes].join(' ') })))
})

// ---------------------------------------------------------------- tokens

export const tokenCreate = (args: {
  readonly principalId: string
  readonly name: string
  readonly expiryDays?: number
}) =>
  Effect.gen(function* () {
    const store = yield* PrincipalStore
    const created = yield* store.issueToken({
      principalId: args.principalId,
      name: args.name,
      ...(args.expiryDays === undefined ? {} : { expiryDays: args.expiryDays }),
    })

    yield* write('')
    yield* write(created.token)
    yield* write('')
    // The only time this value exists in readable form. Saying so plainly is the difference
    // between an operator copying it and an operator re-issuing tomorrow.
    yield* write(
      `This token is shown once and is not recoverable — only its argon2id hash is stored. Expires ${new Date(created.expiresAt).toISOString()}.`,
    )
  })

export const tokenList = (principalId: string) =>
  Effect.gen(function* () {
    const store = yield* PrincipalStore
    const tokens = yield* store.listTokens(principalId)
    yield* table(
      tokens.map((t) => ({
        id: t.id,
        name: t.name,
        expires: new Date(t.expiresAt).toISOString(),
        revoked: t.revokedAt === null ? '' : new Date(t.revokedAt).toISOString(),
        lastUsed: t.lastUsedAt === null ? 'never' : new Date(t.lastUsedAt).toISOString(),
      })),
    )
  })

export const tokenRevoke = (tokenId: string) =>
  Effect.gen(function* () {
    const store = yield* PrincipalStore
    yield* store.revokeToken(tokenId)
    // No restart needed: authentication reads the table on every call.
    yield* write(`Revoked ${tokenId}. It stops working immediately; no restart is needed.`)
  })

// ---------------------------------------------------------------- secrets

export const secretPut = (args: { readonly name: string; readonly value: string }) =>
  Effect.gen(function* () {
    const store = yield* SecretStore
    yield* store.put(args.name, args.value)
    yield* write(`Stored secret "${args.name}", encrypted with DISCORD_MCP_MASTER_KEY.`)
  })

export const secretList = Effect.gen(function* () {
  const store = yield* SecretStore
  const names = yield* store.list()
  yield* table(names.map((name) => ({ name })))
})

export const secretDelete = (name: string) =>
  Effect.gen(function* () {
    const store = yield* SecretStore
    yield* store.delete(name)
    yield* write(`Deleted secret "${name}".`)
  })

// ---------------------------------------------------------------- blobs

const MAX_BLOB_BYTES = 25 * 1024 * 1024

/**
 * Store a file for later use as a message attachment.
 *
 * This is the only place a filesystem path is read, and it is a path the operator typed on their
 * own machine. An MCP tool accepting one would be a remote arbitrary-file-read.
 */
export const blobPut = (args: { readonly path: string; readonly principalId: string }) =>
  Effect.gen(function* () {
    const bytes = yield* Effect.tryPromise({
      try: () => readFile(args.path),
      catch: (cause) => new Error(`Could not read ${args.path}: ${String(cause)}`),
    })

    if (bytes.length > MAX_BLOB_BYTES) {
      return yield* Effect.fail(
        new Error(
          `${args.path} is ${Math.round(bytes.length / 1024 / 1024)} MiB; the limit is ${MAX_BLOB_BYTES / 1024 / 1024} MiB.`,
        ),
      )
    }

    const { createHash, randomUUID } = yield* Effect.promise(() => import('node:crypto'))
    const digest = createHash('sha256').update(bytes).digest('hex')
    const id = randomUUID()
    const db = yield* Database
    const at = yield* Effect.clockWith((c) => c.currentTimeMillis)

    yield* db.execute(
      `INSERT INTO stored_blobs (id, digest, filename, content_type, size_bytes, owner_principal_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        digest,
        basename(args.path),
        'application/octet-stream',
        bytes.length,
        args.principalId,
        at,
      ],
    )

    yield* write(
      `Stored ${basename(args.path)} as blob ${id} (${bytes.length} bytes, sha256 ${digest.slice(0, 16)}…).`,
    )
    yield* write(
      `Reference it in a presentation as { "kind": "blob", "blobId": "${id}", "filename": "${basename(args.path)}" }.`,
    )
  })

// ---------------------------------------------------------------- diagnostics

export const migrate = Effect.gen(function* () {
  // Constructing the Database layer runs migrations; reaching here means they succeeded.
  const db = yield* Database
  const rows = yield* db.query<{ id: number; name: string }>(
    'SELECT id, name FROM schema_migrations ORDER BY id',
  )
  yield* write(`${rows.length} migration(s) applied.`)
  yield* table(rows.map((r) => ({ id: r.id, name: r.name })))
})

export const auditTail = (limit: number) =>
  Effect.gen(function* () {
    const audit = yield* AuditRepository
    const entries = yield* audit.list({ limit })
    yield* table(
      entries.map((e) => ({
        at: new Date(Number(e.at)).toISOString(),
        principal: String(e.principal_id ?? ''),
        action: String(e.action),
        outcome: String(e.outcome),
        subject: String(e.subject_id ?? ''),
      })),
    )
  })
