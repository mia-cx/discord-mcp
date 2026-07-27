import { createHash, randomUUID } from 'node:crypto'
import { Schema } from 'effect'
import type { Database } from './database.js'

export type VersionedDocumentKind = 'message-template' | 'server-blueprint'

export interface VersionedDocumentMetadata {
  readonly id: string
  readonly ownerPrincipalId: string
  readonly name: string
  readonly latestRevision?: number
  readonly archived: boolean
  readonly createdAt: string
  readonly updatedAt: string
}

export interface PublishedDocument {
  readonly id: string
  readonly revision: number
  readonly digest: string
  readonly document: unknown
  readonly publishedBy: string
  readonly publishedAt: string
}

export class VersionedDocumentError extends Schema.TaggedErrorClass<VersionedDocumentError>()(
  'VersionedDocumentError',
  { message: Schema.String },
) {
  constructor(message: string) {
    super({ message })
  }
}

const tableNames = (kind: VersionedDocumentKind) =>
  kind === 'message-template'
    ? {
        documents: 'message_templates',
        revisions: 'message_template_revisions',
        foreignKey: 'template_id',
      }
    : {
        documents: 'server_blueprints',
        revisions: 'server_blueprint_revisions',
        foreignKey: 'blueprint_id',
      }

export class VersionedDocumentStore {
  constructor(
    readonly database: Database,
    readonly kind: VersionedDocumentKind,
  ) {}

  create(input: {
    readonly ownerPrincipalId: string
    readonly name: string
    readonly document: unknown
    readonly guildId?: string
  }): VersionedDocumentMetadata {
    const tables = tableNames(this.kind)
    const id = randomUUID()
    const now = new Date().toISOString()
    const document =
      this.kind === 'server-blueprint'
        ? {
            ...(input.document as Record<string, unknown>),
            id,
            revision: 1,
            guildId: input.guildId,
          }
        : input.document
    if (this.kind === 'server-blueprint') {
      if (!input.guildId || !/^\d{17,21}$/.test(input.guildId)) {
        throw new VersionedDocumentError('server blueprint guildId must be a Discord snowflake')
      }
      this.database.run(
        `INSERT INTO ${tables.documents}
         (id, owner_principal_id, name, guild_id, draft_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        id,
        input.ownerPrincipalId,
        input.name,
        input.guildId,
        JSON.stringify(document),
        now,
        now,
      )
    } else {
      this.database.run(
        `INSERT INTO ${tables.documents}
         (id, owner_principal_id, name, draft_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        id,
        input.ownerPrincipalId,
        input.name,
        JSON.stringify(document),
        now,
        now,
      )
    }
    return this.getMetadata(id, input.ownerPrincipalId)
  }

  list(ownerPrincipalId: string): ReadonlyArray<VersionedDocumentMetadata> {
    const { documents } = tableNames(this.kind)
    return this.database
      .all<DocumentRow>(
        `SELECT id, owner_principal_id, name, latest_revision, archived_at, created_at, updated_at
         FROM ${documents} WHERE owner_principal_id = ? ORDER BY updated_at DESC`,
        ownerPrincipalId,
      )
      .map(mapMetadata)
  }

  getMetadata(id: string, ownerPrincipalId: string): VersionedDocumentMetadata {
    const { documents } = tableNames(this.kind)
    const row = this.database.get<DocumentRow>(
      `SELECT id, owner_principal_id, name, latest_revision, archived_at, created_at, updated_at
       FROM ${documents} WHERE id = ? AND owner_principal_id = ?`,
      id,
      ownerPrincipalId,
    )
    if (!row) throw new VersionedDocumentError(`${this.kind} ${id} does not exist`)
    return mapMetadata(row)
  }

  getDraft(id: string, ownerPrincipalId: string): unknown {
    const { documents } = tableNames(this.kind)
    const row = this.database.get<{ draft_json: string }>(
      `SELECT draft_json FROM ${documents}
       WHERE id = ? AND owner_principal_id = ? AND archived_at IS NULL`,
      id,
      ownerPrincipalId,
    )
    if (!row) throw new VersionedDocumentError(`${this.kind} ${id} has no editable draft`)
    return JSON.parse(row.draft_json)
  }

  updateDraft(id: string, ownerPrincipalId: string, document: unknown): void {
    const { documents } = tableNames(this.kind)
    const normalized =
      this.kind === 'server-blueprint'
        ? (() => {
            const row = this.database.get<{
              guild_id: string
              latest_revision: number | null
            }>(
              `SELECT guild_id, latest_revision FROM ${documents}
               WHERE id = ? AND owner_principal_id = ?`,
              id,
              ownerPrincipalId,
            )
            if (!row) throw new VersionedDocumentError(`${this.kind} draft is unavailable`)
            return {
              ...(document as Record<string, unknown>),
              id,
              revision: (row.latest_revision ?? 0) + 1,
              guildId: row.guild_id,
            }
          })()
        : document
    const result = this.database.run(
      `UPDATE ${documents} SET draft_json = ?, updated_at = ?
       WHERE id = ? AND owner_principal_id = ? AND archived_at IS NULL`,
      JSON.stringify(normalized),
      new Date().toISOString(),
      id,
      ownerPrincipalId,
    )
    if (result.changes !== 1) throw new VersionedDocumentError(`${this.kind} draft is unavailable`)
  }

  publish(id: string, ownerPrincipalId: string): PublishedDocument {
    const tables = tableNames(this.kind)
    const document = this.getDraft(id, ownerPrincipalId)
    const encoded = JSON.stringify(document)
    const digest = createHash('sha256').update(encoded).digest('hex')
    const existing = this.database.get<{
      revision: number
      digest: string
      document_json: string
      published_by: string
      published_at: string
    }>(
      `SELECT revision, digest, document_json, published_by, published_at
       FROM ${tables.revisions} WHERE ${tables.foreignKey} = ? AND digest = ?`,
      id,
      digest,
    )
    if (existing) {
      return {
        id,
        revision: existing.revision,
        digest: existing.digest,
        document: JSON.parse(existing.document_json),
        publishedBy: existing.published_by,
        publishedAt: existing.published_at,
      }
    }
    const latest =
      this.database.get<{ latest_revision: number | null }>(
        `SELECT latest_revision FROM ${tables.documents} WHERE id = ?`,
        id,
      )?.latest_revision ?? 0
    const revision = latest + 1
    const publishedAt = new Date().toISOString()
    const blobReferences =
      this.kind === 'message-template' ? collectBlobReferences(document) : new Set<string>()
    this.database.transaction(() => {
      for (const blobId of blobReferences) {
        const retained = this.database.run(
          `UPDATE stored_blobs SET reference_count = reference_count + 1, delete_after = NULL
           WHERE id = ? AND owner_principal_id = ?`,
          blobId,
          ownerPrincipalId,
        )
        if (retained.changes !== 1) {
          throw new VersionedDocumentError(`template references missing or foreign blob ${blobId}`)
        }
      }
      this.database.run(
        `INSERT INTO ${tables.revisions}
         (${tables.foreignKey}, revision, digest, document_json, published_by, published_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        id,
        revision,
        digest,
        encoded,
        ownerPrincipalId,
        publishedAt,
      )
      this.database.run(
        `UPDATE ${tables.documents} SET latest_revision = ?, updated_at = ? WHERE id = ?`,
        revision,
        publishedAt,
        id,
      )
    })
    return { id, revision, digest, document, publishedBy: ownerPrincipalId, publishedAt }
  }

  getPublished(id: string, revision?: number, ownerPrincipalId?: string): PublishedDocument {
    const tables = tableNames(this.kind)
    const selectedRevision =
      revision ??
      this.database.get<{ latest_revision: number | null }>(
        `SELECT latest_revision FROM ${tables.documents} WHERE id = ?
         ${ownerPrincipalId === undefined ? '' : 'AND owner_principal_id = ?'}`,
        id,
        ...(ownerPrincipalId === undefined ? [] : [ownerPrincipalId]),
      )?.latest_revision
    if (!selectedRevision)
      throw new VersionedDocumentError(`${this.kind} has no published revision`)
    const row = this.database.get<{
      revision: number
      digest: string
      document_json: string
      published_by: string
      published_at: string
    }>(
      `SELECT r.revision, r.digest, r.document_json, r.published_by, r.published_at
       FROM ${tables.revisions} r
       JOIN ${tables.documents} d ON d.id = r.${tables.foreignKey}
       WHERE r.${tables.foreignKey} = ? AND r.revision = ?
       ${ownerPrincipalId === undefined ? '' : 'AND d.owner_principal_id = ?'}`,
      id,
      selectedRevision,
      ...(ownerPrincipalId === undefined ? [] : [ownerPrincipalId]),
    )
    if (!row) throw new VersionedDocumentError(`${this.kind} revision does not exist`)
    return {
      id,
      revision: row.revision,
      digest: row.digest,
      document: JSON.parse(row.document_json),
      publishedBy: row.published_by,
      publishedAt: row.published_at,
    }
  }

  archive(id: string, ownerPrincipalId: string): void {
    const { documents } = tableNames(this.kind)
    const result = this.database.run(
      `UPDATE ${documents} SET archived_at = ?, updated_at = ?
       WHERE id = ? AND owner_principal_id = ? AND archived_at IS NULL`,
      new Date().toISOString(),
      new Date().toISOString(),
      id,
      ownerPrincipalId,
    )
    if (result.changes !== 1) throw new VersionedDocumentError(`${this.kind} is unavailable`)
  }
}

interface DocumentRow {
  readonly [key: string]: unknown
  readonly id: string
  readonly owner_principal_id: string
  readonly name: string
  readonly latest_revision: number | null
  readonly archived_at: string | null
  readonly created_at: string
  readonly updated_at: string
}

const mapMetadata = (row: DocumentRow): VersionedDocumentMetadata => ({
  id: row.id,
  ownerPrincipalId: row.owner_principal_id,
  name: row.name,
  ...(row.latest_revision === null ? {} : { latestRevision: row.latest_revision }),
  archived: row.archived_at !== null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

const collectBlobReferences = (value: unknown, output = new Set<string>()): ReadonlySet<string> => {
  if (Array.isArray(value)) {
    for (const child of value) collectBlobReferences(child, output)
  } else if (typeof value === 'object' && value !== null) {
    const record = value as Readonly<Record<string, unknown>>
    if (
      record.source === 'blob' &&
      typeof record.blobId === 'string' &&
      /^[a-f0-9]{64}$/.test(record.blobId)
    ) {
      output.add(record.blobId)
    }
    for (const child of Object.values(record)) collectBlobReferences(child, output)
  }
  return output
}
