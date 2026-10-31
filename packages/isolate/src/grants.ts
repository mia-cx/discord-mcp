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

/**
 * A bot token can call it, and it carries no other credential. Interaction and webhook tokens in a
 * path are credentials too: the broker forwards no interactions to a script, so it answers none.
 */
const scriptCallable = (operation: OperationEntry) =>
  operation.auth.includes('bot') &&
  operation.risk !== 'credential' &&
  !operation.pathParams.some((param) => param.endsWith('_token'))

export const checkOperation = (grants: ScriptGrants, operation: OperationEntry): Decision => {
  const { operationId, family, risk } = operation
  if (!scriptCallable(operation)) {
    return deny(`${operationId} is not available to scripts.`)
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
