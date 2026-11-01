import type { OperationEntry } from '@mia-cx/discord-catalog'

/**
 * What a script may do. Operations are catalog operation IDs; families grant every read and write
 * operation in them, never a destructive or admin one; hosts are reachable outbound hostnames.
 */
export interface ScriptGrants {
  readonly operations: ReadonlyArray<string>
  readonly families: ReadonlyArray<string>
  readonly hosts: ReadonlyArray<string>
}

export type Decision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string }

const allow: Decision = { allowed: true }
const deny = (reason: string): Decision => ({ allowed: false, reason })

/** The interaction a workflow run received. Its token is the credential its replies carry. */
export interface ForwardedInteraction {
  readonly id: string
  readonly applicationId: string
  readonly token: string
}

/** Answering an interaction: the response, its original message, and follow-up messages. */
const INTERACTION_REPLIES = new Set([
  'create_interaction_response',
  'get_original_webhook_message',
  'update_original_webhook_message',
  'delete_original_webhook_message',
  'execute_webhook',
  'get_webhook_message',
  'update_webhook_message',
  'delete_webhook_message',
])

/** The value of each `{param}` in `operation`'s path template, read from a path it matched. */
const pathParams = (operation: OperationEntry, path: string) => {
  const values = path.split('/')
  return Object.fromEntries(
    operation.path
      .split('/')
      .flatMap((segment, index) =>
        /^\{\w+\}$/.test(segment) ? [[segment.slice(1, -1), values[index]]] : [],
      ),
  )
}

/**
 * Interaction and webhook tokens in a path are credentials. A run may use only the token of the
 * interaction it was handed, and only to answer it.
 */
const answersInteraction = (
  operation: OperationEntry,
  path: string,
  interaction: ForwardedInteraction | undefined,
) => {
  if (interaction === undefined || !INTERACTION_REPLIES.has(operation.operationId)) return false
  const params = pathParams(operation, path)
  return operation.operationId === 'create_interaction_response'
    ? params.interaction_id === interaction.id && params.interaction_token === interaction.token
    : params.webhook_id === interaction.applicationId && params.webhook_token === interaction.token
}

/**
 * Whether a run may make a Discord call: `path` is the one it requested, and `interaction` the
 * interaction it received, if any.
 */
export const checkOperation = (
  grants: ScriptGrants,
  operation: OperationEntry,
  path: string,
  interaction?: ForwardedInteraction,
): Decision => {
  const { operationId, family, risk } = operation
  if (!operation.auth.includes('bot') || risk === 'credential') {
    return deny(`${operationId} is not available to scripts.`)
  }
  if (
    operation.pathParams.some((param) => param.endsWith('_token')) &&
    !answersInteraction(operation, path, interaction)
  ) {
    return deny(`${operationId} is available only to answer the interaction this run received.`)
  }
  if (grants.operations.includes(operationId)) return allow
  if (!grants.families.includes(family)) {
    return deny(`${operationId} is not granted. Add it to grants.operations.`)
  }
  return risk === 'read' || risk === 'write'
    ? allow
    : deny(
        `${operationId} is ${risk === 'bot_admin' ? 'an admin' : 'a destructive'} operation, which family "${family}" does not grant. Add it to grants.operations.`,
      )
}

export const checkHost = (grants: ScriptGrants, url: URL): Decision => {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return deny(`Only http and https are reachable, not ${url.protocol}.`)
  }
  return grants.hosts.includes(url.hostname)
    ? allow
    : deny(`Host ${url.hostname} is not granted. Add it to grants.hosts.`)
}

interface Template {
  readonly operation: OperationEntry
  readonly pattern: RegExp
  /** Literal segments win over parameters: `/users/@me` beats `/users/{user_id}`. */
  readonly literals: number
}

const compile = (operation: OperationEntry): Template => {
  const segments = operation.path.split('/')
  const pattern = segments
    .map((segment) =>
      /^\{\w+\}$/.test(segment) ? '[^/]+' : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    )
    .join('/')
  return {
    operation,
    pattern: new RegExp(`^${pattern}$`),
    literals: segments.filter((segment) => !segment.startsWith('{')).length,
  }
}

const templates = new WeakMap<ReadonlyArray<OperationEntry>, ReadonlyArray<Template>>()

/**
 * The catalog operation a raw Discord REST call performs, by method and path template.
 * Undefined when no template matches, or when two equally specific ones do.
 */
export const matchOperation = (
  operations: ReadonlyArray<OperationEntry>,
  method: string,
  path: string,
): OperationEntry | undefined => {
  let compiled = templates.get(operations)
  if (compiled === undefined) {
    compiled = operations.map(compile)
    templates.set(operations, compiled)
  }
  const matches = compiled
    .filter((t) => t.operation.method === method && t.pattern.test(path))
    .sort((a, b) => b.literals - a.literals)
  const [best, next] = matches
  return best !== undefined && best.literals !== next?.literals ? best.operation : undefined
}
