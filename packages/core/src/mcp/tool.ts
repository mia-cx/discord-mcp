import type { Effect, Schema } from 'effect'
import type { RiskClass, Scope } from '../ids.ts'
import type { McpRequestContext } from './context.ts'
import type { McpSchema } from './schema.ts'

export type Toolset = 'operator' | 'automation' | 'admin' | 'api'

/** Registration-time gates beyond the toolset: some tools only exist if a subsystem is enabled. */
export type ToolGate = 'always' | 'gateway' | 'workflows'

export interface ToolAnnotations {
  readonly readOnlyHint?: boolean
  readonly destructiveHint?: boolean
  readonly idempotentHint?: boolean
  readonly openWorldHint?: boolean
}

/** MCP tool names. Enforced at registry construction, not merely documented. */
export const TOOL_NAME_PATTERN = /^[a-z0-9_]{1,64}$/

export interface ToolDef<A, Out, R> {
  readonly name: string
  readonly title: string
  /**
   * State required Discord permissions, required local scopes, destructive behaviour, important
   * mutual exclusions, and the next diagnostic tool to call after a likely failure.
   */
  readonly description: string
  readonly toolset: Toolset
  readonly gate?: ToolGate
  readonly risk: RiskClass
  readonly scopes: ReadonlyArray<Scope>
  readonly annotations: ToolAnnotations
  /**
   * Always a `Struct` at the root. MCP rejects a non-object root schema — and does so at
   * `tools/list`, which would break discovery for every tool on the server, so the registry
   * asserts this eagerly at startup instead.
   */
  readonly input: McpSchema
  readonly output?: Schema.Top
  readonly handler: (args: A) => Effect.Effect<Out, unknown, R | McpRequestContext>
}

/**
 * An identity function whose only job is inference.
 *
 * Handler `R` unions across every registered tool, so the compiler proves the application layer
 * satisfies every requirement the tool surface has.
 */
export const defineTool = <A, Out, R>(d: ToolDef<A, Out, R>): ToolDef<A, Out, R> => d

/** A tool erased of its type parameters, for storage in the registry. */
// The registry is heterogeneous by construction: each tool's types are proven at its `defineTool`
// call site, and re-proven at runtime by the decode/encode path around every handler.
// biome-ignore lint/suspicious/noExplicitAny: see above.
export type AnyToolDef = ToolDef<any, any, any>
