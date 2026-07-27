import { exportJWK, generateKeyPair, type JWK, SignJWT } from 'jose'
import { describe, expect, it } from 'vitest'
import { OidcVerifier } from './oidc.js'

const issuer = 'https://identity.example.test'
const audience = 'https://discord-mcp.example.test/mcp'

type PrivateKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey']

const key = async (
  kid: string,
): Promise<{ readonly privateKey: PrivateKey; readonly jwk: JWK }> => {
  const pair = await generateKeyPair('RS256')
  return {
    privateKey: pair.privateKey,
    jwk: { ...(await exportJWK(pair.publicKey)), kid, alg: 'RS256', use: 'sig' },
  }
}

const sign = (
  privateKey: PrivateKey,
  kid: string,
  input: {
    readonly tokenIssuer?: string
    readonly tokenAudience?: string
    readonly expiresAt?: number
  } = {},
): Promise<string> =>
  new SignJWT({ scope: 'mcp:read unknown:scope', name: 'OIDC operator' })
    .setProtectedHeader({ alg: 'RS256', kid })
    .setSubject('subject-123')
    .setIssuer(input.tokenIssuer ?? issuer)
    .setAudience(input.tokenAudience ?? audience)
    .setIssuedAt()
    .setExpirationTime(input.expiresAt ?? Math.floor(Date.now() / 1_000) + 300)
    .sign(privateKey)

const jwksServer = (
  current: () => ReadonlyArray<JWK>,
): {
  readonly url: string
  readonly fetch: typeof fetch
  readonly requests: () => number
} => {
  let requests = 0
  return {
    url: 'https://identity.example.test/jwks',
    fetch: (async () => {
      requests += 1
      return new Response(JSON.stringify({ keys: current() }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'cache-control': 'no-store',
        },
      })
    }) as typeof fetch,
    requests: () => requests,
  }
}

describe('OIDC access-token verification', () => {
  it('validates signature, issuer, audience, expiry, and known scopes', async () => {
    const signing = await key('primary')
    const endpoint = jwksServer(() => [signing.jwk])
    const verifier = new OidcVerifier(issuer, audience, endpoint.url, { fetch: endpoint.fetch })
    const principal = await verifier.verify(await sign(signing.privateKey, 'primary'))
    expect(principal).toMatchObject({
      id: 'oidc:subject-123',
      name: 'OIDC operator',
      kind: 'oidc',
    })
    expect([...principal.scopes]).toEqual(['mcp:read'])
    expect(principal.expiresAt).toBeGreaterThan(Date.now())

    await expect(
      verifier.verify(
        await sign(signing.privateKey, 'primary', {
          tokenIssuer: 'https://attacker.example.test',
        }),
      ),
    ).rejects.toThrow(/invalid OIDC/)
    await expect(
      verifier.verify(
        await sign(signing.privateKey, 'primary', {
          tokenAudience: 'https://other.example.test',
        }),
      ),
    ).rejects.toThrow(/invalid OIDC/)
    await expect(
      verifier.verify(
        await sign(signing.privateKey, 'primary', {
          expiresAt: Math.floor(Date.now() / 1_000) - 1,
        }),
      ),
    ).rejects.toThrow(/invalid OIDC/)
  })

  it('refreshes JWKS for a newly rotated signing key', async () => {
    const first = await key('first')
    const second = await key('second')
    let published: ReadonlyArray<JWK> = [first.jwk]
    const endpoint = jwksServer(() => published)
    const verifier = new OidcVerifier(issuer, audience, endpoint.url, {
      cooldownDuration: 0,
      fetch: endpoint.fetch,
    })
    await verifier.verify(await sign(first.privateKey, 'first'))
    published = [second.jwk]
    await expect(verifier.verify(await sign(second.privateKey, 'second'))).resolves.toMatchObject({
      id: 'oidc:subject-123',
    })
    expect(endpoint.requests()).toBeGreaterThanOrEqual(2)
  })

  it('rejects a token signed by an untrusted key', async () => {
    const trusted = await key('trusted')
    const attacker = await key('attacker')
    const endpoint = jwksServer(() => [trusted.jwk])
    const verifier = new OidcVerifier(issuer, audience, endpoint.url, {
      cooldownDuration: 0,
      fetch: endpoint.fetch,
    })
    await expect(verifier.verify(await sign(attacker.privateKey, 'attacker'))).rejects.toThrow(
      /invalid OIDC/,
    )
  })
})
