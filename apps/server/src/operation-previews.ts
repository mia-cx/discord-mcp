import { createHash, randomBytes } from 'node:crypto'
import type {
  CatalogOperation,
  DispatchInput,
  OperationPreviewStore,
} from '@discord-mcp/discord-api'
import { DispatchValidationError } from '@discord-mcp/discord-api'
import type { Database } from '@discord-mcp/persistence'

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value)
      .filter(([key, child]) => key !== 'previewToken' && child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

const digest = (value: unknown): string =>
  createHash('sha256').update(canonical(value)).digest('hex')

const tokenHash = (token: string): string => createHash('sha256').update(token).digest('hex')

export class SqliteOperationPreviews implements OperationPreviewStore {
  constructor(readonly database: Database) {}

  issue(
    principalId: string,
    operation: CatalogOperation,
    input: DispatchInput,
    now = Date.now(),
  ): string {
    const token = randomBytes(32).toString('base64url')
    this.database.run(
      `INSERT INTO preview_tokens
       (token_hash, principal_id, operation_id, arguments_digest, auth_profile, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      tokenHash(token),
      principalId,
      operation.operationId,
      digest(input),
      input.authProfile ?? 'bot',
      new Date(now + 60_000).toISOString(),
    )
    return token
  }

  consume(
    token: string | undefined,
    principalId: string,
    operation: CatalogOperation,
    input: DispatchInput,
    now = Date.now(),
  ): void {
    if (!token) {
      throw new DispatchValidationError('A preview token is required; preview this call first')
    }
    const row = this.database.get<{
      principal_id: string
      operation_id: string
      arguments_digest: string
      auth_profile: string
      expires_at: string
      consumed_at: string | null
    }>('SELECT * FROM preview_tokens WHERE token_hash = ?', tokenHash(token))
    if (
      !row ||
      row.consumed_at !== null ||
      Date.parse(row.expires_at) <= now ||
      row.principal_id !== principalId ||
      row.operation_id !== operation.operationId ||
      row.arguments_digest !== digest(input) ||
      row.auth_profile !== (input.authProfile ?? 'bot')
    ) {
      throw new DispatchValidationError(
        'Preview token is missing, expired, used, or does not match this exact call',
      )
    }
    const consumed = this.database.run(
      `UPDATE preview_tokens SET consumed_at = ?
       WHERE token_hash = ? AND consumed_at IS NULL`,
      new Date(now).toISOString(),
      tokenHash(token),
    )
    if (consumed.changes !== 1) {
      throw new DispatchValidationError('Preview token was already used')
    }
  }
}
