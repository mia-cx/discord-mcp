import type { ServerContext } from '@modelcontextprotocol/server'
import { Context, Effect } from 'effect'
import type { Scope } from '../ids.ts'

/** Who is calling. Resolved by authorization *before* the request context exists. */
export interface Principal {
  readonly id: string
  readonly kind: 'stdio-local' | 'oauth' | 'pat' | 'trusted-proxy'
  readonly scopes: ReadonlySet<Scope>
}

/** Transport-level facts, all known before authorization runs. */
export interface McpRequest {
  readonly requestId: string
  /** Client cancellation. Used twice: to interrupt the fiber, and to abort the Discord request. */
  readonly signal: AbortSignal | undefined
  readonly progressToken: string | number | undefined
  /** Server-to-client notifications, for progress on a long-running call. */
  readonly notify: ServerContext['mcpReq']['notify'] | undefined
}

/**
 * Everything a handler may observe about its caller.
 *
 * A service cannot be back-filled after it is provided, so the principal must be resolved before
 * this is constructed. Anything reading it — audit records, the capability broker, `DiscordRest` —
 * therefore sees a complete principal, or the request never reached it.
 */
export class McpRequestContext extends Context.Service<
  McpRequestContext,
  McpRequest & { readonly principal: Principal }
>()('core/mcp/McpRequestContext') {}

/**
 * The caller's cancellation signal, if there is a caller.
 *
 * Read optionally so REST also works outside a tool call — startup probes, workflow handlers, and
 * tests have no MCP request.
 */
export const requestSignal: Effect.Effect<AbortSignal | undefined> = Effect.map(
  Effect.serviceOption(McpRequestContext),
  (ctx) => (ctx._tag === 'Some' ? ctx.value.signal : undefined),
)

export const hasScope = (principal: Principal, scope: Scope): boolean => principal.scopes.has(scope)
