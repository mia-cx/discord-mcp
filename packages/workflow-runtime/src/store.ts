import { createHash, randomUUID } from 'node:crypto'
import { operationCatalog } from '@discord-mcp/discord-api'
import type { Database } from '@discord-mcp/persistence'
import { Schema } from 'effect'
import ipaddr from 'ipaddr.js'
import {
  assertGrantCoversRequested,
  validateCompiledManifest,
  type WorkflowBuilder,
  type WorkflowGrant,
} from './types.js'

export class WorkflowError extends Schema.TaggedErrorClass<WorkflowError>()('WorkflowError', {
  message: Schema.String,
}) {
  constructor(message: string) {
    super({ message })
  }
}

export class WorkflowBuildError extends Schema.TaggedErrorClass<WorkflowBuildError>()(
  'WorkflowBuildError',
  {
    message: Schema.String,
    workflowId: Schema.String,
    revision: Schema.Number,
    retryable: Schema.Boolean,
  },
) {
  constructor(
    message: string,
    readonly workflowId: string,
    readonly revision: number,
    retryable = false,
  ) {
    super({ message, workflowId, revision, retryable })
  }
}

const digest = (source: string, dependencies: Readonly<Record<string, string>>): string =>
  createHash('sha256')
    .update(source)
    .update('\0')
    .update(JSON.stringify(dependencies))
    .digest('hex')

export class WorkflowStore {
  constructor(
    readonly database: Database,
    readonly builder: WorkflowBuilder,
  ) {}

  create(input: {
    readonly ownerPrincipalId: string
    readonly slug: string
    readonly name: string
    readonly source: string
    readonly dependencies?: Readonly<Record<string, string>>
  }): { readonly id: string; readonly revision: number } {
    validateSource(input.source, input.dependencies ?? {})
    if (!/^[a-z][a-z0-9-]{0,62}$/.test(input.slug)) throw new WorkflowError('invalid workflow slug')
    const id = randomUUID()
    const now = new Date().toISOString()
    const dependencies = input.dependencies ?? {}
    this.database.transaction(() => {
      this.database.run(
        `INSERT INTO workflows
         (id, owner_principal_id, slug, name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        id,
        input.ownerPrincipalId,
        input.slug,
        input.name,
        now,
        now,
      )
      this.database.run(
        `INSERT INTO workflow_revisions
         (workflow_id, revision, source, dependencies_json, source_digest,
          requested_grants_json, status, diagnostics_json, created_by, created_at)
         VALUES (?, 1, ?, ?, ?, '{}', 'draft', '[]', ?, ?)`,
        id,
        input.source,
        JSON.stringify(dependencies),
        digest(input.source, dependencies),
        input.ownerPrincipalId,
        now,
      )
    })
    return { id, revision: 1 }
  }

  list(ownerPrincipalId?: string): ReadonlyArray<Readonly<Record<string, unknown>>> {
    return ownerPrincipalId
      ? this.database.all(
          `SELECT id, owner_principal_id, slug, name, enabled_revision, deleted_at,
           created_at, updated_at FROM workflows WHERE owner_principal_id = ?
           ORDER BY updated_at DESC`,
          ownerPrincipalId,
        )
      : this.database.all(
          `SELECT id, owner_principal_id, slug, name, enabled_revision, deleted_at,
           created_at, updated_at FROM workflows ORDER BY updated_at DESC`,
        )
  }

  get(workflowId: string): Readonly<Record<string, unknown>> {
    const workflow = this.database.get(
      `SELECT id, owner_principal_id, slug, name, enabled_revision, deleted_at,
       created_at, updated_at FROM workflows WHERE id = ?`,
      workflowId,
    )
    if (!workflow) throw new WorkflowError(`workflow ${workflowId} does not exist`)
    return {
      ...workflow,
      revisions: this.database.all(
        `SELECT revision, source_digest, artifact_digest, status, diagnostics_json,
         created_by, created_at FROM workflow_revisions
         WHERE workflow_id = ? ORDER BY revision DESC`,
        workflowId,
      ),
    }
  }

  createDraft(input: {
    readonly workflowId: string
    readonly principalId: string
    readonly source: string
    readonly dependencies?: Readonly<Record<string, string>>
  }): number {
    const dependencies = input.dependencies ?? {}
    validateSource(input.source, dependencies)
    return this.database.transaction(() => {
      const workflow = this.database.get(
        'SELECT id FROM workflows WHERE id = ? AND deleted_at IS NULL',
        input.workflowId,
      )
      if (!workflow) throw new WorkflowError(`workflow ${input.workflowId} does not exist`)
      const existingDraft = this.database.get(
        `SELECT revision FROM workflow_revisions
         WHERE workflow_id = ? AND status IN ('draft', 'failed', 'building')`,
        input.workflowId,
      )
      if (existingDraft) {
        throw new WorkflowError('workflow already has a mutable or in-progress draft revision')
      }
      const revision =
        (this.database.get<{ revision: number | null }>(
          'SELECT MAX(revision) AS revision FROM workflow_revisions WHERE workflow_id = ?',
          input.workflowId,
        )?.revision ?? 0) + 1
      this.database.run(
        `INSERT INTO workflow_revisions
         (workflow_id, revision, source, dependencies_json, source_digest,
          requested_grants_json, status, diagnostics_json, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, '{}', 'draft', '[]', ?, ?)`,
        input.workflowId,
        revision,
        input.source,
        JSON.stringify(dependencies),
        digest(input.source, dependencies),
        input.principalId,
        new Date().toISOString(),
      )
      return revision
    })
  }

  updateDraft(input: {
    readonly workflowId: string
    readonly revision: number
    readonly source: string
    readonly dependencies: Readonly<Record<string, string>>
  }): void {
    validateSource(input.source, input.dependencies)
    const result = this.database.run(
      `UPDATE workflow_revisions SET source = ?, dependencies_json = ?,
       source_digest = ?, artifact_digest = NULL, lockfile = NULL,
       manifest_json = NULL, status = 'draft', diagnostics_json = '[]'
       WHERE workflow_id = ? AND revision = ? AND status IN ('draft', 'failed')`,
      input.source,
      JSON.stringify(input.dependencies),
      digest(input.source, input.dependencies),
      input.workflowId,
      input.revision,
    )
    if (result.changes !== 1) throw new WorkflowError('only a draft revision can be updated')
  }

  async validate(
    workflowId: string,
    revision: number,
    allowNpmInstallScripts = false,
  ): Promise<void> {
    const row = this.database.get<{
      source: string
      dependencies_json: string
      source_digest: string
      status: string
    }>(
      'SELECT source, dependencies_json, source_digest, status FROM workflow_revisions WHERE workflow_id = ? AND revision = ?',
      workflowId,
      revision,
    )
    if (!row || !['draft', 'failed'].includes(row.status)) {
      throw new WorkflowBuildError('workflow revision is not buildable', workflowId, revision)
    }
    this.database.run(
      "UPDATE workflow_revisions SET status = 'building' WHERE workflow_id = ? AND revision = ?",
      workflowId,
      revision,
    )
    try {
      const result = await this.builder.build({
        workflowId,
        revision,
        source: row.source,
        dependencies: JSON.parse(row.dependencies_json) as Record<string, string>,
        allowNpmInstallScripts,
      })
      if (result.diagnostics.some(({ severity }) => severity === 'error')) {
        throw new WorkflowBuildError(
          'workflow build returned error diagnostics',
          workflowId,
          revision,
        )
      }
      const manifest = validateCompiledManifest(result.manifest)
      this.database.run(
        `UPDATE workflow_revisions SET status = 'validated', artifact_digest = ?,
         lockfile = ?, manifest_json = ?, requested_grants_json = ?, diagnostics_json = ?
         WHERE workflow_id = ? AND revision = ? AND source_digest = ?`,
        result.artifactDigest,
        result.lockfile,
        JSON.stringify(manifest),
        JSON.stringify(manifest.requestedGrants ?? {}),
        JSON.stringify(result.diagnostics),
        workflowId,
        revision,
        row.source_digest,
      )
    } catch (cause) {
      this.database.run(
        `UPDATE workflow_revisions SET status = 'failed', diagnostics_json = ?
         WHERE workflow_id = ? AND revision = ?`,
        JSON.stringify([
          { severity: 'error', message: cause instanceof Error ? cause.message : String(cause) },
        ]),
        workflowId,
        revision,
      )
      throw cause instanceof WorkflowBuildError
        ? cause
        : new WorkflowBuildError(
            cause instanceof Error ? cause.message : String(cause),
            workflowId,
            revision,
            true,
          )
    }
  }

  publish(workflowId: string, revision: number): void {
    const result = this.database.run(
      `UPDATE workflow_revisions SET status = 'published'
       WHERE workflow_id = ? AND revision = ? AND status = 'validated'
       AND artifact_digest IS NOT NULL`,
      workflowId,
      revision,
    )
    if (result.changes !== 1) throw new WorkflowError('only a validated artifact can be published')
  }

  grant(input: {
    readonly workflowId: string
    readonly revision: number
    readonly grant: WorkflowGrant
    readonly principalId: string
  }): void {
    validateGrant(input.grant)
    const revision = this.database.get<{ status: string; requested_grants_json: string }>(
      `SELECT status, requested_grants_json FROM workflow_revisions
       WHERE workflow_id = ? AND revision = ?`,
      input.workflowId,
      input.revision,
    )
    if (revision?.status !== 'published') {
      throw new WorkflowError('grants can only be approved for a published workflow revision')
    }
    assertGrantCoversRequested(
      input.grant,
      JSON.parse(revision.requested_grants_json) as Readonly<Record<string, unknown>>,
    )
    this.database.run(
      `INSERT INTO workflow_grants(workflow_id, revision, grants_json, granted_by, granted_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(workflow_id, revision) DO UPDATE SET grants_json = excluded.grants_json,
       granted_by = excluded.granted_by, granted_at = excluded.granted_at`,
      input.workflowId,
      input.revision,
      JSON.stringify(input.grant),
      input.principalId,
      new Date().toISOString(),
    )
  }

  enable(workflowId: string, revision: number): void {
    const revisionRow = this.database.get<{ status: string; artifact_digest: string | null }>(
      'SELECT status, artifact_digest FROM workflow_revisions WHERE workflow_id = ? AND revision = ?',
      workflowId,
      revision,
    )
    const grant = this.database.get(
      'SELECT grants_json FROM workflow_grants WHERE workflow_id = ? AND revision = ?',
      workflowId,
      revision,
    )
    if (revisionRow?.status !== 'published' || !revisionRow.artifact_digest || !grant) {
      throw new WorkflowError('enable requires a published artifact and approved grants')
    }
    const now = new Date().toISOString()
    this.database.transaction(() => {
      const result = this.database.run(
        'UPDATE workflows SET enabled_revision = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL',
        revision,
        now,
        workflowId,
      )
      if (result.changes !== 1) throw new WorkflowError(`workflow ${workflowId} does not exist`)
      this.#cancelQueued(workflowId, now, revision)
    })
  }

  disable(workflowId: string): void {
    const now = new Date().toISOString()
    this.database.transaction(() => {
      this.database.run(
        'UPDATE workflows SET enabled_revision = NULL, updated_at = ? WHERE id = ?',
        now,
        workflowId,
      )
      this.#cancelQueued(workflowId, now)
    })
  }

  rollback(workflowId: string, revision: number): void {
    this.enable(workflowId, revision)
  }

  delete(workflowId: string): void {
    const row = this.database.get<{ enabled_revision: number | null }>(
      'SELECT enabled_revision FROM workflows WHERE id = ? AND deleted_at IS NULL',
      workflowId,
    )
    if (!row) throw new WorkflowError(`workflow ${workflowId} does not exist`)
    if (row.enabled_revision !== null)
      throw new WorkflowError('disable workflow before deleting it')
    this.database.run(
      'UPDATE workflows SET deleted_at = ?, updated_at = ? WHERE id = ?',
      new Date().toISOString(),
      new Date().toISOString(),
      workflowId,
    )
  }

  #cancelQueued(workflowId: string, now: string, exceptRevision?: number): void {
    this.database.run(
      `UPDATE workflow_executions SET status = 'failed', finished_at = ?, error_json = ?
       WHERE workflow_id = ? AND status = 'queued'
       ${exceptRevision === undefined ? '' : 'AND revision != ?'}`,
      now,
      JSON.stringify({
        code: 'WORKFLOW_DISABLED',
        message: 'workflow execution was queued when its revision was disabled',
        retryable: false,
      }),
      workflowId,
      ...(exceptRevision === undefined ? [] : [exceptRevision]),
    )
  }
}

const validateSource = (source: string, dependencies: Readonly<Record<string, string>>): void => {
  if (Buffer.byteLength(source) > 256 * 1024)
    throw new WorkflowError('workflow source exceeds 256 KiB')
  if (Object.keys(dependencies).length > 100)
    throw new WorkflowError('workflow has more than 100 dependencies')
}

const validateGrant = (grant: WorkflowGrant): void => {
  if (
    !isRecord(grant) ||
    !isRecord(grant.discord) ||
    !isRecord(grant.gateway) ||
    !isRecord(grant.interactions) ||
    !isRecord(grant.routes) ||
    !isRecord(grant.network) ||
    !isRecord(grant.runtime)
  ) {
    throw new WorkflowError('workflow grant must contain every capability policy')
  }
  const discord = grant.discord
  const gateway = grant.gateway
  const interactions = grant.interactions
  const routes = grant.routes
  const network = grant.network
  const runtime = grant.runtime
  const operationIds = stringArray(discord.operationIds, 'discord.operationIds')
  const operationFamilies = stringArray(discord.operationFamilies, 'discord.operationFamilies')
  const guildIds = stringArray(discord.guildIds, 'discord.guildIds')
  const channelIds = stringArray(discord.channelIds, 'discord.channelIds')
  stringArray(discord.oauthProfileIds, 'discord.oauthProfileIds')
  stringArray(gateway.eventTypes, 'gateway.eventTypes')
  const allowedHosts = stringArray(routes.allowedHosts, 'routes.allowedHosts')
  const allowedOrigins = stringArray(routes.allowedOrigins, 'routes.allowedOrigins')
  const allowedSourceCidrs = stringArray(routes.allowedSourceCidrs, 'routes.allowedSourceCidrs')
  const allowedOutboundHosts = stringArray(
    network.allowedOutboundHosts,
    'network.allowedOutboundHosts',
  )
  boolean(discord.botAdmin, 'discord.botAdmin')
  boolean(discord.broadMentions, 'discord.broadMentions')
  boolean(gateway.includeBotAuthoredEvents, 'gateway.includeBotAuthoredEvents')
  boolean(interactions.guildCommandPublishing, 'interactions.guildCommandPublishing')
  boolean(interactions.globalCommandPublishing, 'interactions.globalCommandPublishing')
  boolean(routes.public, 'routes.public')
  boolean(runtime.allowNpmInstallScripts, 'runtime.allowNpmInstallScripts')
  if (
    !Number.isInteger(discord.maxActionsPerMinute) ||
    discord.maxActionsPerMinute < 1 ||
    discord.maxActionsPerMinute > 10_000
  ) {
    throw new WorkflowError('invalid workflow action budget')
  }
  if (
    !Number.isInteger(runtime.timeoutSeconds) ||
    runtime.timeoutSeconds < 1 ||
    runtime.timeoutSeconds > 300
  ) {
    throw new WorkflowError('workflow timeout must be 1–300 seconds')
  }
  if (
    !Number.isInteger(runtime.concurrency) ||
    runtime.concurrency < 1 ||
    runtime.concurrency > 8
  ) {
    throw new WorkflowError('workflow concurrency must be 1–8')
  }
  if (
    !Number.isInteger(routes.maxBodyBytes) ||
    routes.maxBodyBytes < 1 ||
    routes.maxBodyBytes > 10 * 1024 * 1024
  ) {
    throw new WorkflowError('workflow route body limit is invalid')
  }
  for (const operationId of operationIds) {
    const operation = operationCatalog.get(operationId)
    if (!operation) throw new WorkflowError(`unknown Discord operation ${operationId}`)
    if (operation.risk === 'credential') {
      throw new WorkflowError(`credential operation ${operationId} cannot be granted to a workflow`)
    }
  }
  const knownFamilies = new Set(
    operationCatalog.operations
      .filter(({ risk }) => risk !== 'credential')
      .map(({ family }) => family),
  )
  for (const family of operationFamilies) {
    if (!knownFamilies.has(family))
      throw new WorkflowError(`unknown Discord operation family ${family}`)
  }
  for (const snowflake of [...guildIds, ...channelIds]) {
    if (!/^\d{17,21}$/.test(snowflake))
      throw new WorkflowError(`invalid Discord snowflake ${snowflake}`)
  }
  for (const host of [...allowedHosts, ...allowedOutboundHosts]) validateHost(host)
  for (const origin of allowedOrigins) {
    let url: URL
    try {
      url = new URL(origin)
    } catch {
      throw new WorkflowError(`invalid route origin ${origin}`)
    }
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.origin !== origin ||
      url.username ||
      url.password
    ) {
      throw new WorkflowError(`invalid route origin ${origin}`)
    }
  }
  for (const cidr of allowedSourceCidrs) {
    try {
      ipaddr.parseCIDR(cidr)
    } catch {
      throw new WorkflowError(`invalid route source CIDR ${cidr}`)
    }
  }
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const stringArray = (value: unknown, field: string): ReadonlyArray<string> => {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== 'string' || entry.length === 0) ||
    new Set(value).size !== value.length
  ) {
    throw new WorkflowError(`${field} must be an array of unique non-empty strings`)
  }
  return value
}

const boolean = (value: unknown, field: string): void => {
  if (typeof value !== 'boolean') throw new WorkflowError(`${field} must be a boolean`)
}

const validateHost = (host: string): void => {
  if (
    host.includes('://') ||
    host.includes('/') ||
    host.includes('@') ||
    host !== host.trim() ||
    host.length > 253
  ) {
    throw new WorkflowError(`invalid allowed host ${host}`)
  }
  try {
    const url = new URL(`https://${host}`)
    if (!url.hostname || (url.port && !/^\d{1,5}$/.test(url.port))) throw new Error('invalid host')
  } catch {
    throw new WorkflowError(`invalid allowed host ${host}`)
  }
}
