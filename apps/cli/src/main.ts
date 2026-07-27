#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
import process from 'node:process'
import { PersonalAccessTokens, type Scope, scopes, TokenEncryption } from '@discord-mcp/auth'
import { BlobStore, Database } from '@discord-mcp/persistence'
import { Schema } from 'effect'

class CliError extends Schema.TaggedErrorClass<CliError>()('CliError', {
  message: Schema.String,
}) {
  constructor(message: string) {
    super({ message })
  }
}

const usage = `discord-mcp commands:
  migrate
  diagnostics
  principal create <name> [scope,scope,...]
  principal list
  auth token create <principal-id> <name> [days]
  auth token list [principal-id]
  auth token revoke <token-id>
  blob put <principal-id> <path> <mime-type> [filename]
  blob metadata <principal-id> <blob-id>
  blob delete <principal-id> <blob-id>
  secret set <principal-id> <name>        # reads the value from stdin
  secret list <principal-id>
  secret delete <principal-id> <secret-id>

Environment: DATABASE_PATH (default data/discord-mcp.sqlite), DISCORD_MCP_BLOB_DIR
`

const required = (args: ReadonlyArray<string>, index: number, name: string): string => {
  const value = args[index]
  if (!value) throw new CliError(`missing ${name}\n\n${usage}`)
  return value
}

const print = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

const readStdin = async (): Promise<string> => {
  const chunks: Array<Buffer> = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
    .toString('utf8')
    .replace(/\r?\n$/, '')
}

export const runCli = async (
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> => {
  const database = new Database(environment.DATABASE_PATH ?? 'data/discord-mcp.sqlite')
  try {
    database.migrate()
    const audit = (input: {
      readonly principalId?: string
      readonly action: string
      readonly targetType: string
      readonly targetId?: string
      readonly detail?: unknown
    }): void => {
      database.run(
        `INSERT INTO audit_log
         (id, principal_id, action, target_type, target_id, request_id,
          detail_json, outcome, created_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?, 'success', ?)`,
        randomUUID(),
        input.principalId ?? null,
        input.action,
        input.targetType,
        input.targetId ?? null,
        JSON.stringify(input.detail ?? {}),
        new Date().toISOString(),
      )
    }
    const command = args.join(' ')
    if (args.length === 0 || args[0] === 'help' || args[0] === '--help') {
      process.stdout.write(usage)
      return
    }
    if (command === 'migrate') {
      print({ ok: true, database: database.filename })
      return
    }
    if (command === 'diagnostics') {
      const migrationRows = database.all<{ version: number; name: string; applied_at: string }>(
        'SELECT version, name, applied_at FROM schema_migrations ORDER BY version',
      )
      print({
        ok: true,
        node: process.version,
        database: database.filename,
        migrations: migrationRows,
        principalCount:
          database.get<{ count: number }>('SELECT COUNT(*) AS count FROM principals')?.count ?? 0,
      })
      return
    }
    if (args[0] === 'principal' && args[1] === 'create') {
      const name = required(args, 2, 'principal name')
      const requested = (args[3] ?? '')
        .split(',')
        .filter(Boolean)
        .map((value) => value.trim())
      const invalid = requested.filter((value) => !scopes.includes(value as Scope))
      if (invalid.length > 0) throw new CliError(`unknown scopes: ${invalid.join(', ')}`)
      const id = randomUUID()
      const now = new Date().toISOString()
      database.transaction(() => {
        database.run(
          "INSERT INTO principals(id, name, kind, created_at) VALUES (?, ?, 'pat', ?)",
          id,
          name,
          now,
        )
        for (const scope of requested) {
          database.run(
            'INSERT INTO principal_scope_bindings(principal_id, scope) VALUES (?, ?)',
            id,
            scope,
          )
        }
      })
      audit({
        principalId: id,
        action: 'principal.create',
        targetType: 'principal',
        targetId: id,
        detail: { scopes: requested },
      })
      print({ id, name, scopes: requested, createdAt: now })
      return
    }
    if (command === 'principal list') {
      print(
        database.all<{
          id: string
          name: string
          kind: string
          disabled_at: string | null
          created_at: string
        }>('SELECT id, name, kind, disabled_at, created_at FROM principals ORDER BY created_at'),
      )
      return
    }
    const tokens = new PersonalAccessTokens(database)
    if (args[0] === 'auth' && args[1] === 'token' && args[2] === 'create') {
      const principalId = required(args, 3, 'principal id')
      const name = required(args, 4, 'token name')
      const days = args[5] === undefined ? undefined : Number(args[5])
      const result = await tokens.create({
        principalId,
        name,
        ...(days === undefined ? {} : { expiresInDays: days }),
      })
      audit({
        principalId,
        action: 'auth.token.create',
        targetType: 'personal_access_token',
        targetId: result.metadata.id,
      })
      print({ ...result, warning: 'Store the token now; it cannot be displayed again.' })
      return
    }
    if (args[0] === 'auth' && args[1] === 'token' && args[2] === 'list') {
      print(tokens.list(args[3]))
      return
    }
    if (args[0] === 'auth' && args[1] === 'token' && args[2] === 'revoke') {
      const tokenId = required(args, 3, 'token id')
      const principalId = database.get<{ principal_id: string }>(
        'SELECT principal_id FROM personal_access_tokens WHERE id = ?',
        tokenId,
      )?.principal_id
      tokens.revoke(tokenId)
      audit({
        ...(principalId === undefined ? {} : { principalId }),
        action: 'auth.token.revoke',
        targetType: 'personal_access_token',
        targetId: tokenId,
      })
      print({ ok: true })
      return
    }
    const blobs = new BlobStore(
      database,
      environment.DISCORD_MCP_BLOB_DIR ?? 'data/blobs',
      Number(environment.DISCORD_MCP_MAX_BLOB_BYTES ?? 25 * 1024 * 1024),
      Number(environment.DISCORD_MCP_BLOB_QUOTA_BYTES ?? 250 * 1024 * 1024),
    )
    if (args[0] === 'blob' && args[1] === 'put') {
      const ownerPrincipalId = required(args, 2, 'principal id')
      const path = required(args, 3, 'path')
      const mimeType = required(args, 4, 'MIME type')
      const filename = args[5] ?? path.split(/[\\/]/).at(-1) ?? 'blob'
      const metadata = await blobs.putFile({ ownerPrincipalId, path, mimeType, filename })
      audit({
        principalId: ownerPrincipalId,
        action: 'blob.create',
        targetType: 'blob',
        targetId: metadata.id,
      })
      print(metadata)
      return
    }
    if (args[0] === 'blob' && args[1] === 'metadata') {
      print(blobs.getMetadata(required(args, 3, 'blob id'), required(args, 2, 'principal id')))
      return
    }
    if (args[0] === 'blob' && args[1] === 'delete') {
      const ownerPrincipalId = required(args, 2, 'principal id')
      const blobId = required(args, 3, 'blob id')
      await blobs.delete(blobId, ownerPrincipalId)
      audit({
        principalId: ownerPrincipalId,
        action: 'blob.delete',
        targetType: 'blob',
        targetId: blobId,
      })
      print({ ok: true })
      return
    }
    if (args[0] === 'secret') {
      const masterKey = environment.DISCORD_MCP_MASTER_KEY
      if (!masterKey) throw new CliError('DISCORD_MCP_MASTER_KEY is required for secret commands')
      const encryption = new TokenEncryption(masterKey)
      const principalId = required(args, 2, 'principal id')
      if (args[1] === 'set') {
        const name = required(args, 3, 'secret name')
        const value = await readStdin()
        if (value.length === 0) throw new CliError('secret value on stdin is empty')
        const existing = database.get<{ id: string }>(
          'SELECT id FROM encrypted_secrets WHERE owner_principal_id = ? AND name = ?',
          principalId,
          name,
        )
        const id = existing?.id ?? randomUUID()
        database.run(
          `INSERT INTO encrypted_secrets
           (id, owner_principal_id, name, ciphertext, created_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(owner_principal_id, name) DO UPDATE SET ciphertext = excluded.ciphertext`,
          id,
          principalId,
          name,
          encryption.encrypt(value, `secret:${id}`),
          new Date().toISOString(),
        )
        audit({
          principalId,
          action: 'secret.set',
          targetType: 'encrypted_secret',
          targetId: id,
        })
        print({ id, name, stored: true })
        return
      }
      if (args[1] === 'list') {
        print(
          database.all(
            `SELECT id, name, created_at FROM encrypted_secrets
             WHERE owner_principal_id = ? ORDER BY name`,
            principalId,
          ),
        )
        return
      }
      if (args[1] === 'delete') {
        const secretId = required(args, 3, 'secret id')
        const result = database.run(
          'DELETE FROM encrypted_secrets WHERE owner_principal_id = ? AND id = ?',
          principalId,
          secretId,
        )
        if (result.changes !== 1) throw new CliError('secret does not exist')
        audit({
          principalId,
          action: 'secret.delete',
          targetType: 'encrypted_secret',
          targetId: secretId,
        })
        print({ deleted: true })
        return
      }
    }
    throw new CliError(`unknown command\n\n${usage}`)
  } finally {
    database.close()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void runCli(process.argv.slice(2)).catch((cause: unknown) => {
    process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`)
    process.exitCode = 1
  })
}
