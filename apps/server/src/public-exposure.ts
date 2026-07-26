import { ConfigurationError } from '@discord-mcp/core'
import { Effect } from 'effect'

/**
 * Refuse to start in a configuration that is unsafe to expose.
 *
 * This process holds a bot token and can delete channels. Binding it to a public interface without
 * TLS, a host allowlist, and a defined proxy relationship is not a degraded mode — it is a
 * credential handed to whoever finds the port. Failing at startup with the offending variable named
 * is the only response that cannot be ignored.
 */

export interface ExposureConfig {
  readonly bindHost: string
  readonly publicBaseUrl: string | undefined
  readonly allowedHosts: ReadonlyArray<string>
  readonly trustProxyIdentity: boolean
  readonly trustedProxyCidrs: ReadonlyArray<string>
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1'])

export const isLoopbackBind = (host: string): boolean => LOOPBACK.has(host)

export const checkPublicExposure = (
  config: ExposureConfig,
): Effect.Effect<void, ConfigurationError> => {
  // A loopback bind is reachable only from the host, so none of the rest applies.
  if (isLoopbackBind(config.bindHost)) return Effect.void

  const fail = (variable: string, message: string) =>
    Effect.fail(new ConfigurationError({ variable, message }))

  if (config.publicBaseUrl === undefined) {
    return fail(
      'PUBLIC_BASE_URL',
      `MCP_HTTP_HOST is ${config.bindHost}, which is not loopback, but PUBLIC_BASE_URL is unset. Set it to the HTTPS URL clients reach this server on, or bind to 127.0.0.1 and put a proxy in front.`,
    )
  }

  if (!config.publicBaseUrl.startsWith('https://')) {
    return fail(
      'PUBLIC_BASE_URL',
      `Non-loopback exposure requires HTTPS, but PUBLIC_BASE_URL is "${config.publicBaseUrl}". This process holds a bot token; serving it over plaintext would put that token on the wire.`,
    )
  }

  if (config.allowedHosts.length === 0) {
    return fail(
      'ALLOWED_HOSTS',
      'Non-loopback exposure requires a non-empty ALLOWED_HOSTS. Without it, this server answers to any Host header, which makes DNS-rebinding attacks trivial.',
    )
  }

  // Enabling forwarded identity without saying which proxies to believe means believing everyone.
  if (config.trustProxyIdentity && config.trustedProxyCidrs.length === 0) {
    return fail(
      'TRUSTED_PROXY_CIDRS',
      'TRUST_PROXY_IDENTITY is enabled but TRUSTED_PROXY_CIDRS is empty. That combination would let any client assert any identity. Set the proxy CIDRs, or disable forwarded identity.',
    )
  }

  return Effect.void
}
