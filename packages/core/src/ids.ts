import { Schema } from 'effect'

/**
 * Discord snowflake. Validated as a decimal string, never a number: API v8+ snowflakes exceed
 * 2^53 and would lose precision as a JS number.
 */
export const Snowflake = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^\d{17,21}$/, { title: 'snowflake' })),
).annotate({
  title: 'Snowflake',
  description: 'A Discord ID: 17-21 decimal digits, always a string.',
  examples: ['123456789012345678'],
})
export type Snowflake = typeof Snowflake.Type

/** Local scopes. Distinct from Discord permissions and from Discord OAuth2 scopes. */
export const Scope = Schema.Literals([
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
])
export type Scope = typeof Scope.Type

/** Owned by the published catalog, which classifies every operation with them. */
export { AuthMode, RiskClass } from '@mia-cx/discord-catalog'
