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
  readonly toolsets: ReadonlySet<Toolset>
  readonly rest: typeof restConfig extends Config.Config<infer A> ? A : never
}

const raw = Config.all({
  transport: Config.string('MCP_TRANSPORT').pipe(Config.withDefault('stdio')),
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

    return {
      transport: decoded.transport,
      toolsets: new Set(decoded.toolsets as ReadonlyArray<Toolset>),
      rest: decoded.rest,
    }
  },
)
