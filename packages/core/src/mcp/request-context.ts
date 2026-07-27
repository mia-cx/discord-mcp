import { Context } from 'effect'

export interface McpPrincipalContext {
  readonly id: string
  readonly scopes: ReadonlySet<string>
}

export interface McpRequestContextService {
  readonly signal: AbortSignal
  readonly requestId: string
  readonly progressToken?: string | number
  readonly notify?: (message: unknown) => Promise<void>
  readonly principal: McpPrincipalContext
}

/**
 * Transport facts and the already-resolved principal for one MCP call.
 * Services consume this instead of reaching into SDK request objects.
 */
export class McpRequestContext extends Context.Service<
  McpRequestContext,
  McpRequestContextService
>()('@discord-mcp/core/McpRequestContext') {}
