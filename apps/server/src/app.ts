import { PrincipalStore } from '@discord-mcp/auth'
import {
  type AnyToolDef,
  type AuthenticationError,
  type Authorize,
  authorizeWithPrincipal,
  type McpRequest,
  type Principal,
  type RegistrySelection,
  type Scope,
  type ToolGate,
} from '@discord-mcp/core'
import {
  apiTools,
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
import { PersistenceLayer } from '@discord-mcp/persistence'
import { Effect, Layer } from 'effect'
import type { ServerConfig } from './config.ts'

/** Every tool the process knows how to register, before toolset and gate selection. */
export const allTools: ReadonlyArray<AnyToolDef> = [
  guildGet,
  permissionsExplain,
  ...operatorTools,
  ...messageTools,
  ...blueprintTools,
  ...gatewayTools,
  ...templateTools,
  ...apiTools,
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

export const selectionFor = (config: ServerConfig): RegistrySelection => ({
  toolsets: config.toolsets,
  // A gated tool is registered only when its subsystem exists. Hiding a tool the server cannot
  // honour is better than advertising one that always fails.
  enabledGates: new Set<ToolGate>(
    config.gateway.mode === 'off' ? ['always'] : ['always', 'gateway'],
  ),
})

/**
 * The application layer. Every service a tool handler can require must be constructible from here,
 * which is what makes the union of handler `R` types a compile-time proof of completeness.
 */
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

  return Layer.mergeAll(
    rest,
    OperationCatalog.layer,
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
    persistence,
  )
}
