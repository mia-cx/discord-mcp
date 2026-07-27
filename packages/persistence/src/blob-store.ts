import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Schema } from 'effect'
import type { Database } from './database.js'

export interface BlobMetadata {
  readonly id: string
  readonly ownerPrincipalId: string
  readonly filename: string
  readonly mimeType: string
  readonly sizeBytes: number
  readonly referenceCount: number
  readonly createdAt: string
}

export class BlobError extends Schema.TaggedErrorClass<BlobError>()('BlobError', {
  message: Schema.String,
}) {
  constructor(message: string) {
    super({ message })
  }
}

const allowedMime =
  /^(?:image\/(?:png|jpeg|gif|webp)|text\/plain|application\/(?:pdf|json|zip|octet-stream))$/

const safeFilename = (value: string): string => {
  const filename = value
    .normalize('NFKC')
    .replaceAll(/[^A-Za-z0-9._-]/g, '_')
    .replaceAll(/^\.+/g, '')
    .slice(0, 100)
  if (filename.length === 0) throw new BlobError('filename must contain safe characters')
  return filename
}

export class BlobStore {
  constructor(
    readonly database: Database,
    readonly root: string,
    readonly maxBlobBytes = 25 * 1024 * 1024,
    readonly ownerQuotaBytes = 250 * 1024 * 1024,
  ) {}

  async putInline(input: {
    readonly ownerPrincipalId: string
    readonly filename: string
    readonly mimeType: string
    readonly base64: string
  }): Promise<BlobMetadata> {
    let bytes: Buffer
    try {
      bytes = Buffer.from(input.base64, 'base64')
      if (bytes.toString('base64').replaceAll('=', '') !== input.base64.replaceAll('=', '')) {
        throw new Error('non-canonical base64')
      }
    } catch {
      throw new BlobError('blob data must be canonical base64')
    }
    return this.putBytes({ ...input, bytes })
  }

  async putFile(input: {
    readonly ownerPrincipalId: string
    readonly filename: string
    readonly mimeType: string
    readonly path: string
  }): Promise<BlobMetadata> {
    return this.putBytes({ ...input, bytes: await readFile(input.path) })
  }

  async putBytes(input: {
    readonly ownerPrincipalId: string
    readonly filename: string
    readonly mimeType: string
    readonly bytes: Uint8Array
  }): Promise<BlobMetadata> {
    if (!allowedMime.test(input.mimeType))
      throw new BlobError(`unsupported MIME type: ${input.mimeType}`)
    if (input.bytes.byteLength === 0 || input.bytes.byteLength > this.maxBlobBytes) {
      throw new BlobError(`blob must contain 1–${this.maxBlobBytes} bytes`)
    }
    const used =
      this.database.get<{ total: number | null }>(
        'SELECT SUM(size_bytes) AS total FROM stored_blobs WHERE owner_principal_id = ?',
        input.ownerPrincipalId,
      )?.total ?? 0
    if (used + input.bytes.byteLength > this.ownerQuotaBytes) {
      throw new BlobError('principal blob quota exceeded')
    }
    const id = createHash('sha256').update(input.bytes).digest('hex')
    const existing = this.database.get<{
      id: string
      owner_principal_id: string
      filename: string
      mime_type: string
      size_bytes: number
      reference_count: number
      created_at: string
    }>('SELECT * FROM stored_blobs WHERE id = ?', id)
    if (existing) {
      if (existing.owner_principal_id !== input.ownerPrincipalId) {
        throw new BlobError('blob digest already belongs to another principal')
      }
      return rowMetadata(existing)
    }
    const directory = join(this.root, id.slice(0, 2))
    const storagePath = join(directory, id)
    await mkdir(directory, { recursive: true })
    try {
      await writeFile(storagePath, input.bytes, { flag: 'wx', mode: 0o600 })
    } catch (cause) {
      try {
        await access(storagePath, constants.F_OK)
      } catch {
        throw cause
      }
    }
    const createdAt = new Date().toISOString()
    const deleteAfter = new Date(Date.now() + 7 * 86_400_000).toISOString()
    this.database.run(
      `INSERT INTO stored_blobs
       (id, owner_principal_id, filename, mime_type, size_bytes, storage_path, created_at,
        delete_after)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.ownerPrincipalId,
      safeFilename(input.filename),
      input.mimeType,
      input.bytes.byteLength,
      storagePath,
      createdAt,
      deleteAfter,
    )
    return {
      id,
      ownerPrincipalId: input.ownerPrincipalId,
      filename: safeFilename(input.filename),
      mimeType: input.mimeType,
      sizeBytes: input.bytes.byteLength,
      referenceCount: 0,
      createdAt,
    }
  }

  getMetadata(id: string, principalId: string, administrator = false): BlobMetadata {
    const row = this.database.get<{
      id: string
      owner_principal_id: string
      filename: string
      mime_type: string
      size_bytes: number
      reference_count: number
      created_at: string
    }>('SELECT * FROM stored_blobs WHERE id = ?', id)
    if (!row) throw new BlobError(`blob ${id} does not exist`)
    if (!administrator && row.owner_principal_id !== principalId) {
      throw new BlobError('blob belongs to another principal')
    }
    return rowMetadata(row)
  }

  async delete(id: string, principalId: string, administrator = false): Promise<void> {
    const metadata = this.getMetadata(id, principalId, administrator)
    if (metadata.referenceCount > 0) throw new BlobError('referenced blob cannot be deleted')
    const row = this.database.get<{ storage_path: string }>(
      'SELECT storage_path FROM stored_blobs WHERE id = ?',
      id,
    )
    if (!row) throw new BlobError(`blob ${id} does not exist`)
    this.database.transaction(() => {
      this.database.run('DELETE FROM stored_blobs WHERE id = ?', id)
    })
    await rm(row.storage_path, { force: true })
  }

  /** Internal-only content lookup; MCP tools deliberately expose metadata, never bytes. */
  async readForDiscord(id: string): Promise<Buffer> {
    const row = this.database.get<{ storage_path: string }>(
      'SELECT storage_path FROM stored_blobs WHERE id = ?',
      id,
    )
    if (!row) throw new BlobError(`blob ${id} does not exist`)
    return readFile(row.storage_path)
  }
}

const rowMetadata = (row: {
  readonly id: string
  readonly owner_principal_id: string
  readonly filename: string
  readonly mime_type: string
  readonly size_bytes: number
  readonly reference_count: number
  readonly created_at: string
}): BlobMetadata => ({
  id: row.id,
  ownerPrincipalId: row.owner_principal_id,
  filename: row.filename,
  mimeType: row.mime_type,
  sizeBytes: row.size_bytes,
  referenceCount: row.reference_count,
  createdAt: row.created_at,
})
