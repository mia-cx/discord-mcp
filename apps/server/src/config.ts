import type { Toolset } from '@discord-mcp/core'
import { ConfigurationError } from '@discord-mcp/core'
import { restConfig } from '@discord-mcp/discord-api'
import { Config, Effect, SchemaIssue } from 'effect'

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
  readonly gateway: {
    readonly mode: 'off' | 'lazy' | 'eager'
    readonly intents: ReadonlyArray<string>
    readonly bufferSize: number
    readonly maxWaitMs: number
  }
  readonly toolsets: ReadonlySet<Toolset>
  readonly rest: typeof restConfig extends Config.Config<infer A> ? A : never
}

const raw = Config.all({
  transport: Config.string('MCP_TRANSPORT').pipe(Config.withDefault('stdio')),
  databasePath: Config.string('DATABASE_PATH').pipe(Config.withDefault('./discord-mcp.sqlite')),
  // lazy by default: REST-only operation opens no WebSocket, so the common case pays nothing.
  gatewayMode: Config.string('DISCORD_MCP_GATEWAY_MODE').pipe(Config.withDefault('lazy')),
  // Privileged intents are absent by default; Discord refuses the connection outright for one
  // that is not enabled in the Developer Portal.
  gatewayIntents: Config.string('DISCORD_MCP_GATEWAY_INTENTS').pipe(
    Config.withDefault('Guilds,GuildMessages'),
  ),
  gatewayBufferSize: Config.int('DISCORD_MCP_GATEWAY_BUFFER_SIZE').pipe(Config.withDefault(1000)),
  gatewayMaxWaitMs: Config.int('DISCORD_MCP_GATEWAY_MAX_WAIT_MS').pipe(Config.withDefault(120_000)),
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

    return {
      transport: decoded.transport,
      databasePath: decoded.databasePath,
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
