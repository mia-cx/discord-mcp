import { type Principal, requireScopes, type Scope } from '@discord-mcp/auth'
import { operationCatalog } from '@discord-mcp/discord-api'
import type { Database } from '@discord-mcp/persistence'
import { type McpServer, ResourceTemplate } from '@modelcontextprotocol/server'

const text = (uri: URL, value: unknown) => ({
  contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(value, null, 2) }],
})

const canAccessEveryOwner = (principal: Principal): boolean =>
  principal.kind === 'local' || principal.scopes.has('auth:admin')

export const registerResources = (
  server: McpServer,
  principal: Principal,
  database?: Database,
): void => {
  server.registerResource(
    'discord-api-operation',
    new ResourceTemplate('discord://api/operations/{operationId}', { list: undefined }),
    { title: 'Discord API operation', mimeType: 'application/json' },
    async (uri, variables) => {
      requireScopes(principal, ['mcp:read'])
      return text(uri, operationCatalog.describe(String(variables.operationId)))
    },
  )
  server.registerResource(
    'discord-api-family',
    new ResourceTemplate('discord://api/families/{family}', { list: undefined }),
    { title: 'Discord API family', mimeType: 'application/json' },
    async (uri, variables) => {
      requireScopes(principal, ['mcp:read'])
      return text(
        uri,
        operationCatalog.operations.filter(({ family }) => family === variables.family),
      )
    },
  )
  server.registerResource(
    'discord-components-v2',
    'discord://components/v2',
    { title: 'Discord Components V2 constraints', mimeType: 'application/json' },
    async (uri) => {
      requireScopes(principal, ['mcp:read'])
      return text(uri, {
        flag: 32768,
        maximumRecursiveComponents: 40,
        maximumTopLevelAdvisory: 10,
        maximumDepth: 3,
        topLevel: [
          'actionRow',
          'container',
          'file',
          'mediaGallery',
          'section',
          'separator',
          'text',
        ],
        prohibitedWithV2: ['content', 'embeds', 'poll', 'sticker_ids', 'shared_client_theme'],
        notes: [
          'Section requires 1–3 text children and a button or thumbnail accessory.',
          'Container and Section cannot recursively contain themselves.',
          'Uploaded files must be referenced with attachment:// from a visible component.',
          'Deferred callback type 5 cannot set the Components V2 flag.',
        ],
      })
    },
  )
  if (!database) return
  registerDatabaseResource(server, database, principal, {
    name: 'discord-message-template-revision',
    template: 'discord://message-templates/{id}/revisions/{revision}',
    scope: 'template:read',
    sql: `SELECT r.document_json AS document, r.digest, r.published_by, r.published_at
      FROM message_template_revisions r
      JOIN message_templates d ON d.id = r.template_id
      WHERE r.template_id = ? AND r.revision = ?`,
    ownerColumn: 'd.owner_principal_id',
  })
  registerDatabaseResource(server, database, principal, {
    name: 'discord-server-blueprint-revision',
    template: 'discord://server-blueprints/{id}/revisions/{revision}',
    scope: 'server:plan',
    sql: `SELECT r.document_json AS document, r.digest, r.published_by, r.published_at
      FROM server_blueprint_revisions r
      JOIN server_blueprints d ON d.id = r.blueprint_id
      WHERE r.blueprint_id = ? AND r.revision = ?`,
    ownerColumn: 'd.owner_principal_id',
  })
  registerDatabaseResource(server, database, principal, {
    name: 'discord-server-blueprint-execution',
    template: 'discord://server-blueprints/{id}/executions/{executionId}',
    scope: 'server:plan',
    sql: `SELECT e.*
      FROM server_blueprint_executions e
      JOIN server_blueprints d ON d.id = e.blueprint_id
      WHERE e.blueprint_id = ? AND e.id = ?`,
    ownerColumn: 'd.owner_principal_id',
  })
  registerDatabaseResource(server, database, principal, {
    name: 'discord-workflow-revision',
    template: 'discord://workflows/{id}/revisions/{revision}',
    scope: 'workflow:read',
    sql: `SELECT r.*
      FROM workflow_revisions r
      JOIN workflows d ON d.id = r.workflow_id
      WHERE r.workflow_id = ? AND r.revision = ?`,
    ownerColumn: 'd.owner_principal_id',
  })
  registerDatabaseResource(server, database, principal, {
    name: 'discord-workflow-execution',
    template: 'discord://workflows/{id}/executions/{executionId}',
    scope: 'workflow:read',
    sql: `SELECT e.*
      FROM workflow_executions e
      JOIN workflows d ON d.id = e.workflow_id
      WHERE e.workflow_id = ? AND e.id = ?`,
    ownerColumn: 'd.owner_principal_id',
  })
  server.registerResource(
    'discord-workflow',
    new ResourceTemplate('discord://workflows/{workflowId}', { list: undefined }),
    { title: 'Workflow', mimeType: 'application/json' },
    async (uri, variables) => {
      requireScopes(principal, ['workflow:read'])
      const workflowId = String(variables.workflowId)
      const ownerClause = canAccessEveryOwner(principal) ? '' : ' AND owner_principal_id = ?'
      const ownerParameters = canAccessEveryOwner(principal) ? [] : [principal.id]
      const workflow = database.get(
        `SELECT id, owner_principal_id, slug, name, enabled_revision, deleted_at,
           created_at, updated_at FROM workflows WHERE id = ?${ownerClause}`,
        workflowId,
        ...ownerParameters,
      )
      return text(uri, {
        workflow: workflow ?? { missing: true },
        revisions:
          workflow === undefined
            ? []
            : database.all(
                `SELECT revision, source_digest, artifact_digest, requested_grants_json,
                 manifest_json, status, diagnostics_json, created_by, created_at
                 FROM workflow_revisions WHERE workflow_id = ? ORDER BY revision DESC`,
                workflowId,
              ),
      })
    },
  )
  server.registerResource(
    'discord-audit-entry',
    new ResourceTemplate('discord://audit/{auditId}', { list: undefined }),
    { title: 'Audit entry', mimeType: 'application/json' },
    async (uri, variables) => {
      requireScopes(principal, ['audit:read'])
      return text(
        uri,
        database.get('SELECT * FROM audit_log WHERE id = ?', String(variables.auditId)) ?? {
          missing: true,
        },
      )
    },
  )
}

interface DatabaseResource {
  readonly name: string
  readonly template: string
  readonly scope: Scope
  readonly sql: string
  readonly ownerColumn: string
}

const registerDatabaseResource = (
  server: McpServer,
  database: Database,
  principal: Principal,
  resource: DatabaseResource,
): void => {
  server.registerResource(
    resource.name,
    new ResourceTemplate(resource.template, { list: undefined }),
    { mimeType: 'application/json' },
    async (uri, variables) => {
      requireScopes(principal, [resource.scope])
      const second = variables.revision ?? variables.executionId
      const restrictOwner = !canAccessEveryOwner(principal)
      const row = database.get(
        `${resource.sql}${restrictOwner ? ` AND ${resource.ownerColumn} = ?` : ''}`,
        String(variables.id),
        String(second),
        ...(restrictOwner ? [principal.id] : []),
      )
      if (row && typeof row.document === 'string') {
        return text(uri, { ...row, document: JSON.parse(row.document) })
      }
      return text(uri, row ?? { missing: true })
    },
  )
}
