import { createHash, randomBytes } from 'node:crypto'
import process from 'node:process'
import {
  DiscordOAuthHttpClient,
  DiscordOAuthProfiles,
  OidcVerifier,
  PersonalAccessTokens,
  TokenEncryption,
  TrustedProxyAuthentication,
} from '@discord-mcp/auth'
import {
  DiscordApiError,
  DiscordDispatcher,
  DiscordRestClient,
  discordJsTransport,
  RateGuard,
} from '@discord-mcp/discord-api'
import {
  assertGatewayEventIntents,
  DiscordJsGatewayAdapter,
  GatewayEventStore,
  GatewayLifecycle,
  parseGatewayIntents,
} from '@discord-mcp/discord-gateway'
import { BlobStore, Database } from '@discord-mcp/persistence'
import {
  CapabilityBroker,
  type EnabledWorkflow,
  SupervisorClient,
  SupervisorWorkflowBuilder,
  WorkflowRouteRegistry,
  WorkflowRuntimeManager,
  WorkflowStore,
} from '@discord-mcp/workflow-runtime'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { Config, Effect, Redacted } from 'effect'
import { CapabilityRpcServer, startCapabilitySocket } from './capability-server.js'
import { configFromEnvironment } from './config.js'
import { startHttpServer } from './http.js'
import { assertCommandPublishingGranted } from './interactions/command-policy.js'
import { InteractionHandler } from './interactions/handler.js'
import { persistComponentEvent, resolveInteractionTarget } from './interactions/routing.js'
import { workflowInteractionCallback } from './interactions/workflow-response.js'
import { AuditLog, MetricsRegistry, RetentionManager, writeStructuredLog } from './observability.js'
import { buildToolServer } from './tool-surface.js'

const token = (() => {
  try {
    return Redacted.value(Effect.runSync(Config.redacted('DISCORD_TOKEN')))
  } catch {
    return ''
  }
})()
if (token.length === 0) {
  writeStructuredLog({
    level: 'error',
    event: 'configuration.failure',
    outcome: 'failure',
    detail: { error: 'ConfigurationError: DISCORD_TOKEN is required' },
  })
  process.exitCode = 1
} else {
  const metrics = new MetricsRegistry()
  metrics.initialize([
    'discord_mcp_discord_requests_total',
    'discord_mcp_discord_request_duration_milliseconds_count',
    'discord_mcp_discord_request_duration_milliseconds_sum',
    'discord_mcp_rate_limit_wait_milliseconds_count',
    'discord_mcp_rate_limit_wait_milliseconds_sum',
    'discord_mcp_discord_retry_wait_milliseconds_count',
    'discord_mcp_discord_retry_wait_milliseconds_sum',
    'discord_mcp_rate_guard_trips_total',
    'discord_mcp_gateway_reconnects_total',
    'discord_mcp_interaction_deadlines_total',
    'discord_mcp_interaction_defers_total',
    'discord_mcp_workflow_queue_depth',
    'discord_mcp_workflow_duration_milliseconds_count',
    'discord_mcp_workflow_duration_milliseconds_sum',
    'discord_mcp_workflow_failures_total',
    'discord_mcp_workflow_timeouts_total',
    'discord_mcp_workflow_kills_total',
    'discord_mcp_blueprint_apply_total',
    'discord_mcp_blueprint_apply_duration_milliseconds_count',
    'discord_mcp_blueprint_apply_duration_milliseconds_sum',
    'discord_mcp_sandbox_build_duration_milliseconds_count',
    'discord_mcp_sandbox_build_duration_milliseconds_sum',
    'discord_mcp_sandbox_build_failures_total',
    'discord_mcp_route_auth_failures_total',
    'discord_mcp_oauth_refresh_failures_total',
  ])
  const discordTransport = discordJsTransport(token, 'Bot', {
    timeoutMs: Number(process.env.DISCORD_MCP_REST_TIMEOUT_MS ?? 15_000),
    globalRequestsPerSecond: Number(process.env.DISCORD_MCP_REST_GLOBAL_RPS ?? 50),
    maxRateLimitWaitMs: Number(process.env.DISCORD_MCP_REST_MAX_RATELIMIT_WAIT_MS ?? 30_000),
    onRateLimited: ({ route, timeToReset }) => {
      metrics.observe('discord_mcp_rate_limit_wait_milliseconds', timeToReset, { route })
    },
  })
  const rest = new DiscordRestClient(
    discordTransport,
    new RateGuard({
      threshold: Number(process.env.DISCORD_MCP_REST_DENY_THRESHOLD ?? 25),
    }),
    'bot',
    Number(process.env.DISCORD_MCP_REST_RETRIES ?? 2),
    {
      requestFinished: ({ family, method, status, durationMs, outcome }) => {
        metrics.increment('discord_mcp_discord_requests_total', {
          family,
          method,
          status,
          outcome,
        })
        metrics.observe('discord_mcp_discord_request_duration_milliseconds', durationMs, {
          family,
          method,
          outcome,
        })
      },
      retryWait: ({ family, method, durationMs }) => {
        metrics.observe('discord_mcp_discord_retry_wait_milliseconds', durationMs, {
          family,
          method,
        })
      },
      rateGuardTripped: ({ profile, family }) => {
        metrics.increment('discord_mcp_rate_guard_trips_total', { profile, family })
      },
    },
  )
  const database = new Database(
    process.env.DATABASE_PATH ?? process.env.DISCORD_MCP_DATABASE ?? 'data/discord-mcp.sqlite',
  )
  database.migrate()
  const tokenEncryption =
    process.env.DISCORD_MCP_MASTER_KEY === undefined
      ? undefined
      : new TokenEncryption(process.env.DISCORD_MCP_MASTER_KEY)
  const gatewayEvents = new GatewayEventStore(
    database,
    Number(process.env.DISCORD_MCP_GATEWAY_BUFFER_SIZE ?? 10_000),
    Number(process.env.DISCORD_MCP_GATEWAY_MAX_WAIT_MS ?? 120_000),
  )
  const audit = new AuditLog(database)
  const retention = new RetentionManager(database)
  retention.start()
  const blobs = new BlobStore(
    database,
    process.env.DISCORD_MCP_BLOB_DIR ?? 'data/blobs',
    25 * 1024 * 1024,
    Number(process.env.DISCORD_MCP_BLOB_QUOTA_BYTES ?? 250 * 1024 * 1024),
  )
  const supervisorCredential = process.env.DISCORD_MCP_SUPERVISOR_CREDENTIAL?.trim() || undefined
  const supervisorClient =
    supervisorCredential === undefined
      ? undefined
      : new SupervisorClient(
          process.env.SUPERVISOR_SOCKET ?? '/run/discord-mcp/supervisor.sock',
          supervisorCredential,
          {
            requestFinished: ({
              action,
              workflowId,
              revision,
              outcome,
              durationMs,
              errorTag,
              errorMessage,
            }) => {
              if (action === 'inspect' && outcome === 'success') return
              audit.record({
                action: `sandbox.supervisor.${action}`,
                targetType: 'workflow',
                ...(workflowId === undefined ? {} : { targetId: workflowId }),
                detail: {
                  revision,
                  durationMs,
                  errorTag,
                  errorMessage,
                },
                outcome,
              })
            },
          },
        )
  const workflowBuilder =
    supervisorClient === undefined
      ? {
          build: async () => {
            throw new Error(
              'workflow sandbox is unavailable; configure DISCORD_MCP_SUPERVISOR_CREDENTIAL',
            )
          },
        }
      : new SupervisorWorkflowBuilder(
          supervisorClient,
          process.env.DISCORD_MCP_ARTIFACT_DIR ?? 'data/artifacts',
          {
            buildFinished: ({ workflowId, revision, outcome, durationMs }) => {
              metrics.observe('discord_mcp_sandbox_build_duration_milliseconds', durationMs, {
                workflowId,
                revision: String(revision),
                outcome,
              })
              if (outcome === 'failure') {
                metrics.increment('discord_mcp_sandbox_build_failures_total', {
                  workflowId,
                  revision: String(revision),
                })
              }
            },
          },
        )
  const workflows = new WorkflowStore(database, workflowBuilder)
  const blueprintPreviewKey = createHash('sha256')
    .update(
      process.env.DISCORD_MCP_MASTER_KEY ??
        process.env.DISCORD_MCP_PREVIEW_SECRET ??
        randomBytes(32),
    )
    .digest()
  const selectedToolsets = new Set(
    (process.env.DISCORD_MCP_TOOLSETS ?? 'operator,automation,api')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  )
  for (const toolset of selectedToolsets) {
    if (
      toolset !== 'operator' &&
      toolset !== 'automation' &&
      toolset !== 'admin' &&
      toolset !== 'api'
    ) {
      throw new Error(`unknown DISCORD_MCP_TOOLSETS value: ${toolset}`)
    }
  }
  const toolsets = selectedToolsets as Set<'operator' | 'automation' | 'admin' | 'api'>
  let applicationId = process.env.DISCORD_APPLICATION_ID
  let applicationIdRequest: Promise<string> | undefined
  const ensureApplicationId = (): Promise<string> => {
    if (applicationId) return Promise.resolve(applicationId)
    if (applicationIdRequest) return applicationIdRequest
    applicationIdRequest = Effect.runPromise(
      rest.request<{ readonly id: string }>('GET', '/applications/@me'),
    )
      .then(({ id }) => {
        if (!/^\d{17,21}$/.test(id)) throw new Error('Discord application response has no valid id')
        applicationId = id
        return id
      })
      .catch((cause) => {
        applicationIdRequest = undefined
        throw cause
      })
    return applicationIdRequest
  }
  let oauthProfiles: DiscordOAuthProfiles | undefined
  const gatewayMode = process.env.DISCORD_MCP_GATEWAY_MODE ?? 'lazy'
  if (gatewayMode !== 'off' && gatewayMode !== 'lazy' && gatewayMode !== 'eager') {
    throw new Error('DISCORD_MCP_GATEWAY_MODE must be off, lazy, or eager')
  }
  const configuredGatewayIntents = parseGatewayIntents(
    process.env.DISCORD_MCP_GATEWAY_INTENTS ?? 'Guilds',
  )
  const gateway = new GatewayLifecycle(
    gatewayMode,
    new DiscordJsGatewayAdapter(
      token,
      configuredGatewayIntents,
      gatewayEvents,
      (diagnostic) => {
        if (diagnostic.kind === 'closed') {
          metrics.increment('discord_mcp_gateway_reconnects_total', {
            ...(diagnostic.shardId === undefined ? {} : { shardId: String(diagnostic.shardId) }),
          })
        }
        writeStructuredLog({
          level: diagnostic.level === 'error' ? 'error' : 'info',
          event: `gateway.${diagnostic.kind}`,
          detail: {
            message: diagnostic.message,
            ...(diagnostic.shardId === undefined ? {} : { shardId: diagnostic.shardId }),
          },
        })
      },
      discordTransport.rest,
      (entityIds) => {
        if (entityIds.length === 0) return undefined
        const row = database.get<{
          execution_id: string
          correlation_id: string
          causal_depth: number
        }>(
          `SELECT execution_id, correlation_id, causal_depth
           FROM workflow_action_causality
           WHERE discord_entity_id IN (${entityIds.map(() => '?').join(', ')})
           ORDER BY created_at DESC LIMIT 1`,
          ...entityIds,
        )
        return row
          ? {
              correlationId: row.correlation_id,
              causationId: row.execution_id,
              causalDepth: row.causal_depth,
            }
          : undefined
      },
    ),
  )
  const shutdownTasks: Array<() => Promise<void> | void> = [
    () => gateway.close(),
    () => retention.close(),
    () => database.close(),
  ]

  const start = async () => {
    if (process.env.DISCORD_CLIENT_SECRET && tokenEncryption && process.env.PUBLIC_BASE_URL) {
      const resolvedApplicationId = await ensureApplicationId()
      oauthProfiles = new DiscordOAuthProfiles(
        database,
        tokenEncryption,
        new DiscordOAuthHttpClient(resolvedApplicationId, process.env.DISCORD_CLIENT_SECRET),
        resolvedApplicationId,
        new URL('/oauth/discord/callback', process.env.PUBLIC_BASE_URL).toString(),
        {
          refreshFailed: ({ profileId }) => {
            metrics.increment('discord_mcp_oauth_refresh_failures_total', { profileId })
          },
        },
      )
    }
    let runtime: WorkflowRuntimeManager | undefined
    let workflowRoutes: WorkflowRouteRegistry | undefined
    if (supervisorClient) {
      const broker = new CapabilityBroker(database)
      const activeOAuthProfiles = oauthProfiles
      const dispatcher = new DiscordDispatcher(
        rest,
        undefined,
        {
          read: async (blobId, principalId) => {
            const metadata = blobs.getMetadata(blobId, principalId)
            return {
              data: await blobs.readForDiscord(blobId),
              filename: metadata.filename,
              contentType: metadata.mimeType,
            }
          },
        },
        activeOAuthProfiles === undefined
          ? undefined
          : {
              resolve: async (profileId, principalId, authMode) => {
                if (authMode !== 'oauth2') {
                  throw new Error('named profiles require oauth2 authMode')
                }
                return new DiscordRestClient(
                  discordJsTransport(
                    await activeOAuthProfiles.accessToken(profileId, principalId),
                    'Bearer',
                  ),
                  rest.rateGuard,
                  profileId,
                )
              },
            },
      )
      const capabilitySocketPath =
        process.env.DISCORD_MCP_CAPABILITY_SOCKET ?? '/run/discord-mcp/capability.sock'
      const capabilitySocket = await startCapabilitySocket(
        capabilitySocketPath,
        new CapabilityRpcServer(database, broker, dispatcher),
      )
      shutdownTasks.unshift(
        () =>
          new Promise<void>((resolve, reject) =>
            capabilitySocket.close((error) => (error ? reject(error) : resolve())),
          ),
      )
      let routes: WorkflowRouteRegistry | undefined
      const registerRoutes = async (enabled: EnabledWorkflow) => {
        if (!routes) return
        const manifest = JSON.parse(enabled.manifest_json) as {
          readonly triggers: ReadonlyArray<Record<string, unknown>>
        }
        const grant = JSON.parse(enabled.grants_json) as {
          readonly routes: {
            readonly public: boolean
            readonly allowedHosts: ReadonlyArray<string>
            readonly allowedOrigins: ReadonlyArray<string>
            readonly allowedSourceCidrs: ReadonlyArray<string>
            readonly maxBodyBytes: number
          }
          readonly interactions: {
            readonly guildCommandPublishing: boolean
            readonly globalCommandPublishing: boolean
          }
          readonly discord: {
            readonly guildIds: ReadonlyArray<string>
          }
        }
        assertGatewayEventIntents(
          manifest.triggers.flatMap((trigger) =>
            trigger.type === 'gateway' && Array.isArray(trigger.eventTypes)
              ? trigger.eventTypes.filter((value): value is string => typeof value === 'string')
              : [],
          ),
          configuredGatewayIntents,
        )
        for (const trigger of manifest.triggers) {
          if (
            trigger.type !== 'http' ||
            typeof trigger.method !== 'string' ||
            typeof trigger.path !== 'string' ||
            typeof trigger.auth !== 'object' ||
            trigger.auth === null
          ) {
            continue
          }
          routes.register({
            workflowId: enabled.id,
            revision: enabled.revision,
            method: trigger.method,
            path: trigger.path,
            policy: {
              authentication: trigger.auth as Parameters<
                WorkflowRouteRegistry['register']
              >[0]['policy']['authentication'],
              allowedHosts: grant.routes.allowedHosts,
              allowedOrigins: grant.routes.allowedOrigins,
              allowedSourceCidrs: grant.routes.allowedSourceCidrs,
              maxBodyBytes: grant.routes.maxBodyBytes,
              ...(typeof trigger.requestSchema === 'object' && trigger.requestSchema !== null
                ? {
                    requestSchema: trigger.requestSchema as Readonly<Record<string, unknown>>,
                  }
                : {}),
            },
            publicRouteGranted: grant.routes.public,
          })
        }
        const developmentGuilds = (process.env.DISCORD_MCP_DEVELOPMENT_GUILDS ?? '')
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean)
        const commandApplicationId = await ensureApplicationId()
        for (const trigger of manifest.triggers) {
          if (trigger.type !== 'interactionCommand' || typeof trigger.name !== 'string') {
            continue
          }
          const commandType =
            trigger.commandType === 'user' ? 2 : trigger.commandType === 'message' ? 3 : 1
          if (commandType === 1 && typeof trigger.description !== 'string') {
            throw new Error(`chat-input command ${trigger.name} requires a description`)
          }
          assertCommandPublishingGranted(trigger.global === true, grant.interactions, trigger.name)
          const targets =
            trigger.global === true
              ? [{ key: 'global', route: `/applications/${commandApplicationId}/commands` }]
              : [...new Set([...grant.discord.guildIds, ...developmentGuilds])].map((guildId) => ({
                  key: guildId,
                  route: `/applications/${commandApplicationId}/guilds/${guildId}/commands`,
                }))
          if (trigger.global !== true && targets.length === 0) {
            throw new Error(
              `guild command ${trigger.name} has no granted or development guild target`,
            )
          }
          for (const target of targets) {
            const collision = database.get<{ workflow_id: string }>(
              `SELECT c.workflow_id FROM workflow_commands c
               JOIN workflows w ON w.id = c.workflow_id AND w.enabled_revision = c.revision
               WHERE c.command_key = ? AND c.command_type = ? AND c.guild_id = ?
               AND c.workflow_id != ? AND w.deleted_at IS NULL`,
              trigger.name,
              commandType,
              target.key,
              enabled.id,
            )
            if (collision) {
              throw new Error(
                `command ${trigger.name} type ${commandType} in ${target.key} is already owned by workflow ${collision.workflow_id}`,
              )
            }
            const existing = database.get<{ discord_command_id: string | null }>(
              `SELECT discord_command_id FROM workflow_commands
               WHERE workflow_id = ? AND revision = ? AND command_key = ?
               AND command_type = ? AND guild_id = ?`,
              enabled.id,
              enabled.revision,
              trigger.name,
              commandType,
              target.key,
            )
            if (existing?.discord_command_id) continue
            const command = await Effect.runPromise(
              rest.request<Record<string, unknown>>('POST', target.route, {
                body: {
                  name: trigger.name,
                  type: commandType,
                  ...(commandType === 1 ? { description: trigger.description } : {}),
                  ...(Array.isArray(trigger.options) ? { options: trigger.options } : {}),
                  ...(Array.isArray(trigger.contexts) ? { contexts: trigger.contexts } : {}),
                  ...(Array.isArray(trigger.integrationTypes)
                    ? { integration_types: trigger.integrationTypes }
                    : {}),
                },
              }),
            )
            database.run(
              `INSERT INTO workflow_commands
               (workflow_id, revision, command_key, command_type, discord_command_id, guild_id)
               VALUES (?, ?, ?, ?, ?, ?)`,
              enabled.id,
              enabled.revision,
              trigger.name,
              commandType,
              String(command.id),
              target.key,
            )
          }
        }
      }
      const unregisterRevision = async (workflowId: string, revision: number) => {
        const commands = database.all<{
          command_key: string
          discord_command_id: string | null
          guild_id: string | null
        }>(
          `SELECT command_key, discord_command_id, guild_id FROM workflow_commands
           WHERE workflow_id = ? AND revision = ?`,
          workflowId,
          revision,
        )
        const commandApplicationId = commands.some(
          ({ discord_command_id }) => discord_command_id !== null,
        )
          ? await ensureApplicationId()
          : undefined
        for (const command of commands) {
          if (!command.discord_command_id || !commandApplicationId) continue
          const route =
            command.guild_id === 'global' || command.guild_id === null
              ? `/applications/${commandApplicationId}/commands/${command.discord_command_id}`
              : `/applications/${commandApplicationId}/guilds/${command.guild_id}/commands/${command.discord_command_id}`
          await Effect.runPromise(rest.request('DELETE', route)).catch((cause: unknown) => {
            if (!(cause instanceof DiscordApiError) || cause.status !== 404) throw cause
          })
        }
        database.transaction(() => {
          database.run(
            'DELETE FROM workflow_commands WHERE workflow_id = ? AND revision = ?',
            workflowId,
            revision,
          )
          database.run(
            'DELETE FROM workflow_routes WHERE workflow_id = ? AND revision = ?',
            workflowId,
            revision,
          )
        })
      }
      runtime = new WorkflowRuntimeManager(
        database,
        supervisorClient,
        broker,
        process.env.DISCORD_MCP_RUNNER_SOCKET_ROOT ?? '/run/discord-mcp/runners',
        registerRoutes,
        unregisterRevision,
        {
          queueDepth: ({ workflowId, depth }) => {
            metrics.gauge('discord_mcp_workflow_queue_depth', depth, { workflowId })
          },
          executionFinished: ({ workflowId, revision, outcome, durationMs }) => {
            metrics.observe('discord_mcp_workflow_duration_milliseconds', durationMs, {
              workflowId,
              revision: String(revision),
              outcome,
            })
            if (outcome === 'failed') {
              metrics.increment('discord_mcp_workflow_failures_total', {
                workflowId,
                revision: String(revision),
              })
            } else if (outcome === 'timed_out') {
              metrics.increment('discord_mcp_workflow_timeouts_total', {
                workflowId,
                revision: String(revision),
              })
            }
          },
          runnerKilled: ({ workflowId, revision, reason }) => {
            metrics.increment('discord_mcp_workflow_kills_total', {
              workflowId,
              revision: String(revision),
              reason,
            })
          },
        },
      )
      routes = new WorkflowRouteRegistry(
        database,
        {
          resolve: async (reference, workflowId) => {
            if (!tokenEncryption) throw new Error('route secrets require DISCORD_MCP_MASTER_KEY')
            const row = database.get<{ id: string; ciphertext: Uint8Array }>(
              `SELECT s.id, s.ciphertext FROM encrypted_secrets s
               JOIN workflows w ON w.owner_principal_id = s.owner_principal_id
               WHERE w.id = ? AND s.name = ?`,
              workflowId,
              reference,
            )
            if (!row) throw new Error(`route secret ${reference} does not exist`)
            return tokenEncryption.decrypt(row.ciphertext, `secret:${row.id}`)
          },
        },
        {
          invoke: async (input) => {
            if (!runtime) throw new Error('workflow runtime is unavailable')
            const execution = await runtime.invoke({
              workflowId: input.workflowId,
              triggerType: 'http',
              triggerKey: input.relativePath,
              input: {
                method: input.method,
                path: input.relativePath,
                headers: input.headers,
                body: Buffer.from(input.rawBody).toString('base64'),
              },
            })
            if (
              typeof execution.result !== 'object' ||
              execution.result === null ||
              typeof (execution.result as { status?: unknown }).status !== 'number'
            ) {
              throw new Error('HTTP workflow must return an Http response')
            }
            return execution.result as {
              readonly status: number
              readonly headers?: Readonly<Record<string, string>>
              readonly body?: string
            }
          },
        },
        undefined,
        {
          authenticationFailed: ({ workflowId, authenticationType }) => {
            metrics.increment('discord_mcp_route_auth_failures_total', {
              workflowId,
              authenticationType,
            })
          },
        },
      )
      workflowRoutes = routes
      await runtime.start()
      shutdownTasks.unshift(() => runtime?.close())
      const unsubscribeGateway = gatewayEvents.subscribe((event) => {
        if (!runtime) return
        const enabled = database.all<{
          id: string
          manifest_json: string
          grants_json: string
        }>(
          `SELECT w.id, r.manifest_json, g.grants_json FROM workflows w
           JOIN workflow_revisions r ON r.workflow_id = w.id
           AND r.revision = w.enabled_revision
           JOIN workflow_grants g ON g.workflow_id = w.id
           AND g.revision = w.enabled_revision
           WHERE w.enabled_revision IS NOT NULL AND w.deleted_at IS NULL`,
        )
        for (const workflow of enabled) {
          const manifest = JSON.parse(workflow.manifest_json) as {
            readonly triggers: ReadonlyArray<Record<string, unknown>>
          }
          const grant = JSON.parse(workflow.grants_json) as {
            readonly gateway: {
              readonly eventTypes: ReadonlyArray<string>
              readonly includeBotAuthoredEvents: boolean
            }
          }
          const matching = manifest.triggers.some(
            (trigger) =>
              trigger.type === 'gateway' &&
              Array.isArray(trigger.eventTypes) &&
              trigger.eventTypes.includes(event.eventType),
          )
          if (!matching || !grant.gateway.eventTypes.includes(event.eventType)) continue
          if (!grant.gateway.includeBotAuthoredEvents && gatewayEventIsBotAuthored(event.payload)) {
            continue
          }
          void runtime
            .invoke({
              workflowId: workflow.id,
              triggerType: 'gateway',
              triggerKey: event.eventType,
              input: event,
              correlationId: event.correlationId,
              ...(event.causationId === undefined ? {} : { causationId: event.causationId }),
              causalDepth: event.causalDepth,
            })
            .catch(() => undefined)
        }
      })
      shutdownTasks.unshift(unsubscribeGateway)
    }
    if (gateway.mode === 'eager') await gateway.ensureConnected()
    if ((process.env.MCP_TRANSPORT ?? 'stdio') === 'http') {
      const httpConfig = configFromEnvironment(process.env)
      const oidc =
        process.env.OIDC_ISSUER && process.env.OIDC_AUDIENCE && process.env.OIDC_JWKS_URI
          ? new OidcVerifier(
              process.env.OIDC_ISSUER,
              process.env.OIDC_AUDIENCE,
              process.env.OIDC_JWKS_URI,
            )
          : undefined
      const proxy = httpConfig.trustProxyIdentity
        ? new TrustedProxyAuthentication(
            database,
            httpConfig.trustedProxyCidrs,
            httpConfig.proxyIdentityHeader,
            httpConfig.proxyGroupsHeader,
          )
        : undefined
      const interactions =
        process.env.DISCORD_PUBLIC_KEY === undefined
          ? undefined
          : new InteractionHandler(
              database,
              process.env.DISCORD_PUBLIC_KEY,
              {
                dispatch: async (interaction, binding) => {
                  if (!runtime) throw new Error('workflow runtime is unavailable')
                  const target = resolveInteractionTarget(database, interaction, binding)
                  if (target.kind === 'event') {
                    persistComponentEvent(database, interaction, target)
                    return { type: 6 }
                  }
                  const execution = await runtime.invoke({
                    workflowId: target.workflowId,
                    triggerType: target.triggerType,
                    triggerKey: target.triggerKey,
                    input: interaction,
                    correlationId: interaction.id,
                  })
                  const revision =
                    database.get<{ enabled_revision: number }>(
                      'SELECT enabled_revision FROM workflows WHERE id = ?',
                      target.workflowId,
                    )?.enabled_revision ?? 0
                  return workflowInteractionCallback(execution.result, {
                    database,
                    workflowId: target.workflowId,
                    revision,
                  })
                },
              },
              undefined,
              2_500,
              {
                complete: async (interaction, callback) => {
                  if (!interaction.token) throw new Error('interaction follow-up token is missing')
                  if (callback.type !== 4 && callback.type !== 7) {
                    throw new Error('deferred interaction must complete with a message callback')
                  }
                  await Effect.runPromise(
                    rest.request(
                      'PATCH',
                      `/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`,
                      { body: callback.data ?? {}, auth: false },
                    ),
                  )
                },
              },
              {
                deferred: ({ interactionType }) => {
                  metrics.increment('discord_mcp_interaction_defers_total', {
                    interactionType: String(interactionType),
                  })
                },
                deadlineReached: ({ interactionType }) => {
                  metrics.increment('discord_mcp_interaction_deadlines_total', {
                    interactionType: String(interactionType),
                  })
                },
              },
            )
      const http = await startHttpServer({
        config: httpConfig,
        rest,
        authentication: {
          pats: new PersonalAccessTokens(database),
          ...(oidc === undefined ? {} : { oidc }),
          ...(proxy === undefined ? {} : { proxy }),
        },
        gatewayEvents,
        gateway,
        database,
        blobs,
        workflows,
        ...(oauthProfiles === undefined ? {} : { oauthProfiles }),
        blueprintPreviewKey,
        ...(tokenEncryption === undefined ? {} : { secretEncryption: tokenEncryption }),
        audit,
        metrics,
        toolsets,
        ...(runtime === undefined ? {} : { workflowRuntime: runtime }),
        ...(workflowRoutes === undefined ? {} : { workflowRoutes }),
        ...(interactions === undefined ? {} : { interactions }),
        maximumResponseBytes: Number(process.env.DISCORD_MCP_MAX_RESPONSE_BYTES ?? 25_000),
      })
      shutdownTasks.unshift(
        () =>
          new Promise<void>((resolve, reject) =>
            http.close((error) => (error ? reject(error) : resolve())),
          ),
      )
      return
    }
    const handle = serveStdio(
      () =>
        buildToolServer({
          rest,
          gatewayEvents,
          gateway,
          database,
          blobs,
          workflows,
          ...(oauthProfiles === undefined ? {} : { oauthProfiles }),
          blueprintPreviewKey,
          ...(tokenEncryption === undefined ? {} : { secretEncryption: tokenEncryption }),
          audit,
          metrics,
          toolsets,
          ...(runtime === undefined ? {} : { workflowRuntime: runtime }),
          maximumResponseBytes: Number(process.env.DISCORD_MCP_MAX_RESPONSE_BYTES ?? 25_000),
        }),
      {
        onerror: (error) =>
          writeStructuredLog({
            level: 'error',
            event: 'mcp.transport.error',
            outcome: 'failure',
            detail: { error: error.message, errorType: error.name },
          }),
      },
    )
    shutdownTasks.unshift(() => handle.close())
  }

  let shuttingDown = false
  const shutdown = (exitCode: number) => {
    if (shuttingDown) return
    shuttingDown = true
    void Promise.allSettled(shutdownTasks.map((task) => task())).then(() => {
      process.exitCode = exitCode
    })
  }
  process.once('SIGINT', () => shutdown(0))
  process.once('SIGTERM', () => shutdown(0))
  void start().catch((error: unknown) => {
    writeStructuredLog({
      level: 'error',
      event: 'server.start.failure',
      outcome: 'failure',
      detail: {
        error: error instanceof Error ? error.message : String(error),
        ...(error instanceof Error ? { errorType: error.name } : {}),
      },
    })
    shutdown(1)
  })
}

const gatewayEventIsBotAuthored = (payload: unknown): boolean => {
  if (typeof payload !== 'object' || payload === null) return false
  const data = (payload as { readonly data?: unknown }).data
  if (typeof data !== 'object' || data === null) return false
  const author = (data as { readonly author?: unknown }).author
  if (typeof author === 'object' && author !== null) {
    return (author as { readonly bot?: unknown }).bot === true
  }
  const member = (data as { readonly member?: unknown }).member
  if (typeof member === 'object' && member !== null) {
    const user = (member as { readonly user?: unknown }).user
    return (
      typeof user === 'object' && user !== null && (user as { readonly bot?: unknown }).bot === true
    )
  }
  return false
}
