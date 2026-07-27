import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose'
import { AuthenticationError, type Principal, type Scope, scopes } from './principal.js'

export class OidcVerifier {
  readonly #jwks: ReturnType<typeof createRemoteJWKSet>

  constructor(
    readonly issuer: string,
    readonly audience: string,
    jwksUrl: string,
    options: {
      readonly cooldownDuration?: number
      readonly fetch?: typeof fetch
    } = {},
  ) {
    this.#jwks = createRemoteJWKSet(new URL(jwksUrl), {
      cooldownDuration: options.cooldownDuration ?? 30_000,
      ...(options.fetch === undefined ? {} : { [customFetch]: options.fetch }),
    })
  }

  async verify(token: string): Promise<Principal> {
    try {
      const { payload } = await jwtVerify(token, this.#jwks, {
        issuer: this.issuer,
        audience: this.audience,
      })
      if (!payload.sub || payload.exp === undefined) throw new Error('sub and exp are required')
      const rawScopes =
        typeof payload.scope === 'string'
          ? payload.scope.split(' ')
          : Array.isArray(payload.scopes)
            ? payload.scopes
            : []
      const verifiedScopes = rawScopes
        .filter((scope): scope is string => typeof scope === 'string')
        .filter((scope): scope is Scope => scopes.includes(scope as Scope))
      return {
        id: `oidc:${payload.sub}`,
        name: typeof payload.name === 'string' ? payload.name : payload.sub,
        kind: 'oidc',
        scopes: new Set(verifiedScopes),
        expiresAt: payload.exp * 1_000,
      }
    } catch {
      throw new AuthenticationError('invalid OIDC access token')
    }
  }
}
