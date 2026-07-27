import {
  type DiscordOAuthProfiles,
  type Principal,
  requireScopes,
  type Scope,
} from '@discord-mcp/auth'
import { JsonValueSchema, McpInput } from '@discord-mcp/core'
import {
  type ServerBlueprint,
  ServerBlueprintDraftSchema,
  validateBlueprint,
} from '@discord-mcp/discord-blueprints'
import {
  type MessageTemplateDocument,
  MessageTemplateDocumentSchema,
  renderTemplate,
} from '@discord-mcp/discord-presentations'
import { type BlobStore, type Database, VersionedDocumentStore } from '@discord-mcp/persistence'
import type {
  WorkflowGrant,
  WorkflowRuntimeManager,
  WorkflowStore,
} from '@discord-mcp/workflow-runtime'
import type { CallToolResult, McpServer } from '@modelcontextprotocol/server'
import { Schema } from 'effect'

export interface ControlToolServices {
  readonly database?: Database
  readonly blobs?: BlobStore
  readonly workflows?: WorkflowStore
  readonly oauthProfiles?: DiscordOAuthProfiles
  readonly workflowRuntime?: WorkflowRuntimeManager
}

type Attempt = (run: () => unknown | Promise<unknown>) => Promise<CallToolResult>

interface ControlToolContext {
  readonly signal: AbortSignal
  readonly progressToken?: string | number
  readonly notifyProgress: (input: {
    readonly progress: number
    readonly total: number
    readonly message: string
  }) => Promise<void>
}

const requireService = <A>(service: A | undefined, name: string): A => {
  if (!service) throw new Error(`${name} is not configured`)
  return service
}

const Snowflake = Schema.String.pipe(Schema.check(Schema.isPattern(/^\d{17,21}$/)))
const PositiveInt = Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 10_000 })))
const EmptyInput = Schema.Record(Schema.String, Schema.Never)
const WorkflowGrantInput = Schema.Struct({
  discord: Schema.Struct({
    operationIds: Schema.Array(Schema.String),
    operationFamilies: Schema.Array(Schema.String),
    guildIds: Schema.Array(Snowflake),
    channelIds: Schema.Array(Snowflake),
    oauthProfileIds: Schema.Array(Schema.String),
    botAdmin: Schema.Boolean,
    broadMentions: Schema.Boolean,
    maxActionsPerMinute: PositiveInt,
  }),
  gateway: Schema.Struct({
    eventTypes: Schema.Array(Schema.String),
    includeBotAuthoredEvents: Schema.Boolean,
  }),
  interactions: Schema.Struct({
    guildCommandPublishing: Schema.Boolean,
    globalCommandPublishing: Schema.Boolean,
  }),
  routes: Schema.Struct({
    public: Schema.Boolean,
    allowedHosts: Schema.Array(Schema.String),
    allowedOrigins: Schema.Array(Schema.String),
    allowedSourceCidrs: Schema.Array(Schema.String),
    maxBodyBytes: Schema.Int.pipe(
      Schema.check(Schema.isBetween({ minimum: 1, maximum: 10 * 1024 * 1024 })),
    ),
  }),
  network: Schema.Struct({ allowedOutboundHosts: Schema.Array(Schema.String) }),
  runtime: Schema.Struct({
    allowNpmInstallScripts: Schema.Boolean,
    timeoutSeconds: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 300 }))),
    concurrency: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 8 }))),
  }),
})

const register = <A>(
  server: McpServer,
  principal: Principal,
  attempt: Attempt,
  input: {
    readonly name: string
    readonly description: string
    readonly schema: Schema.ConstraintDecoder<A, never>
    readonly scope: Scope
    readonly readOnly?: boolean
    readonly destructive?: boolean
    readonly run: (args: A, context: ControlToolContext) => unknown | Promise<unknown>
  },
): void => {
  server.registerTool(
    input.name,
    {
      description: `${input.description} Required local scope: ${input.scope}.`,
      inputSchema: McpInput(input.schema),
      annotations: {
        readOnlyHint: input.readOnly ?? false,
        destructiveHint: input.destructive ?? false,
        idempotentHint: input.readOnly ?? false,
        openWorldHint: false,
      },
    },
    async (args, context) =>
      attempt(() => {
        requireScopes(principal, [input.scope])
        const progressToken = context.mcpReq._meta?.progressToken
        return input.run(args, {
          signal: context.mcpReq.signal,
          ...(progressToken === undefined ? {} : { progressToken }),
          notifyProgress: async ({ progress, total, message }) => {
            if (progressToken === undefined) return
            await context.mcpReq.notify({
              method: 'notifications/progress',
              params: { progressToken, progress, total, message },
            })
          },
        })
      }),
  )
}

export const registerControlTools = (
  server: McpServer,
  services: ControlToolServices,
  principal: Principal,
  attempt: Attempt,
): void => {
  const database = services.database
  const templates =
    database === undefined ? undefined : new VersionedDocumentStore(database, 'message-template')
  const blueprints =
    database === undefined ? undefined : new VersionedDocumentStore(database, 'server-blueprint')

  register(server, principal, attempt, {
    name: 'discord_message_template_list',
    description: 'List owned versioned message templates.',
    schema: EmptyInput,
    scope: 'template:read',
    readOnly: true,
    run: () => requireService(templates, 'template persistence').list(principal.id),
  })
  register(server, principal, attempt, {
    name: 'discord_message_template_get',
    description: 'Get a message-template draft or immutable published revision.',
    schema: Schema.Struct({
      templateId: Schema.String,
      revision: Schema.optionalKey(Schema.Int),
      draft: Schema.optionalKey(Schema.Boolean),
    }),
    scope: 'template:read',
    readOnly: true,
    run: ({ templateId, revision, draft }) =>
      draft
        ? requireService(templates, 'template persistence').getDraft(templateId, principal.id)
        : requireService(templates, 'template persistence').getPublished(
            templateId,
            revision,
            principal.id,
          ),
  })
  register(server, principal, attempt, {
    name: 'discord_message_template_create',
    description: 'Create a mutable message-template draft without publishing it.',
    schema: Schema.Struct({ name: Schema.String, document: MessageTemplateDocumentSchema }),
    scope: 'template:write',
    run: ({ name, document }) =>
      requireService(templates, 'template persistence').create({
        ownerPrincipalId: principal.id,
        name,
        document,
      }),
  })
  register(server, principal, attempt, {
    name: 'discord_message_template_update_draft',
    description: 'Replace a message-template draft; published revisions remain immutable.',
    schema: Schema.Struct({
      templateId: Schema.String,
      document: MessageTemplateDocumentSchema,
    }),
    scope: 'template:write',
    run: ({ templateId, document }) => {
      requireService(templates, 'template persistence').updateDraft(
        templateId,
        principal.id,
        document,
      )
      return { updated: true }
    },
  })
  register(server, principal, attempt, {
    name: 'discord_message_template_validate',
    description: 'Render and validate a template draft with representative variables.',
    schema: Schema.Struct({ templateId: Schema.String, variables: JsonValueSchema }),
    scope: 'template:read',
    readOnly: true,
    run: ({ templateId, variables }) =>
      renderTemplate(
        requireService(templates, 'template persistence').getDraft(
          templateId,
          principal.id,
        ) as MessageTemplateDocument,
        variables,
      ),
  })
  register(server, principal, attempt, {
    name: 'discord_message_template_publish',
    description: 'Publish the current validated template document as an immutable revision.',
    schema: Schema.Struct({ templateId: Schema.String, variables: JsonValueSchema }),
    scope: 'template:write',
    run: ({ templateId, variables }) => {
      const store = requireService(templates, 'template persistence')
      renderTemplate(store.getDraft(templateId, principal.id) as MessageTemplateDocument, variables)
      return store.publish(templateId, principal.id)
    },
  })
  register(server, principal, attempt, {
    name: 'discord_message_template_render',
    description: 'Render an immutable published template revision.',
    schema: Schema.Struct({
      templateId: Schema.String,
      revision: Schema.optionalKey(Schema.Int),
      variables: JsonValueSchema,
    }),
    scope: 'template:read',
    readOnly: true,
    run: ({ templateId, revision, variables }) =>
      renderTemplate(
        requireService(templates, 'template persistence').getPublished(
          templateId,
          revision,
          principal.id,
        ).document as MessageTemplateDocument,
        variables,
      ),
  })
  register(server, principal, attempt, {
    name: 'discord_message_template_archive',
    description: 'Archive a template without deleting its published revisions.',
    schema: Schema.Struct({ templateId: Schema.String }),
    scope: 'template:write',
    destructive: true,
    run: ({ templateId }) => {
      requireService(templates, 'template persistence').archive(templateId, principal.id)
      return { archived: true }
    },
  })

  register(server, principal, attempt, {
    name: 'discord_blob_put',
    description: 'Store a bounded inline base64 blob. MCP never accepts local filesystem paths.',
    schema: Schema.Struct({
      filename: Schema.String,
      mimeType: Schema.String,
      base64: Schema.String,
    }),
    scope: 'blob:write',
    run: (args) =>
      requireService(services.blobs, 'blob persistence').putInline({
        ownerPrincipalId: principal.id,
        ...args,
      }),
  })
  register(server, principal, attempt, {
    name: 'discord_blob_get_metadata',
    description: 'Get blob metadata without exposing its content.',
    schema: Schema.Struct({ blobId: Schema.String }),
    scope: 'mcp:read',
    readOnly: true,
    run: ({ blobId }) =>
      requireService(services.blobs, 'blob persistence').getMetadata(blobId, principal.id),
  })
  register(server, principal, attempt, {
    name: 'discord_blob_delete',
    description: 'Delete an unreferenced owned blob.',
    schema: Schema.Struct({ blobId: Schema.String }),
    scope: 'blob:write',
    destructive: true,
    run: ({ blobId }) =>
      requireService(services.blobs, 'blob persistence').delete(blobId, principal.id),
  })

  register(server, principal, attempt, {
    name: 'discord_server_blueprint_list',
    description: 'List owned declarative server blueprints.',
    schema: EmptyInput,
    scope: 'server:plan',
    readOnly: true,
    run: () => requireService(blueprints, 'blueprint persistence').list(principal.id),
  })
  register(server, principal, attempt, {
    name: 'discord_server_blueprint_get',
    description: 'Get a blueprint draft or immutable published revision.',
    schema: Schema.Struct({
      blueprintId: Schema.String,
      revision: Schema.optionalKey(Schema.Int),
      draft: Schema.optionalKey(Schema.Boolean),
    }),
    scope: 'server:plan',
    readOnly: true,
    run: ({ blueprintId, revision, draft }) =>
      draft
        ? requireService(blueprints, 'blueprint persistence').getDraft(blueprintId, principal.id)
        : requireService(blueprints, 'blueprint persistence').getPublished(
            blueprintId,
            revision,
            principal.id,
          ),
  })
  register(server, principal, attempt, {
    name: 'discord_server_blueprint_create',
    description: 'Create a mutable server-blueprint draft.',
    schema: Schema.Struct({
      name: Schema.String,
      guildId: Schema.String,
      document: ServerBlueprintDraftSchema,
    }),
    scope: 'server:plan',
    run: ({ name, guildId, document }) =>
      requireService(blueprints, 'blueprint persistence').create({
        ownerPrincipalId: principal.id,
        name,
        guildId,
        document,
      }),
  })
  register(server, principal, attempt, {
    name: 'discord_server_blueprint_update_draft',
    description: 'Replace a blueprint draft without changing published revisions.',
    schema: Schema.Struct({
      blueprintId: Schema.String,
      document: ServerBlueprintDraftSchema,
    }),
    scope: 'server:plan',
    run: ({ blueprintId, document }) => {
      requireService(blueprints, 'blueprint persistence').updateDraft(
        blueprintId,
        principal.id,
        document,
      )
      return { updated: true }
    },
  })
  register(server, principal, attempt, {
    name: 'discord_server_blueprint_validate',
    description: 'Validate named roles, channel kinds, parent references, and permission names.',
    schema: Schema.Struct({ blueprintId: Schema.String }),
    scope: 'server:plan',
    readOnly: true,
    run: ({ blueprintId }) => {
      validateBlueprint(
        requireService(blueprints, 'blueprint persistence').getDraft(
          blueprintId,
          principal.id,
        ) as ServerBlueprint,
      )
      return { valid: true }
    },
  })
  register(server, principal, attempt, {
    name: 'discord_server_blueprint_publish',
    description: 'Validate and publish an immutable blueprint revision.',
    schema: Schema.Struct({ blueprintId: Schema.String }),
    scope: 'server:plan',
    run: ({ blueprintId }) => {
      const store = requireService(blueprints, 'blueprint persistence')
      validateBlueprint(store.getDraft(blueprintId, principal.id) as ServerBlueprint)
      return store.publish(blueprintId, principal.id)
    },
  })
  register(server, principal, attempt, {
    name: 'discord_server_blueprint_archive',
    description: 'Archive a blueprint without touching its guild or bindings.',
    schema: Schema.Struct({ blueprintId: Schema.String }),
    scope: 'server:plan',
    destructive: true,
    run: ({ blueprintId }) => {
      requireService(blueprints, 'blueprint persistence').archive(blueprintId, principal.id)
      return { archived: true }
    },
  })

  register(server, principal, attempt, {
    name: 'discord_audit_list',
    description: 'List redacted control-plane audit entries with bounded cursor pagination.',
    schema: Schema.Struct({
      cursor: Schema.optionalKey(Schema.Int),
      limit: Schema.optionalKey(Schema.Int),
      outcome: Schema.optionalKey(Schema.Literals(['success', 'failure'])),
    }),
    scope: 'audit:read',
    readOnly: true,
    run: ({ cursor, limit, outcome }) => {
      const store = requireService(database, 'audit persistence')
      const bounded = Math.max(1, Math.min(limit ?? 50, 200))
      return outcome
        ? store.all(
            `SELECT rowid AS cursor, * FROM audit_log
             WHERE rowid > ? AND outcome = ? ORDER BY rowid LIMIT ?`,
            cursor ?? 0,
            outcome,
            bounded,
          )
        : store.all(
            'SELECT rowid AS cursor, * FROM audit_log WHERE rowid > ? ORDER BY rowid LIMIT ?',
            cursor ?? 0,
            bounded,
          )
    },
  })

  registerWorkflowTools(server, services, principal, attempt)
  register(server, principal, attempt, {
    name: 'discord_oauth_profile_authorize',
    description: 'Create a short-lived Discord OAuth2 authorization URL with PKCE.',
    schema: Schema.Struct({ name: Schema.String, scopes: Schema.Array(Schema.String) }),
    scope: 'oauth:manage',
    run: ({ name, scopes }) =>
      requireService(services.oauthProfiles, 'Discord OAuth').authorize({
        principalId: principal.id,
        name,
        scopes,
      }),
  })
  register(server, principal, attempt, {
    name: 'discord_oauth_profile_list',
    description: 'List owned Discord OAuth profiles without exposing tokens.',
    schema: EmptyInput,
    scope: 'oauth:manage',
    readOnly: true,
    run: () => requireService(services.oauthProfiles, 'Discord OAuth').list(principal.id),
  })
  register(server, principal, attempt, {
    name: 'discord_oauth_profile_get',
    description: 'Get one owned Discord OAuth profile without exposing token material.',
    schema: Schema.Struct({ profileId: Schema.String }),
    scope: 'oauth:manage',
    readOnly: true,
    run: ({ profileId }) =>
      requireService(services.oauthProfiles, 'Discord OAuth').get(profileId, principal.id),
  })
  register(server, principal, attempt, {
    name: 'discord_oauth_profile_revoke',
    description: 'Revoke an owned Discord OAuth profile and erase its token material.',
    schema: Schema.Struct({ profileId: Schema.String }),
    scope: 'oauth:manage',
    destructive: true,
    run: ({ profileId }) =>
      requireService(services.oauthProfiles, 'Discord OAuth').revoke(profileId, principal.id),
  })
}

const registerWorkflowTools = (
  server: McpServer,
  services: ControlToolServices,
  principal: Principal,
  attempt: Attempt,
): void => {
  const getStore = () => requireService(services.workflows, 'workflow runtime')
  const canAccessAll = principal.kind === 'local' || principal.scopes.has('auth:admin')
  const assertWorkflowAccess = (workflowId: string): void => {
    if (canAccessAll) return
    const row = requireService(services.database, 'workflow persistence').get<{
      owner_principal_id: string
    }>('SELECT owner_principal_id FROM workflows WHERE id = ?', workflowId)
    if (!row || row.owner_principal_id !== principal.id) {
      throw new Error('workflow does not exist or belongs to another principal')
    }
  }
  register(server, principal, attempt, {
    name: 'discord_workflow_list',
    description: 'List workflows and their enabled revisions.',
    schema: EmptyInput,
    scope: 'workflow:read',
    readOnly: true,
    run: () => getStore().list(canAccessAll ? undefined : principal.id),
  })
  register(server, principal, attempt, {
    name: 'discord_workflow_get',
    description: 'Get workflow metadata and revision history.',
    schema: Schema.Struct({ workflowId: Schema.String }),
    scope: 'workflow:read',
    readOnly: true,
    run: ({ workflowId }) => {
      assertWorkflowAccess(workflowId)
      return getStore().get(workflowId)
    },
  })
  register(server, principal, attempt, {
    name: 'discord_workflow_create',
    description: 'Create a workflow and its first ungranted draft revision.',
    schema: Schema.Struct({
      slug: Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,62}$/))),
      name: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
      source: Schema.String.pipe(Schema.check(Schema.isMaxLength(256 * 1024))),
      dependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
    }),
    scope: 'workflow:write',
    run: (args) => getStore().create({ ownerPrincipalId: principal.id, ...args }),
  })
  register(server, principal, attempt, {
    name: 'discord_workflow_update_draft',
    description:
      'Update an existing mutable workflow draft, or create the next draft after publication.',
    schema: Schema.Struct({
      workflowId: Schema.String,
      revision: Schema.optionalKey(Schema.Int),
      source: Schema.String.pipe(Schema.check(Schema.isMaxLength(256 * 1024))),
      dependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
    }),
    scope: 'workflow:write',
    run: (args) => {
      assertWorkflowAccess(args.workflowId)
      if (args.revision === undefined) {
        const revision = getStore().createDraft({
          workflowId: args.workflowId,
          principalId: principal.id,
          source: args.source,
          ...(args.dependencies === undefined ? {} : { dependencies: args.dependencies }),
        })
        return { created: true, revision }
      }
      getStore().updateDraft({
        workflowId: args.workflowId,
        revision: args.revision,
        source: args.source,
        dependencies: args.dependencies ?? {},
      })
      return { updated: true, revision: args.revision }
    },
  })
  register(server, principal, attempt, {
    name: 'discord_workflow_validate',
    description: 'Build, typecheck, import, and validate a workflow draft in the sandbox.',
    schema: Schema.Struct({
      workflowId: Schema.String,
      revision: Schema.Int,
      allowNpmInstallScripts: Schema.optionalKey(Schema.Boolean),
    }),
    scope: 'workflow:write',
    run: ({ workflowId, revision, allowNpmInstallScripts }) => {
      assertWorkflowAccess(workflowId)
      if (allowNpmInstallScripts) requireScopes(principal, ['workflow:admin'])
      return getStore()
        .validate(workflowId, revision, allowNpmInstallScripts)
        .then(() => getStore().get(workflowId))
    },
  })
  const workflowMutation = (
    name: string,
    description: string,
    scope: Scope,
    run: (store: WorkflowStore, workflowId: string, revision: number) => unknown,
  ) =>
    register(server, principal, attempt, {
      name,
      description,
      schema: Schema.Struct({ workflowId: Schema.String, revision: Schema.Int }),
      scope,
      run: ({ workflowId, revision }) => {
        assertWorkflowAccess(workflowId)
        return run(getStore(), workflowId, revision)
      },
    })
  workflowMutation(
    'discord_workflow_publish',
    'Publish a successfully validated immutable workflow artifact.',
    'workflow:write',
    (store, id, revision) => {
      store.publish(id, revision)
      return { published: true }
    },
  )
  register(server, principal, attempt, {
    name: 'discord_workflow_grant',
    description: 'Approve a revision-specific, default-deny workflow capability grant.',
    schema: Schema.Struct({
      workflowId: Schema.String,
      revision: Schema.Int,
      grant: WorkflowGrantInput,
    }),
    scope: 'workflow:admin',
    run: ({ workflowId, revision, grant }) => {
      assertWorkflowAccess(workflowId)
      getStore().grant({
        workflowId,
        revision,
        grant: grant as WorkflowGrant,
        principalId: principal.id,
      })
      return { granted: true }
    },
  })
  register(server, principal, attempt, {
    name: 'discord_workflow_enable',
    description: 'Atomically enable and register a published, granted workflow revision.',
    schema: Schema.Struct({ workflowId: Schema.String, revision: Schema.Int }),
    scope: 'workflow:admin',
    run: async ({ workflowId, revision }) => {
      assertWorkflowAccess(workflowId)
      getStore().enable(workflowId, revision)
      try {
        await services.workflowRuntime?.syncEnabled()
      } catch (cause) {
        getStore().disable(workflowId)
        await services.workflowRuntime?.syncEnabled().catch(() => undefined)
        throw cause
      }
      return { enabled: true }
    },
  })
  register(server, principal, attempt, {
    name: 'discord_workflow_disable',
    description: 'Disable a workflow so it accepts no new executions.',
    schema: Schema.Struct({ workflowId: Schema.String }),
    scope: 'workflow:admin',
    run: async ({ workflowId }) => {
      assertWorkflowAccess(workflowId)
      getStore().disable(workflowId)
      await services.workflowRuntime?.syncEnabled()
      return { disabled: true }
    },
  })
  register(server, principal, attempt, {
    name: 'discord_workflow_rollback',
    description: 'Switch an enabled workflow to an existing published and granted revision.',
    schema: Schema.Struct({ workflowId: Schema.String, revision: Schema.Int }),
    scope: 'workflow:admin',
    run: async ({ workflowId, revision }) => {
      assertWorkflowAccess(workflowId)
      const store = getStore()
      const previous = store.get(workflowId).enabled_revision
      store.rollback(workflowId, revision)
      try {
        await services.workflowRuntime?.syncEnabled()
      } catch (cause) {
        if (typeof previous === 'number') store.rollback(workflowId, previous)
        else store.disable(workflowId)
        await services.workflowRuntime?.syncEnabled().catch(() => undefined)
        throw cause
      }
      return { rolledBack: true }
    },
  })
  register(server, principal, attempt, {
    name: 'discord_workflow_delete',
    description: 'Soft-delete a disabled workflow.',
    schema: Schema.Struct({ workflowId: Schema.String }),
    scope: 'workflow:admin',
    destructive: true,
    run: ({ workflowId }) => {
      assertWorkflowAccess(workflowId)
      getStore().delete(workflowId)
      return { deleted: true }
    },
  })
  register(server, principal, attempt, {
    name: 'discord_workflow_invoke',
    description: 'Persist a manual trigger for an enabled workflow.',
    schema: Schema.Struct({
      workflowId: Schema.String,
      key: Schema.String,
      payload: Schema.optionalKey(JsonValueSchema),
    }),
    scope: 'workflow:write',
    run: ({ workflowId, key, payload }) => {
      assertWorkflowAccess(workflowId)
      return requireService(services.workflowRuntime, 'workflow runtime').enqueue({
        workflowId,
        triggerType: 'manual',
        triggerKey: key,
        input: payload,
      })
    },
  })
  register(server, principal, attempt, {
    name: 'discord_workflow_execution_get',
    description: 'Get one durable workflow execution.',
    schema: Schema.Struct({ executionId: Schema.String }),
    scope: 'workflow:read',
    readOnly: true,
    run: ({ executionId }) => {
      const database = requireService(services.database, 'workflow persistence')
      return (
        (canAccessAll
          ? database.get('SELECT * FROM workflow_executions WHERE id = ?', executionId)
          : database.get(
              `SELECT e.* FROM workflow_executions e JOIN workflows w ON w.id = e.workflow_id
               WHERE e.id = ? AND w.owner_principal_id = ?`,
              executionId,
              principal.id,
            )) ?? { missing: true }
      )
    },
  })
  register(server, principal, attempt, {
    name: 'discord_workflow_executions_tail',
    description:
      'Long-poll durable workflow executions using a bounded monotonic cursor and status filters.',
    schema: Schema.Struct({
      workflowId: Schema.optionalKey(Schema.String),
      cursor: Schema.optionalKey(Schema.Int),
      statuses: Schema.optionalKey(
        Schema.Array(Schema.Literals(['queued', 'running', 'succeeded', 'failed', 'timed_out'])),
      ),
      limit: Schema.optionalKey(Schema.Int),
      waitMs: Schema.optionalKey(Schema.Int),
    }),
    scope: 'workflow:read',
    readOnly: true,
    run: async ({ workflowId, cursor, statuses, limit, waitMs }, context) => {
      const database = requireService(services.database, 'workflow persistence')
      const bounded = Math.max(1, Math.min(limit ?? 50, 200))
      const boundedWait = Math.max(0, Math.min(waitMs ?? 0, 30_000))
      if (workflowId) assertWorkflowAccess(workflowId)
      const statusFilter = normalizedFilter(statuses, [
        'queued',
        'running',
        'succeeded',
        'failed',
        'timed_out',
      ])
      return longPoll(boundedWait, context, () => {
        const filters = [
          'e.rowid > ?',
          ...(workflowId ? ['e.workflow_id = ?'] : []),
          ...(!canAccessAll && !workflowId ? ['w.owner_principal_id = ?'] : []),
          ...(statusFilter.length > 0
            ? [`e.status IN (${statusFilter.map(() => '?').join(', ')})`]
            : []),
        ]
        return database.all(
          `SELECT e.rowid AS cursor, e.* FROM workflow_executions e
           ${!canAccessAll && !workflowId ? 'JOIN workflows w ON w.id = e.workflow_id' : ''}
           WHERE ${filters.join(' AND ')} ORDER BY e.rowid LIMIT ?`,
          cursor ?? 0,
          ...(workflowId ? [workflowId] : []),
          ...(!canAccessAll && !workflowId ? [principal.id] : []),
          ...statusFilter,
          bounded,
        )
      })
    },
  })
  register(server, principal, attempt, {
    name: 'discord_events_tail',
    description:
      'Long-poll durable workflow-trigger or interactive-component inbox events using a monotonic cursor.',
    schema: Schema.Struct({
      inbox: Schema.optionalKey(Schema.Literals(['workflow', 'component'])),
      workflowId: Schema.optionalKey(Schema.String),
      cursor: Schema.optionalKey(Schema.Int),
      eventTypes: Schema.optionalKey(Schema.Array(Schema.String)),
      limit: Schema.optionalKey(Schema.Int),
      waitMs: Schema.optionalKey(Schema.Int),
    }),
    scope: 'workflow:read',
    readOnly: true,
    run: async ({ inbox, workflowId, cursor, eventTypes, limit, waitMs }, context) => {
      const database = requireService(services.database, 'workflow persistence')
      const bounded = Math.max(1, Math.min(limit ?? 50, 200))
      const boundedWait = Math.max(0, Math.min(waitMs ?? 0, 30_000))
      if (workflowId) assertWorkflowAccess(workflowId)
      const eventFilter = normalizedFilter(eventTypes)
      if (inbox === 'component') {
        return longPoll(boundedWait, context, () => {
          const filters = [
            'e.sequence > ?',
            ...(workflowId ? ["e.owner_type = 'workflow'", 'e.owner_id = ?'] : []),
            ...(!canAccessAll && !workflowId
              ? [
                  `((e.owner_type = 'principal' AND e.owner_id = ?)
                    OR (e.owner_type = 'workflow' AND EXISTS (
                      SELECT 1 FROM workflows w
                      WHERE w.id = e.owner_id AND w.owner_principal_id = ?
                    )))`,
                ]
              : []),
            ...(eventFilter.length > 0
              ? [`e.action_key IN (${eventFilter.map(() => '?').join(', ')})`]
              : []),
          ]
          return database.all(
            `SELECT e.* FROM component_events e
             WHERE ${filters.join(' AND ')} ORDER BY e.sequence LIMIT ?`,
            cursor ?? 0,
            ...(workflowId ? [workflowId] : []),
            ...(!canAccessAll && !workflowId ? [principal.id, principal.id] : []),
            ...eventFilter,
            bounded,
          )
        })
      }
      return longPoll(boundedWait, context, () => {
        const filters = [
          'e.sequence > ?',
          ...(workflowId ? ['e.workflow_id = ?'] : []),
          ...(!canAccessAll && !workflowId ? ['w.owner_principal_id = ?'] : []),
          ...(eventFilter.length > 0
            ? [`e.event_type IN (${eventFilter.map(() => '?').join(', ')})`]
            : []),
        ]
        return database.all(
          `SELECT e.* FROM workflow_events e
           ${!canAccessAll && !workflowId ? 'JOIN workflows w ON w.id = e.workflow_id' : ''}
           WHERE ${filters.join(' AND ')} ORDER BY e.sequence LIMIT ?`,
          cursor ?? 0,
          ...(workflowId ? [workflowId] : []),
          ...(!canAccessAll && !workflowId ? [principal.id] : []),
          ...eventFilter,
          bounded,
        )
      })
    },
  })
}

const normalizedFilter = (
  values: ReadonlyArray<string> | undefined,
  allowed?: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const result = [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))]
  if (allowed) {
    const unknown = result.find((value) => !allowed.includes(value))
    if (unknown) throw new Error(`unsupported filter value: ${unknown}`)
  }
  return result
}

const longPoll = async <A>(
  waitMs: number,
  context: ControlToolContext,
  read: () => ReadonlyArray<A>,
): Promise<ReadonlyArray<A>> => {
  const startedAt = Date.now()
  const deadline = startedAt + waitMs
  let nextProgressAt = startedAt + 5_000
  for (;;) {
    context.signal.throwIfAborted()
    const rows = read()
    if (rows.length > 0 || Date.now() >= deadline) return rows
    const now = Date.now()
    if (context.progressToken !== undefined && now >= nextProgressAt) {
      await context.notifyProgress({
        progress: now - startedAt,
        total: waitMs,
        message: 'Waiting for durable workflow activity',
      })
      nextProgressAt = now + 5_000
    }
    await abortableDelay(Math.min(100, Math.max(1, deadline - now)), context.signal)
  }
}

const abortableDelay = (milliseconds: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    const timer = setTimeout(done, milliseconds)
    signal.addEventListener('abort', aborted, { once: true })
    function done() {
      signal.removeEventListener('abort', aborted)
      resolve()
    }
    function aborted() {
      clearTimeout(timer)
      reject(signal.reason)
    }
  })
