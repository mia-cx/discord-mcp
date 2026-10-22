import type {
  AuthMode,
  HttpMethod,
  OperationFamily,
  PaginationStyle,
  RiskClass,
} from '../src/types.ts'

/**
 * Risk, family, and pagination are derived from the operation, not hand-listed, so a new upstream
 * operation is classified the moment it appears rather than silently defaulting.
 *
 * Where derivation would be wrong, `vendor/discord/overrides.json` corrects it with a stated
 * reason. `spec:check` fails if any operation ends up unclassified.
 */

/** Operations whose method understates what they do. */
const DESTRUCTIVE_OPERATIONS = new Set([
  'bulk_delete_messages',
  'bulk_ban_users_from_guild',
  'ban_user_from_guild',
  'prune_guild',
  'delete_all_message_reactions',
  'delete_all_message_reactions_by_emoji',
  'bulk_set_application_commands',
  'bulk_set_guild_application_commands',
  'bulk_update_guild_channels',
  'bulk_update_guild_roles',
])

/**
 * Bot identity, application metadata, command registration, and privileged configuration.
 * Reaching these needs `bot:admin`, so misclassifying one downward is a real escalation.
 */
const BOT_ADMIN_PATTERNS: ReadonlyArray<RegExp> = [
  /^\/applications\/\{application_id\}$/,
  /^\/applications\/\{application_id\}\/(commands|emojis|role-connections|attachment)/,
  /^\/applications\/\{application_id\}\/guilds\/\{guild_id\}\/commands/,
  /^\/applications\/@me/,
  /^\/users\/@me$/,
]

/** OAuth token exchange, refresh, and revocation. Never exposed as a tool at all. */
const CREDENTIAL_PATTERNS: ReadonlyArray<RegExp> = [
  /^\/oauth2\/token/,
  /^\/oauth2\/applications\/@me/,
  /^\/partner-sdk\//,
]

export const classifyRisk = (operationId: string, method: HttpMethod, path: string): RiskClass => {
  if (CREDENTIAL_PATTERNS.some((p) => p.test(path))) return 'credential'
  if (DESTRUCTIVE_OPERATIONS.has(operationId)) return 'destructive'

  const botAdmin = BOT_ADMIN_PATTERNS.some((p) => p.test(path))
  if (method === 'GET') return botAdmin && path === '/users/@me' ? 'read' : 'read'
  if (method === 'DELETE') return botAdmin ? 'bot_admin' : 'destructive'
  if (botAdmin) return 'bot_admin'
  return 'write'
}

/** Ordered: the first pattern to match wins, so specific paths precede general ones. */
const FAMILY_PATTERNS: ReadonlyArray<readonly [RegExp, OperationFamily]> = [
  [/^\/interactions\//, 'interaction'],
  [/^\/webhooks\//, 'webhook'],
  [/^\/oauth2\//, 'oauth'],
  [/^\/gateway/, 'gateway'],
  [/^\/lobbies/, 'lobby'],
  [/^\/stage-instances/, 'stage'],
  [/^\/invites/, 'invite'],
  [/^\/sticker-packs|\/stickers/, 'sticker'],
  [/^\/soundboard-default-sounds|\/soundboard-sounds/, 'soundboard'],
  [/\/auto-moderation\//, 'automod'],
  [/\/audit-log/, 'audit'],
  [/\/scheduled-events/, 'scheduled-event'],
  [/\/polls\//, 'poll'],
  [/\/thread-members|\/threads/, 'thread'],
  [/\/messages/, 'message'],
  [/\/bans|\/bulk-ban|\/prune|\/requests/, 'moderation'],
  [/\/emojis/, 'emoji'],
  [/\/entitlements|\/skus|\/subscriptions/, 'entitlement'],
  [/\/roles/, 'role'],
  [/\/members|\/member$/, 'member'],
  [/\/voice-states|\/voice-regions/, 'voice'],
  [/^\/applications/, 'application'],
  [/^\/channels/, 'channel'],
  [/^\/guilds/, 'guild'],
  [/^\/users/, 'user'],
]

export const classifyFamily = (path: string): OperationFamily => {
  for (const [pattern, family] of FAMILY_PATTERNS) if (pattern.test(path)) return family
  return 'guild'
}

/**
 * Discord pages three ways, and a cursor means something different in each. Snowflake paging uses
 * `before`/`after` against IDs; offset paging uses a numeric `offset`; token paging returns an
 * opaque continuation.
 */
export const classifyPagination = (queryNames: ReadonlyArray<string>): PaginationStyle => {
  if (queryNames.includes('before') || queryNames.includes('after')) return 'snowflake'
  if (queryNames.includes('offset')) return 'offset'
  if (queryNames.some((n) => n.endsWith('_token') || n === 'cursor')) return 'token'
  return 'none'
}

/**
 * Discord honours `X-Audit-Log-Reason` on guild mutations. Sending it where it is ignored is
 * harmless, but advertising it where it does nothing teaches an agent a false affordance.
 */
export const supportsAuditLogReason = (method: HttpMethod, path: string): boolean =>
  method !== 'GET' && (path.startsWith('/guilds/') || path.startsWith('/channels/'))

/**
 * Parameters that must never be accepted as an ordinary MCP string.
 *
 * A webhook or interaction token in a tool argument is a credential a remote principal could
 * exfiltrate or forge; these resolve through stored secret references instead. `spec:check` fails
 * if any of them is exposed directly.
 */
const SENSITIVE_PARAM_NAMES = new Set([
  'webhook_token',
  'interaction_token',
  'token',
  'client_secret',
  'code',
  'refresh_token',
  'access_token',
])

export const sensitiveParams = (names: ReadonlyArray<string>): ReadonlyArray<string> =>
  names.filter((n) => SENSITIVE_PARAM_NAMES.has(n))

export const isSensitiveParam = (name: string): boolean => SENSITIVE_PARAM_NAMES.has(name)

/**
 * Search vocabulary, because the vendored spec supplies almost none: 0 of 242 operations carry a
 * summary and only 17 carry a description.
 *
 * Keys are matched against the operation ID as substrings. `spec:generate` warns about any
 * operation with neither a gloss entry nor a curated tool, so search-quality drift shows up at
 * build time rather than as a confused agent.
 */
export const GLOSS: Record<string, ReadonlyArray<string>> = {
  guild: ['server', 'guild', 'community'],
  channel: ['channel', 'room'],
  message: ['message', 'post', 'send', 'chat'],
  member: ['member', 'user', 'person', 'people'],
  role: ['role', 'rank', 'permission group'],
  ban: ['ban', 'block', 'moderation'],
  kick: ['kick', 'remove', 'moderation'],
  prune: ['prune', 'purge', 'inactive'],
  invite: ['invite', 'link', 'join'],
  emoji: ['emoji', 'emote', 'reaction'],
  sticker: ['sticker'],
  reaction: ['reaction', 'react', 'emoji'],
  webhook: ['webhook', 'integration', 'incoming'],
  thread: ['thread', 'forum post'],
  forum: ['forum'],
  pin: ['pin', 'pinned'],
  auto_moderation: ['automod', 'auto moderation', 'filter', 'keyword'],
  audit_log: ['audit', 'log', 'history', 'who did'],
  scheduled_event: ['event', 'scheduled event', 'calendar'],
  stage: ['stage', 'stage channel', 'speaker'],
  voice: ['voice', 'audio'],
  soundboard: ['soundboard', 'sound'],
  application_command: ['slash command', 'command', 'application command'],
  command: ['slash command', 'command'],
  interaction: ['interaction', 'button', 'response', 'callback'],
  entitlement: ['entitlement', 'purchase', 'monetization', 'premium'],
  sku: ['sku', 'monetization', 'store'],
  subscription: ['subscription', 'monetization', 'recurring'],
  gateway: ['gateway', 'websocket', 'realtime'],
  onboarding: ['onboarding', 'welcome', 'setup'],
  welcome: ['welcome', 'onboarding'],
  widget: ['widget', 'embed'],
  template: ['template', 'guild template'],
  overwrite: ['permission overwrite', 'overwrite', 'permission'],
  permission: ['permission', 'access'],
  poll: ['poll', 'vote', 'survey'],
  lobby: ['lobby', 'game lobby'],
  integration: ['integration'],
  connection: ['connection', 'linked account'],
  dm: ['dm', 'direct message', 'private message'],
  nickname: ['nickname', 'nick', 'display name'],
  timeout: ['timeout', 'mute', 'moderation'],
  vanity: ['vanity url', 'custom invite'],
  preview: ['preview'],
  bot: ['bot', 'application'],
  application: ['application', 'app', 'bot'],
  user: ['user', 'account', 'profile'],
}

const METHOD_SYNONYMS: Record<HttpMethod, ReadonlyArray<string>> = {
  GET: ['get', 'read', 'fetch', 'list', 'show', 'view'],
  POST: ['create', 'post', 'add', 'send', 'make', 'new'],
  PUT: ['set', 'put', 'replace', 'add'],
  PATCH: ['update', 'patch', 'edit', 'modify', 'change'],
  DELETE: ['delete', 'remove', 'destroy'],
}

export const searchTokens = (
  operationId: string,
  method: HttpMethod,
  path: string,
): ReadonlyArray<string> => {
  const tokens = new Set<string>()

  for (const part of operationId.split('_')) if (part.length > 1) tokens.add(part.toLowerCase())
  for (const synonym of METHOD_SYNONYMS[method]) tokens.add(synonym)
  for (const segment of path.split('/')) {
    if (segment === '' || segment.startsWith('{')) continue
    for (const part of segment.split(/[-.]/)) if (part.length > 1) tokens.add(part.toLowerCase())
  }
  for (const [key, words] of Object.entries(GLOSS)) {
    if (operationId.includes(key)) for (const w of words) tokens.add(w)
  }

  return [...tokens].sort()
}

/** True when the gloss contributed nothing, so `spec:generate` can warn about it. */
export const hasGloss = (operationId: string): boolean =>
  Object.keys(GLOSS).some((key) => operationId.includes(key))

export const authModes = (
  security: ReadonlyArray<Record<string, unknown>> | undefined,
): {
  auth: ReadonlyArray<AuthMode>
  oauthScopes: ReadonlyArray<string>
} => {
  const requirements = security ?? []
  const auth = new Set<AuthMode>()
  const scopes = new Set<string>()

  for (const requirement of requirements) {
    if ('BotToken' in requirement) auth.add('bot')
    if ('OAuth2' in requirement) {
      auth.add('oauth2')
      for (const scope of (requirement.OAuth2 as ReadonlyArray<string>) ?? []) scopes.add(scope)
    }
  }
  return { auth: [...auth].sort(), oauthScopes: [...scopes].sort() }
}
