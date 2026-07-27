import { isValidCidr } from '@discord-mcp/auth'
import { Config, ConfigProvider, Effect, Option, Schema } from 'effect'

export interface HttpConfig {
  readonly host: string
  readonly port: number
  readonly publicBaseUrl?: string
  readonly allowedHosts: ReadonlyArray<string>
  readonly trustedProxyCidrs: ReadonlyArray<string>
  readonly trustProxyIdentity: boolean
  readonly proxyIdentityHeader?: string
  readonly proxyGroupsHeader?: string
}

export class ConfigurationError extends Schema.TaggedErrorClass<ConfigurationError>()(
  'ConfigurationError',
  { message: Schema.String },
) {
  constructor(message: string) {
    super({ message })
  }
}

const loopback = (host: string): boolean =>
  host === 'localhost' || host === '::1' || host.startsWith('127.')

export const validateHttpConfig = (config: HttpConfig): HttpConfig => {
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65_535) {
    throw new ConfigurationError('MCP_HTTP_PORT must be a valid TCP port')
  }
  if (config.trustProxyIdentity && config.trustedProxyCidrs.length === 0) {
    throw new ConfigurationError('TRUSTED_PROXY_CIDRS is required when proxy identity is enabled')
  }
  for (const [name, value] of [
    ['TRUST_PROXY_IDENTITY_HEADER', config.proxyIdentityHeader ?? 'x-forwarded-user'],
    ['TRUST_PROXY_GROUPS_HEADER', config.proxyGroupsHeader ?? 'x-forwarded-groups'],
  ] as const) {
    if (!/^[a-z0-9-]+$/.test(value)) {
      throw new ConfigurationError(`${name} must be a lowercase HTTP header name`)
    }
  }
  let publicUrl: URL | undefined
  if (config.publicBaseUrl !== undefined) {
    try {
      publicUrl = new URL(config.publicBaseUrl)
    } catch {
      throw new ConfigurationError('PUBLIC_BASE_URL must be a valid URL')
    }
    if (
      publicUrl.username ||
      publicUrl.password ||
      publicUrl.pathname !== '/' ||
      publicUrl.search ||
      publicUrl.hash
    ) {
      throw new ConfigurationError(
        'PUBLIC_BASE_URL must be an origin without credentials or a path',
      )
    }
  }
  const publiclyExposed = !loopback(config.host)
  if (publiclyExposed || config.trustProxyIdentity) {
    if (!publicUrl) {
      throw new ConfigurationError('PUBLIC_BASE_URL is required for non-loopback HTTP exposure')
    }
    if (publicUrl.protocol !== 'https:') {
      throw new ConfigurationError('PUBLIC_BASE_URL must use HTTPS for non-loopback exposure')
    }
    if (config.allowedHosts.length === 0) {
      throw new ConfigurationError('ALLOWED_HOSTS is required for non-loopback HTTP exposure')
    }
    if (!config.allowedHosts.includes(publicUrl.hostname)) {
      throw new ConfigurationError('ALLOWED_HOSTS must include the PUBLIC_BASE_URL hostname')
    }
  }
  for (const host of config.allowedHosts) {
    if (!validHost(host))
      throw new ConfigurationError(`ALLOWED_HOSTS contains invalid host: ${host}`)
  }
  for (const cidr of config.trustedProxyCidrs) {
    if (!isValidCidr(cidr)) {
      throw new ConfigurationError(`TRUSTED_PROXY_CIDRS contains invalid CIDR: ${cidr}`)
    }
  }
  return publicUrl === undefined ? config : { ...config, publicBaseUrl: publicUrl.origin }
}

const validHost = (host: string): boolean => {
  if (
    !host ||
    host !== host.trim() ||
    host.includes('://') ||
    host.includes('/') ||
    host.includes('@')
  ) {
    return false
  }
  try {
    const parsed = new URL(`https://${host}`)
    return parsed.hostname === host || `[${parsed.hostname}]` === host
  } catch {
    return false
  }
}

const commaSeparated = (value: string): ReadonlyArray<string> =>
  value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)

const HttpEnvironmentConfig = Config.all({
  bind: Config.all({
    host: Config.string('HOST').pipe(Config.withDefault('127.0.0.1')),
    port: Config.int('PORT').pipe(Config.withDefault(3000)),
  }).pipe(Config.nested('MCP_HTTP')),
  publicBaseUrl: Config.option(Config.string('PUBLIC_BASE_URL')).pipe(
    Config.map(Option.getOrUndefined),
  ),
  allowedHosts: Config.string('ALLOWED_HOSTS').pipe(
    Config.withDefault(''),
    Config.map(commaSeparated),
  ),
  trustedProxyCidrs: Config.string('TRUSTED_PROXY_CIDRS').pipe(
    Config.withDefault(''),
    Config.map(commaSeparated),
  ),
  trustProxyIdentity: Config.boolean('TRUST_PROXY_IDENTITY').pipe(Config.withDefault(false)),
  proxyIdentityHeader: Config.string('TRUST_PROXY_IDENTITY_HEADER').pipe(
    Config.withDefault('x-forwarded-user'),
  ),
  proxyGroupsHeader: Config.string('TRUST_PROXY_GROUPS_HEADER').pipe(
    Config.withDefault('x-forwarded-groups'),
  ),
}).pipe(
  Config.map(
    ({
      bind,
      publicBaseUrl,
      allowedHosts,
      trustedProxyCidrs,
      trustProxyIdentity,
      proxyIdentityHeader,
      proxyGroupsHeader,
    }): HttpConfig => ({
      ...bind,
      ...(publicBaseUrl === undefined ? {} : { publicBaseUrl }),
      allowedHosts,
      trustedProxyCidrs,
      trustProxyIdentity,
      proxyIdentityHeader,
      proxyGroupsHeader,
    }),
  ),
)

export const configFromEnvironment = (
  environment: Readonly<Record<string, string | undefined>>,
): HttpConfig => {
  const env = Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  )
  return validateHttpConfig(
    Effect.runSync(HttpEnvironmentConfig.parse(ConfigProvider.fromEnv({ env }))),
  )
}
