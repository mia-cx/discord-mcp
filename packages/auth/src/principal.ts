import { Schema } from 'effect'

export const scopes = [
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
] as const

export type Scope = (typeof scopes)[number]

export interface Principal {
  readonly id: string
  readonly name: string
  readonly kind: 'local' | 'oidc' | 'pat' | 'proxy' | 'workflow'
  readonly scopes: ReadonlySet<Scope>
  readonly expiresAt?: number
}

export class AuthenticationError extends Schema.TaggedErrorClass<AuthenticationError>()(
  'AuthenticationError',
  { message: Schema.String },
) {
  constructor(message: string) {
    super({ message })
  }
}

export class AuthorizationError extends Schema.TaggedErrorClass<AuthorizationError>()(
  'AuthorizationError',
  {
    message: Schema.String,
    principalId: Schema.String,
    missingScopes: Schema.Array(Schema.Union(scopes.map(Schema.Literal))),
  },
) {
  constructor(
    readonly principalId: string,
    readonly missingScopes: ReadonlyArray<Scope>,
  ) {
    super({
      message: `Principal ${principalId} is missing scopes: ${missingScopes.join(', ')}`,
      principalId,
      missingScopes,
    })
  }
}

export const requireScopes = (principal: Principal, required: ReadonlyArray<Scope>): Principal => {
  if (principal.expiresAt !== undefined && principal.expiresAt <= Date.now()) {
    throw new AuthenticationError('principal credential expired')
  }
  const missing = required.filter((scope) => !principal.scopes.has(scope))
  if (missing.length > 0) throw new AuthorizationError(principal.id, missing)
  return principal
}

export const localAdministrator = (): Principal => ({
  id: 'local-administrator',
  name: 'Local administrator',
  kind: 'local',
  scopes: new Set(scopes),
})
