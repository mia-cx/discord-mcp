import { describe, expect, it } from 'vitest'
import { configFromEnvironment, validateHttpConfig } from './config.js'

describe('safe HTTP configuration', () => {
  it('allows loopback defaults', () => {
    expect(
      validateHttpConfig({
        host: '127.0.0.1',
        port: 3000,
        allowedHosts: [],
        trustedProxyCidrs: [],
        trustProxyIdentity: false,
      }).host,
    ).toBe('127.0.0.1')
  })

  it('rejects unsafe public exposure and incomplete proxy trust', () => {
    expect(() =>
      validateHttpConfig({
        host: '0.0.0.0',
        port: 3000,
        publicBaseUrl: 'http://discord.example.test',
        allowedHosts: ['discord.example.test'],
        trustedProxyCidrs: [],
        trustProxyIdentity: false,
      }),
    ).toThrow(/HTTPS/)
    expect(() =>
      validateHttpConfig({
        host: '127.0.0.1',
        port: 3000,
        allowedHosts: [],
        trustedProxyCidrs: [],
        trustProxyIdentity: true,
      }),
    ).toThrow(/TRUSTED_PROXY_CIDRS/)
  })

  it('validates public origins, allowed hosts, and trusted proxy CIDRs at startup', () => {
    expect(() =>
      validateHttpConfig({
        host: '0.0.0.0',
        port: 3000,
        publicBaseUrl: 'https://discord.example.test/base',
        allowedHosts: ['discord.example.test'],
        trustedProxyCidrs: ['10.0.0.0/8'],
        trustProxyIdentity: false,
      }),
    ).toThrow(/origin/)
    expect(() =>
      validateHttpConfig({
        host: '0.0.0.0',
        port: 3000,
        publicBaseUrl: 'https://discord.example.test',
        allowedHosts: ['other.example.test'],
        trustedProxyCidrs: ['10.0.0.0/8'],
        trustProxyIdentity: false,
      }),
    ).toThrow(/PUBLIC_BASE_URL hostname/)
    expect(() =>
      validateHttpConfig({
        host: '0.0.0.0',
        port: 3000,
        publicBaseUrl: 'https://discord.example.test',
        allowedHosts: ['discord.example.test'],
        trustedProxyCidrs: ['not-a-cidr'],
        trustProxyIdentity: false,
      }),
    ).toThrow(/invalid CIDR/)
    expect(
      validateHttpConfig({
        host: '0.0.0.0',
        port: 3000,
        publicBaseUrl: 'https://discord.example.test/',
        allowedHosts: ['discord.example.test'],
        trustedProxyCidrs: ['10.0.0.0/8'],
        trustProxyIdentity: false,
      }).publicBaseUrl,
    ).toBe('https://discord.example.test')
  })

  it('decodes nested HTTP settings through Effect Config and rejects non-integer ports', () => {
    expect(
      configFromEnvironment({
        MCP_HTTP_HOST: '127.0.0.2',
        MCP_HTTP_PORT: '4321',
        ALLOWED_HOSTS: 'one.example.test, two.example.test',
        TRUSTED_PROXY_CIDRS: '10.0.0.0/8,2001:db8::/32',
        TRUST_PROXY_IDENTITY: 'false',
      }),
    ).toEqual({
      host: '127.0.0.2',
      port: 4321,
      allowedHosts: ['one.example.test', 'two.example.test'],
      trustedProxyCidrs: ['10.0.0.0/8', '2001:db8::/32'],
      trustProxyIdentity: false,
      proxyIdentityHeader: 'x-forwarded-user',
      proxyGroupsHeader: 'x-forwarded-groups',
    })
    expect(() =>
      configFromEnvironment({
        MCP_HTTP_PORT: '3000.5',
      }),
    ).toThrow(/MCP_HTTP.*PORT/s)
  })
})
