import { DiscordOAuth, oauthTools, PrincipalStore, SecretStore } from '@discord-mcp/auth'
import {
  type AnyResourceDef,
  type AnyToolDef,
  type AuthenticationError,
  type Authorize,
  authorizeWithPrincipal,
  type McpRequest,
  Metrics,
  type Principal,
  type RegistrySelection,
  type Scope,
  type ToolGate,
  ValidationError,
} from '@discord-mcp/core'
import {
  AuthProfiles,
  apiTools,
  catalogResources,
  DiscordRest,
  guildGet,
  messageTools,
  OperationCatalog,
  operatorTools,
  PreviewTokens,
  permissionsExplain,
  RateGuard,
  templateTools,
} from '@discord-mcp/discord-api'
import { blueprintTools } from '@discord-mcp/discord-blueprints'
import { DiscordGateway, gatewayTools } from '@discord-mcp/discord-gateway'
import { AuditRepository, PersistenceLayer } from '@discord-mcp/persistence'
import { SupervisorClient } from '@discord-mcp/sandbox-supervisor'
import {
  CapabilityBroker,
  CapabilityServer,
  CapabilitySockets,
  diagnosticsTools,
  EventLog,
  RouteRegistry,
  SandboxSupervisor,
  WorkflowDispatcher,
  WorkflowQueues,
  WorkflowRepository,
  WorkflowRoutes,
  workflowResources,
  workflowTools,
} from '@discord-mcp/workflow-runtime'
import { Effect, Layer } from 'effect'
import type { ServerConfig } from './config.ts'
import { SandboxSupervisorLayer } from './sandbox-adapter.ts'

/** Every tool the process knows how to register, before toolset and gate selection. */
export const allTools: ReadonlyArray<AnyToolDef> = [
  guildGet,
  permissionsExplain,
  ...operatorTools,
  ...messageTools,
  ...blueprintTools,
  ...gatewayTools,
  ...templateTools,
  ...oauthTools,
  ...workflowTools,
  ...diagnosticsTools,
  ...apiTools,
]

/**
 * Read-only detail, addressed by URI.
 *
 * Registered unconditionally: a resource costs nothing until something reads it, and gating them
 * the way tools are gated would mean a link in a tool result could dangle.
 */
export const allResources: ReadonlyArray<AnyResourceDef> = [
  ...catalogResources,
  ...workflowResources,
]

/**
 * Stdio has no transport-level authentication: the client is a process the user started, on their
 * own machine, and it inherits their authority. It is therefore a local administrator principal.
 * Remote transports resolve a real principal in phase 6; the tool boundary is unchanged either way.
 */
const ALL_SCOPES: ReadonlyArray<Scope> = [
  'mcp:read',
  'mcp:write',
  'mcp:destructive',
  'bot:admin',
  'mentions:broad',
  'template:read',
  'template:write',
  'server:plan',
  'server:apply',
  'blob:write',
  'oauth:manage',
  'workflow:read',
  'workflow:write',
  'workflow:admin',
  'auth:admin',
  'audit:read',
]

export const stdioLocalPrincipal: Principal = {
  id: 'stdio-local',
  kind: 'stdio-local',
  scopes: new Set(ALL_SCOPES),
}

export const stdioAuthorize: Authorize = authorizeWithPrincipal((_request: McpRequest) =>
  Effect.succeed(stdioLocalPrincipal),
)

/**
 * Authorization over HTTP, where the principal came from a credential rather than from the fact
 * that someone could run the process.
 *
 * Identical scope checking either way: the transport decides *who*, never *what they may do*.
 */
export const httpAuthorize = (
  resolve: () => Effect.Effect<Principal, AuthenticationError>,
): Authorize => authorizeWithPrincipal(() => Effect.orDie(resolve()))

export const selectionFor = (config: ServerConfig): RegistrySelection => {
  // A gated tool is registered only when its subsystem exists. Hiding a tool the server cannot
  // honour is better than advertising one that always fails.
  const gates: ToolGate[] = ['always']
  if (config.gateway.mode !== 'off') gates.push('gateway')
  if (config.workflows.enabled) gates.push('workflows')

  return { toolsets: config.toolsets, enabledGates: new Set(gates) }
}

/**
 * The application layer. Every service a tool handler can require must be constructible from here,
 * which is what makes the union of handler `R` types a compile-time proof of completeness.
 */
/**
 * Resolve a named auth profile, consulting the stored Discord OAuth2 profiles.
 *
 * Lives here rather than in `discord-api` because the dependency would otherwise run backwards:
 * the catalog and dispatchers must not know about credential storage.
 */
const authProfilesLayer = Layer.effect(AuthProfiles)(
  Effect.map(DiscordOAuth, (oauth) => ({
    resolve: (name: string) =>
      name === 'bot'
        ? Effect.succeed({ name, kind: 'bot' as const })
        : Effect.flatMap(
            Effect.mapError(
              oauth.get(name),
              () =>
                new ValidationError({
                  message: `Could not read the OAuth2 profile "${name}".`,
                  issues: ['authProfile: local storage failed.'],
                }),
            ),
            (profile) =>
              profile === undefined || profile.revokedAt !== null
                ? Effect.fail(
                    new ValidationError({
                      message: `No usable OAuth2 profile named "${name}".`,
                      issues: [
                        'authProfile: list them with discord_oauth_profile_list, or create one with discord_oauth_profile_authorize.',
                      ],
                    }),
                  )
                : Effect.succeed({ name, kind: 'oauth2' as const }),
          ),
  })),
)

export const AppLayer = (config: ServerConfig) => {
  const rest = DiscordRest.layer(config.rest).pipe(Layer.provide(RateGuard.layer()))

  // A migration failure is fatal and an operator problem, so it becomes a defect with a readable
  // message rather than riding in the runtime's error channel, where every tool call would then
  // have to account for an error that can only happen once, at startup.
  const persistence = Layer.orDie(
    Layer.tapError(PersistenceLayer(config.databasePath), (cause) =>
      Effect.logError(
        `The database at ${config.databasePath} could not be opened or migrated during ${cause.operation}: ${cause.message} Check DATABASE_PATH, disk space, and file permissions.`,
      ),
    ),
  )

  const secrets = SecretStore.layer(config.masterKey).pipe(Layer.provide(persistence))
  const oauth =
    config.discordOAuth === undefined
      ? // No client credentials configured, so no profile can be authorized. The dispatcher still
        // refuses non-bot profiles by name, which is the same answer with a clearer reason.
        Layer.succeed(DiscordOAuth)({
          authorize: () => Effect.die(new Error('Discord OAuth2 is not configured.')),
          callback: () => Effect.die(new Error('Discord OAuth2 is not configured.')),
          list: () => Effect.succeed([]),
          get: () => Effect.succeed(undefined),
          accessToken: () => Effect.die(new Error('Discord OAuth2 is not configured.')),
          revoke: () => Effect.void,
        })
      : DiscordOAuth.layer(config.discordOAuth).pipe(
          Layer.provide(Layer.merge(secrets, persistence)),
        )

  // Workflows run arbitrary code, so they are off unless an operator turned them on and pointed at
  // a supervisor. When off, the tools are not registered at all and the port explains why rather
  // than failing obscurely at the first call.
  const sandbox = config.workflows.enabled
    ? SandboxSupervisorLayer.pipe(
        Layer.provide(
          SupervisorClient.layer({
            socketPath: config.workflows.supervisorSocket,
            serviceCredential: config.workflows.supervisorCredential,
            timeoutMs: config.workflows.supervisorTimeoutMs,
          }),
        ),
      )
    : SandboxSupervisor.unavailable(
        'Workflows are disabled. Set DISCORD_MCP_WORKFLOWS_ENABLED=true and configure DISCORD_MCP_SUPERVISOR_SOCKET to run them.',
      )

  const profiles = authProfilesLayer.pipe(Layer.provide(oauth))

  // The workflow subsystem, built as one block because its pieces only make sense together: the
  // broker decides, the capability server acts, the sockets carry, and the routes dispatch.
  //
  // `provideMerge` rather than `provide` so each piece stays visible to the application — the tool
  // handlers and the HTTP server both reach in here.
  const workflows = Layer.mergeAll(
    CapabilityBroker.layer,
    CapabilitySockets.layer({ directory: config.workflows.capabilityDirectory }),
    WorkflowRepository.layer,
    RouteRegistry.layer,
    WorkflowQueues.layer,
    AuditRepository.layer,
    EventLog.layer,
    sandbox,
    // Shares the REST client and catalog with the MCP tools, so a workflow's calls and an
    // operator's sit in one rate-limit view rather than two that each think they have the budget.
    CapabilityServer.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          CapabilityBroker.layer,
          OperationCatalog.layer,
          PreviewTokens.layer,
          rest,
          profiles,
          persistence,
        ),
      ),
    ),
  ).pipe(Layer.provideMerge(persistence), Layer.provideMerge(secrets))

  return Layer.mergeAll(
    rest,
    Metrics.layer,
    OperationCatalog.layer,
    WorkflowRoutes.layer.pipe(Layer.provide(workflows)),
    WorkflowDispatcher.layer.pipe(Layer.provide(workflows)),
    workflows,
    PreviewTokens.layer,
    // A misspelled intent is a configuration error, not a runtime one: Discord would close the
    // connection with 4013 and the server would look broken. Dying here names the variable.
    Layer.orDie(
      Layer.tapError(DiscordGateway.layer(config.gateway), (cause) =>
        Effect.logError(
          `DISCORD_MCP_GATEWAY_INTENTS is not usable: ${cause.message} ${cause.suggestion}`,
        ),
      ),
    ).pipe(Layer.provide(rest)),
    // Needed by the HTTP transport to turn a credential into a principal. Free to construct, so it
    // is always present rather than conditional on the transport.
    PrincipalStore.layer.pipe(Layer.provide(persistence)),
    secrets,
    oauth,
    profiles,
    persistence,
  )
}
