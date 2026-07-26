import {
  type AnyToolDef,
  type Authorize,
  authorizeWithPrincipal,
  type McpRequest,
  type Principal,
  type RegistrySelection,
  type Scope,
} from '@discord-mcp/core'
import {
  apiTools,
  DiscordRest,
  guildGet,
  messageTools,
  OperationCatalog,
  PreviewTokens,
  permissionsExplain,
  RateGuard,
  templateTools,
} from '@discord-mcp/discord-api'
import { blueprintTools } from '@discord-mcp/discord-blueprints'
import { PersistenceLayer } from '@discord-mcp/persistence'
import { Effect, Layer } from 'effect'
import type { ServerConfig } from './config.ts'

/** Every tool the process knows how to register, before toolset and gate selection. */
export const allTools: ReadonlyArray<AnyToolDef> = [
  guildGet,
  permissionsExplain,
  ...messageTools,
  ...blueprintTools,
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

export const selectionFor = (config: ServerConfig): RegistrySelection => ({
  toolsets: config.toolsets,
  // Gateway and workflows arrive in phases 5 and 9; their tools stay unregistered until then.
  enabledGates: new Set(['always'] as const),
})

/**
 * The application layer. Every service a tool handler can require must be constructible from here,
 * which is what makes the union of handler `R` types a compile-time proof of completeness.
 */
export const AppLayer = (config: ServerConfig) =>
  Layer.mergeAll(
    DiscordRest.layer(config.rest).pipe(Layer.provide(RateGuard.layer())),
    OperationCatalog.layer,
    PreviewTokens.layer,
    // A migration failure is fatal and an operator problem, so it becomes a defect with a readable
    // message rather than riding in the runtime's error channel, where every tool call would then
    // have to account for an error that can only happen once, at startup.
    Layer.orDie(
      Layer.tapError(PersistenceLayer(config.databasePath), (cause) =>
        Effect.logError(
          `The database at ${config.databasePath} could not be opened or migrated during ${cause.operation}: ${cause.message} Check DATABASE_PATH, disk space, and file permissions.`,
        ),
      ),
    ),
  )
