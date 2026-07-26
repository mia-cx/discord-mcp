import type { McpServer, ServerContext } from '@modelcontextprotocol/server'
import { Effect, Exit, type ManagedRuntime, Schema } from 'effect'
import { AuthorizationError } from '../errors.ts'
import { type McpRequest, McpRequestContext, type Principal } from './context.ts'
import { type CallToolResultLike, errorResult, renderCause, successResult } from './result.ts'
import { mcpToolInput, toMcpInputJsonSchema } from './schema.ts'
import { type AnyToolDef, TOOL_NAME_PATTERN, type ToolGate, type Toolset } from './tool.ts'

export class ToolRegistrationError extends Error {
  constructor(toolName: string, reason: string) {
    super(`Tool "${toolName}" cannot be registered: ${reason}`)
    this.name = 'ToolRegistrationError'
  }
}

export interface RegistrySelection {
  readonly toolsets: ReadonlySet<Toolset>
  readonly enabledGates: ReadonlySet<ToolGate>
}

/**
 * Validate a tool eagerly, before any transport accepts a connection.
 *
 * This exists because MCP does *not* reject an unrepresentable schema at `registerTool` — it
 * throws when serialising `tools/list`, which breaks discovery for every tool on the server and
 * only surfaces at first client contact. Building each JSON Schema here converts that into a
 * startup failure naming the offending tool.
 */
export const validateTool = (tool: AnyToolDef): Record<string, unknown> => {
  if (!TOOL_NAME_PATTERN.test(tool.name)) {
    throw new ToolRegistrationError(tool.name, `name does not match ${TOOL_NAME_PATTERN}`)
  }

  let schema: Record<string, unknown>
  try {
    schema = toMcpInputJsonSchema(tool.input)
  } catch (cause) {
    throw new ToolRegistrationError(
      tool.name,
      `input schema is not representable as JSON Schema: ${String(cause)}`,
    )
  }

  if (schema.type !== 'object') {
    throw new ToolRegistrationError(
      tool.name,
      `input schema root must be type "object", got ${JSON.stringify(schema.type)}. Wrap it in Schema.Struct.`,
    )
  }
  return schema
}

export const selectTools = (
  tools: ReadonlyArray<AnyToolDef>,
  selection: RegistrySelection,
): ReadonlyArray<AnyToolDef> =>
  tools.filter(
    (t) => selection.toolsets.has(t.toolset) && selection.enabledGates.has(t.gate ?? 'always'),
  )

/** Resolves the calling principal and proves it holds every scope the tool declares. */
export type Authorize = (
  request: McpRequest,
  tool: AnyToolDef,
) => Effect.Effect<Principal, AuthorizationError>

export const authorizeWithPrincipal =
  (resolve: (request: McpRequest) => Effect.Effect<Principal, AuthorizationError>): Authorize =>
  (request, tool) =>
    Effect.flatMap(resolve(request), (principal) => {
      const missing = tool.scopes.filter((s) => !principal.scopes.has(s))
      return missing.length === 0
        ? Effect.succeed(principal)
        : Effect.fail(
            new AuthorizationError({
              message: `Tool "${tool.name}" requires scopes this principal does not hold.`,
              missingScopes: missing,
            }),
          )
    })

interface RegisterOptions<R> {
  readonly server: McpServer
  readonly tools: ReadonlyArray<AnyToolDef>
  readonly selection: RegistrySelection
  readonly authorize: Authorize
  readonly runtime: ManagedRuntime.ManagedRuntime<R, never>
  readonly authProfile: string
}

/**
 * Register the selected tools with MCP, bridging every handler through one `ManagedRuntime`.
 *
 * `Runtime<R>` was removed in v4, so a single `ManagedRuntime` built from the application layer is
 * the Effect↔Promise boundary for every call.
 */
export const registerTools = <R>(options: RegisterOptions<R>): ReadonlyArray<AnyToolDef> => {
  const selected = selectTools(options.tools, options.selection)

  const seen = new Set<string>()
  for (const tool of selected) {
    if (seen.has(tool.name)) throw new ToolRegistrationError(tool.name, 'duplicate tool name')
    seen.add(tool.name)
    validateTool(tool)
  }

  for (const tool of selected) {
    options.server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        annotations: tool.annotations,
        // MCP's generic inference cannot span a heterogeneous registry; each schema was proven
        // object-rooted by validateTool above.
        // biome-ignore lint/suspicious/noExplicitAny: see above.
        inputSchema: mcpToolInput(tool.input) as any,
      },
      // biome-ignore lint/suspicious/noExplicitAny: see above.
      (async (args: unknown, ctx: ServerContext) => callTool(tool, args, ctx, options)) as any,
    )
  }
  return selected
}

/** The Effect↔Promise boundary. One per tool call. */
const callTool = async <R>(
  tool: AnyToolDef,
  args: unknown,
  ctx: ServerContext,
  options: RegisterOptions<R>,
): Promise<CallToolResultLike> => {
  // Transport-level facts, all known before authorization runs.
  const request: McpRequest = {
    requestId: String(ctx.mcpReq.id),
    signal: ctx.mcpReq.signal,
    progressToken: ctx.mcpReq._meta?.progressToken,
    notify: ctx.mcpReq.notify,
  }

  // Authorize FIRST, then build the context. `provideService` cannot be back-filled, so the
  // principal must be resolved before any downstream service, audit record, or Discord call can
  // observe the context.
  const program = options.authorize(request, tool).pipe(
    Effect.flatMap((principal) =>
      Effect.gen(function* () {
        // `onExcessProperty: 'error'` matches the `additionalProperties: false` we advertise.
        // Effect decodes leniently by default and MCP's own `~standard.validate` is lenient too,
        // so without this an unrecognised argument would be silently dropped — and a dropped
        // argument is how a model gets a confidently wrong result instead of a fixable error.
        const decoded = yield* Schema.decodeUnknownEffect(tool.input, {
          errors: 'all',
          onExcessProperty: 'error',
        })(args)
        const out = yield* tool.handler(decoded)
        return tool.output === undefined ? out : yield* Schema.encodeEffect(tool.output)(out)
      }).pipe(
        Effect.provideService(McpRequestContext, { ...request, principal }),
        Effect.annotateLogs({ principal: principal.id, tool: tool.name }),
      ),
    ),
    Effect.withLogSpan(`tool:${tool.name}`),
  )

  // The signal is used twice: here, so client cancellation interrupts the fiber and runs
  // finalizers; and in McpRequestContext, so DiscordRest can abort the in-flight HTTP request
  // rather than abandoning it.
  const exit = await options.runtime.runPromiseExit(
    program as Effect.Effect<unknown, unknown, R>,
    request.signal === undefined ? undefined : { signal: request.signal },
  )

  return Exit.match(exit, {
    onFailure: (cause) => errorResult(request.requestId, renderCause(cause)),
    onSuccess: (data) =>
      successResult({
        ok: true,
        data,
        meta: { requestId: request.requestId, authProfile: options.authProfile, truncated: false },
        warnings: [],
      }),
  })
}
