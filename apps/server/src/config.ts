import { randomBytes } from 'node:crypto'
import { decodeMasterKey } from '@discord-mcp/auth'
import type { Toolset } from '@discord-mcp/core'
import { ConfigurationError } from '@discord-mcp/core'
import { restConfig } from '@discord-mcp/discord-api'
import { Config, Effect, Redacted, SchemaIssue } from 'effect'
import { checkPublicExposure } from './public-exposure.ts'

const ALL_TOOLSETS: ReadonlyArray<Toolset> = ['operator', 'automation', 'admin', 'api']

const toolsets = Config.string('DISCORD_MCP_TOOLSETS').pipe(
  Config.withDefault('operator,automation,api'),
  Config.map((raw) =>
    raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  ),
)

/**
 * Name the environment variable that actually failed.
 *
 * `ConfigError.name` is the constant `"ConfigError"`; the variable lives in the wrapped schema
 * issue's path. An operator staring at a failed container start needs the variable, not the class.
 */
const toConfigurationError = (cause: Config.ConfigError): ConfigurationError => {
  const inner = cause.cause
  if (inner._tag === 'SchemaError') {
    const [first] = SchemaIssue.makeFormatterStandardSchemaV1()(inner.issue).issues
    const path = first?.path
    if (path !== undefined && path.length > 0) {
      return new ConfigurationError({
        variable: path.map(String).join('.'),
        message: first?.message ?? cause.message,
      })
    }
  }
  return new ConfigurationError({ variable: '(unknown)', message: cause.message })
}

export interface ServerConfig {
  readonly transport: 'stdio' | 'http'
  readonly databasePath: string
  readonly http: {
    readonly host: string
    readonly port: number
    readonly publicBaseUrl: string | undefined
    readonly allowedHosts: ReadonlyArray<string>
    readonly trustProxyIdentity: boolean
    readonly trustedProxyCidrs: ReadonlyArray<string>
  }
  /** Application public key, hex. Without it, interaction signatures cannot be verified. */
  readonly discordPublicKey: string | undefined
  /** 32 bytes. Encrypts stored OAuth2 tokens and route secrets. */
  readonly masterKey: Buffer
  readonly discordOAuth:
    | {
        readonly clientId: string
        readonly clientSecret: Redacted.Redacted<string>
        readonly redirectUri: string
      }
    | undefined
  readonly oidc:
    | { readonly issuer: string; readonly audience: string; readonly jwksUri: string }
    | undefined
  readonly gateway: {
    readonly mode: 'off' | 'lazy' | 'eager'
    readonly intents: ReadonlyArray<string>
    readonly bufferSize: number
    readonly maxWaitMs: number
  }
  readonly workflows: {
    /**
     * Off by default. Workflows execute arbitrary code, so enabling them is a decision an operator
     * makes deliberately, not one they inherit from a default.
     */
    readonly enabled: boolean
    readonly supervisorSocket: string
    readonly supervisorCredential: string
    readonly supervisorTimeoutMs: number
    /**
     * Where this process sees the shared capability volume. Workflow containers mount the same
     * volume, each restricted to its own execution's subdirectory.
     */
    readonly capabilityDirectory: string
  }
  readonly toolsets: ReadonlySet<Toolset>
  readonly rest: typeof restConfig extends Config.Config<infer A> ? A : never
}

const raw = Config.all({
  transport: Config.string('MCP_TRANSPORT').pipe(Config.withDefault('stdio')),
  databasePath: Config.string('DATABASE_PATH').pipe(Config.withDefault('./discord-mcp.sqlite')),
  // lazy by default: REST-only operation opens no WebSocket, so the common case pays nothing.
  // Defaults to loopback. This process holds a bot token, so the safe bind is the one that is
  // only reachable from the host.
  httpHost: Config.string('MCP_HTTP_HOST').pipe(Config.withDefault('127.0.0.1')),
  httpPort: Config.int('MCP_HTTP_PORT').pipe(Config.withDefault(3000)),
  publicBaseUrl: Config.string('PUBLIC_BASE_URL').pipe(Config.withDefault('')),
  allowedHosts: Config.string('ALLOWED_HOSTS').pipe(Config.withDefault('')),
  trustProxyIdentity: Config.boolean('TRUST_PROXY_IDENTITY').pipe(Config.withDefault(false)),
  trustedProxyCidrs: Config.string('TRUSTED_PROXY_CIDRS').pipe(Config.withDefault('')),
  // Optional so a stdio-only deployment that stores no secrets needs no key; a random one is
  // generated instead, and nothing durable is encrypted under it.
  masterKey: Config.string('DISCORD_MCP_MASTER_KEY').pipe(Config.withDefault('')),
  discordPublicKey: Config.string('DISCORD_PUBLIC_KEY').pipe(Config.withDefault('')),
  discordClientId: Config.string('DISCORD_APPLICATION_ID').pipe(Config.withDefault('')),
  discordClientSecret: Config.string('DISCORD_CLIENT_SECRET').pipe(Config.withDefault('')),
  oidcIssuer: Config.string('OIDC_ISSUER').pipe(Config.withDefault('')),
  oidcAudience: Config.string('OIDC_AUDIENCE').pipe(Config.withDefault('')),
  oidcJwksUri: Config.string('OIDC_JWKS_URI').pipe(Config.withDefault('')),
  gatewayMode: Config.string('DISCORD_MCP_GATEWAY_MODE').pipe(Config.withDefault('lazy')),
  // Privileged intents are absent by default; Discord refuses the connection outright for one
  // that is not enabled in the Developer Portal.
  gatewayIntents: Config.string('DISCORD_MCP_GATEWAY_INTENTS').pipe(
    Config.withDefault('Guilds,GuildMessages'),
  ),
  gatewayBufferSize: Config.int('DISCORD_MCP_GATEWAY_BUFFER_SIZE').pipe(Config.withDefault(1000)),
  gatewayMaxWaitMs: Config.int('DISCORD_MCP_GATEWAY_MAX_WAIT_MS').pipe(Config.withDefault(120_000)),
  workflowsEnabled: Config.boolean('DISCORD_MCP_WORKFLOWS_ENABLED').pipe(Config.withDefault(false)),
  supervisorSocket: Config.string('DISCORD_MCP_SUPERVISOR_SOCKET').pipe(
    Config.withDefault('/run/discord-mcp/supervisor.sock'),
  ),
  supervisorCredential: Config.string('DISCORD_MCP_SUPERVISOR_CREDENTIAL').pipe(
    Config.withDefault(''),
  ),
  // Generous: a build resolves arbitrary npm, and a five-minute install is slow rather than broken.
  supervisorTimeoutMs: Config.int('DISCORD_MCP_SUPERVISOR_TIMEOUT_MS').pipe(
    Config.withDefault(360_000),
  ),
  capabilityDirectory: Config.string('DISCORD_MCP_CAPABILITY_DIR').pipe(
    Config.withDefault('/run/discord-mcp/capability'),
  ),
  toolsets,
  rest: restConfig,
})

/**
 * Decode configuration, failing with a `ConfigurationError` that names the offending variable.
 *
 * `NodeRuntime.runMain` prints the failure and exits non-zero, so a misconfigured deployment stops
 * at startup rather than at the first tool call.
 */
export const loadServerConfig: Effect.Effect<ServerConfig, ConfigurationError> = Effect.gen(
  function* () {
    const decoded = yield* Effect.mapError(raw, toConfigurationError)

    if (decoded.transport !== 'stdio' && decoded.transport !== 'http') {
      return yield* Effect.fail(
        new ConfigurationError({
          variable: 'MCP_TRANSPORT',
          message: `Expected "stdio" or "http", got "${decoded.transport}".`,
        }),
      )
    }

    const unknown = decoded.toolsets.filter((t) => !ALL_TOOLSETS.includes(t as Toolset))
    if (unknown.length > 0) {
      return yield* Effect.fail(
        new ConfigurationError({
          variable: 'DISCORD_MCP_TOOLSETS',
          message: `Unknown toolset(s): ${unknown.join(', ')}. Valid values are ${ALL_TOOLSETS.join(', ')}.`,
        }),
      )
    }

    const gatewayModes = ['off', 'lazy', 'eager'] as const
    if (!gatewayModes.includes(decoded.gatewayMode as (typeof gatewayModes)[number])) {
      return yield* Effect.fail(
        new ConfigurationError({
          variable: 'DISCORD_MCP_GATEWAY_MODE',
          message: `Expected one of ${gatewayModes.join(', ')}, got "${decoded.gatewayMode}".`,
        }),
      )
    }

    const csv = (value: string) =>
      value
        .split(',')
        .map((v) => v.trim())
        .filter((v) => v.length > 0)

    const http = {
      host: decoded.httpHost,
      port: decoded.httpPort,
      publicBaseUrl: decoded.publicBaseUrl === '' ? undefined : decoded.publicBaseUrl,
      allowedHosts: csv(decoded.allowedHosts),
      trustProxyIdentity: decoded.trustProxyIdentity,
      trustedProxyCidrs: csv(decoded.trustedProxyCidrs),
    }

    // Refuse to start in a configuration that is unsafe to expose, before anything binds.
    //
    // Only for the HTTP transport: stdio binds nothing, so its HTTP settings describe a server
    // that never exists. Checking them anyway would block a stdio deployment over a port it is
    // not going to open — which is exactly what happens in a container image that sets a bind
    // host for the HTTP case.
    if (decoded.transport === 'http') {
      yield* checkPublicExposure({
        bindHost: http.host,
        publicBaseUrl: http.publicBaseUrl,
        allowedHosts: http.allowedHosts,
        trustProxyIdentity: http.trustProxyIdentity,
        trustedProxyCidrs: http.trustedProxyCidrs,
      })
    }

    // All three or none: a partial OIDC configuration would verify tokens against defaults
    // nobody chose, which is worse than not verifying at all.
    const oidcParts = [decoded.oidcIssuer, decoded.oidcAudience, decoded.oidcJwksUri]
    const oidcSet = oidcParts.filter((v) => v !== '').length
    if (oidcSet > 0 && oidcSet < 3) {
      return yield* Effect.fail(
        new ConfigurationError({
          variable: 'OIDC_ISSUER / OIDC_AUDIENCE / OIDC_JWKS_URI',
          message:
            'Set all three or none. A partial OIDC configuration would validate tokens against values nobody chose.',
        }),
      )
    }

    const masterKey =
      decoded.masterKey === ''
        ? // Ephemeral. Anything encrypted under it is unreadable after a restart, which is correct:
          // an operator who never set a key never intended durable secrets.
          randomBytes(32)
        : yield* decodeMasterKey(Redacted.make(decoded.masterKey))

    if (decoded.workflowsEnabled && decoded.supervisorCredential === '') {
      return yield* Effect.fail(
        new ConfigurationError({
          variable: 'DISCORD_MCP_SUPERVISOR_CREDENTIAL',
          message:
            'Workflows are enabled but no supervisor credential is set. The credential is what stops any local process from driving the sandbox supervisor; it must match the supervisor’s own.',
        }),
      )
    }

    const oauthConfigured = decoded.discordClientId !== '' && decoded.discordClientSecret !== ''
    if (decoded.discordClientSecret !== '' && decoded.discordClientId === '') {
      return yield* Effect.fail(
        new ConfigurationError({
          variable: 'DISCORD_APPLICATION_ID',
          message:
            'DISCORD_CLIENT_SECRET is set but DISCORD_APPLICATION_ID is not. Both are needed to authorize an OAuth2 profile.',
        }),
      )
    }

    return {
      transport: decoded.transport,
      databasePath: decoded.databasePath,
      masterKey,
      discordPublicKey: decoded.discordPublicKey === '' ? undefined : decoded.discordPublicKey,
      discordOAuth: oauthConfigured
        ? {
            clientId: decoded.discordClientId,
            clientSecret: Redacted.make(decoded.discordClientSecret),
            redirectUri: `${http.publicBaseUrl ?? `http://${http.host}:${http.port}`}/oauth/discord/callback`,
          }
        : undefined,
      http,
      oidc:
        oidcSet === 3
          ? {
              issuer: decoded.oidcIssuer,
              audience: decoded.oidcAudience,
              jwksUri: decoded.oidcJwksUri,
            }
          : undefined,
      workflows: {
        enabled: decoded.workflowsEnabled,
        supervisorSocket: decoded.supervisorSocket,
        supervisorCredential: decoded.supervisorCredential,
        supervisorTimeoutMs: decoded.supervisorTimeoutMs,
        capabilityDirectory: decoded.capabilityDirectory,
      },
      gateway: {
        mode: decoded.gatewayMode as 'off' | 'lazy' | 'eager',
        intents: decoded.gatewayIntents
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0),
        bufferSize: decoded.gatewayBufferSize,
        maxWaitMs: decoded.gatewayMaxWaitMs,
      },
      toolsets: new Set(decoded.toolsets as ReadonlyArray<Toolset>),
      rest: decoded.rest,
    }
  },
)
