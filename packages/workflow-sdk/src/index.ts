import { type Effect, Schema } from 'effect'

/**
 * `@discord-mcp/workflow-sdk` — the API a sandboxed workflow is written against.
 *
 * This is the one published package, and the only one that follows semver, because workflow
 * projects depend on it directly.
 *
 * Everything here is a *description*. A workflow module is imported inside the build sandbox and
 * its default export is inspected to produce a serializable manifest; nothing in a workflow ever
 * gets a Discord credential, a database handle, a host path, or unrestricted networking. Its
 * `Discord`, `Http`, and `WorkflowKv` services are proxies to the capability broker, which checks
 * every call against the revision's grants.
 */

export { Effect, Schema } from 'effect'

// ---------------------------------------------------------------- presentations

/**
 * A message, in the same shape the MCP tools accept.
 *
 * Structurally typed rather than imported from `discord-presentations`, so a published SDK does
 * not drag the whole control plane into a workflow's dependency tree.
 */
export interface MessagePresentation {
  readonly type: 'legacy' | 'components_v2' | 'template'
  readonly [key: string]: unknown
}

/**
 * What an interactive component does.
 *
 * The author names a logical action; the control plane compiles it into an opaque persisted
 * handle. Authors never construct a `custom_id` — Discord round-trips it through the client, so
 * anything an author encoded in one would come back as untrusted input.
 */
export interface ComponentAction {
  readonly type: 'workflow'
  readonly key: string
}

// ---------------------------------------------------------------- services

export interface DiscordService {
  readonly sendMessage: (input: {
    readonly channelId: string
    readonly presentation: MessagePresentation
  }) => Effect.Effect<{ readonly id: string }, WorkflowError>
  readonly editMessage: (input: {
    readonly channelId: string
    readonly messageId: string
    readonly presentation: MessagePresentation
  }) => Effect.Effect<void, WorkflowError>
  readonly respondToInteraction: (input: {
    readonly interaction: InteractionContext
    readonly presentation: MessagePresentation
    readonly ephemeral?: boolean
  }) => Effect.Effect<void, WorkflowError>
  /**
   * Any cataloged operation, subject to the revision's grants.
   *
   * Present so a workflow is not limited to what the SDK happens to wrap, but every call is
   * checked against granted operation IDs, families, guilds, and channels.
   */
  readonly call: (input: {
    readonly operationId: string
    readonly path?: Record<string, string>
    readonly query?: Record<string, unknown>
    readonly body?: unknown
    readonly authProfile?: string
  }) => Effect.Effect<unknown, WorkflowError>
}

export interface WorkflowKvService {
  readonly get: <A = unknown>(key: string) => Effect.Effect<A | undefined, WorkflowError>
  readonly set: (
    key: string,
    value: unknown,
    options?: { readonly ttlSeconds?: number },
  ) => Effect.Effect<void, WorkflowError>
  readonly delete: (key: string) => Effect.Effect<void, WorkflowError>
}

export interface HttpService {
  /** Brokered. Only hosts named in the revision's `network.allowedOutboundHosts` are reachable. */
  readonly fetch: (input: {
    readonly url: string
    readonly method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
    readonly headers?: Record<string, string>
    readonly body?: string
  }) => Effect.Effect<{ readonly status: number; readonly body: string }, WorkflowError>
  /** Build an HTTP response for a `Trigger.http` handler. */
  readonly json: (
    body: unknown,
    status?: number,
  ) => { readonly status: number; readonly body: unknown }
}

export interface LogService {
  readonly info: (message: string, fields?: Record<string, unknown>) => Effect.Effect<void>
  readonly warn: (message: string, fields?: Record<string, unknown>) => Effect.Effect<void>
  readonly error: (message: string, fields?: Record<string, unknown>) => Effect.Effect<void>
}

export interface ExecutionService {
  readonly id: string
  readonly workflowId: string
  readonly revision: number
  readonly correlationId: string
  /** How many workflow executions caused this one. Capped, so a cycle cannot run away. */
  readonly causalDepth: number
  /** Wall-clock milliseconds left before the handler is killed. */
  readonly remainingMs: Effect.Effect<number>
}

/** What a handler receives. No credentials, no filesystem, no unrestricted network. */
export interface HandlerContext {
  readonly Discord: DiscordService
  readonly WorkflowKv: WorkflowKvService
  readonly Http: HttpService
  readonly Log: LogService
  readonly Execution: ExecutionService
}

// ---------------------------------------------------------------- errors

export class WorkflowError extends Schema.TaggedErrorClass<WorkflowError>()('WorkflowError', {
  message: Schema.String,
  /** Set when the capability broker refused the call rather than Discord failing it. */
  denied: Schema.optionalKey(Schema.Boolean),
  suggestion: Schema.optionalKey(Schema.String),
}) {}

// ---------------------------------------------------------------- triggers

export interface GatewayEvent {
  readonly type: string
  readonly guildId?: string
  readonly channelId?: string
  readonly payload: unknown
}

export interface InteractionContext {
  readonly id: string
  readonly guildId?: string
  readonly channelId?: string
  /** Values a modal or select submitted, keyed by the author's own input key. */
  readonly values: Record<string, unknown>
  /** Redacted. A workflow learns *that* someone acted, not enough to impersonate them. */
  readonly userId: string
}

export interface HttpRequestContext<A = unknown> {
  readonly method: string
  readonly path: string
  readonly headers: Record<string, string>
  /** Decoded and validated against the trigger's `request` schema before the handler runs. */
  readonly request: A
}

export type TriggerDefinition =
  | {
      readonly kind: 'gateway'
      readonly events: ReadonlyArray<string>
      readonly guildId?: string
      readonly channelId?: string
      readonly handler: (
        input: { readonly event: GatewayEvent } & HandlerContext,
      ) => Effect.Effect<unknown, unknown>
    }
  | {
      readonly kind: 'interactionCommand'
      readonly name: string
      readonly description: string
      readonly handler: (
        input: { readonly interaction: InteractionContext } & HandlerContext,
      ) => Effect.Effect<unknown, unknown>
    }
  | {
      readonly kind: 'interactionComponent'
      readonly action: string
      readonly handler: (
        input: { readonly interaction: InteractionContext } & HandlerContext,
      ) => Effect.Effect<unknown, unknown>
    }
  | {
      readonly kind: 'interactionModal'
      readonly action: string
      readonly handler: (
        input: { readonly interaction: InteractionContext } & HandlerContext,
      ) => Effect.Effect<unknown, unknown>
    }
  | {
      readonly kind: 'interactionAutocomplete'
      readonly command: string
      readonly handler: (
        input: { readonly interaction: InteractionContext } & HandlerContext,
      ) => Effect.Effect<unknown, unknown>
    }
  | {
      readonly kind: 'http'
      readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
      readonly path: string
      readonly auth: RouteAuth
      readonly request?: Schema.Top
      readonly handler: (
        input: HttpRequestContext & HandlerContext,
      ) => Effect.Effect<unknown, unknown>
    }
  | {
      readonly kind: 'schedule'
      /** Five-field cron. Evaluated in UTC, because a server's local zone is not a contract. */
      readonly schedule: string
      readonly handler: (input: HandlerContext) => Effect.Effect<unknown, unknown>
    }
  | {
      readonly kind: 'manual'
      readonly name: string
      readonly handler: (
        input: { readonly input: unknown } & HandlerContext,
      ) => Effect.Effect<unknown, unknown>
    }

export type RouteAuth =
  | { readonly type: 'apiKey'; readonly secretRef: string; readonly header?: string }
  | { readonly type: 'bearer'; readonly secretRef: string }
  | { readonly type: 'hmacSha256'; readonly secretRef: string; readonly header?: string }
  /** Requires an explicit administrator grant; a public route is never the default. */
  | { readonly type: 'none' }

/**
 * Trigger constructors.
 *
 * Each returns a plain description. The build sandbox reads these to produce the manifest the
 * control plane validates before granting or enabling anything.
 */
export const Trigger = {
  gateway: (
    input: Omit<Extract<TriggerDefinition, { kind: 'gateway' }>, 'kind'>,
  ): TriggerDefinition => ({
    kind: 'gateway',
    ...input,
  }),
  interactionCommand: (
    input: Omit<Extract<TriggerDefinition, { kind: 'interactionCommand' }>, 'kind'>,
  ): TriggerDefinition => ({ kind: 'interactionCommand', ...input }),
  interactionComponent: (
    input: Omit<Extract<TriggerDefinition, { kind: 'interactionComponent' }>, 'kind'>,
  ): TriggerDefinition => ({ kind: 'interactionComponent', ...input }),
  interactionModal: (
    input: Omit<Extract<TriggerDefinition, { kind: 'interactionModal' }>, 'kind'>,
  ): TriggerDefinition => ({ kind: 'interactionModal', ...input }),
  interactionAutocomplete: (
    input: Omit<Extract<TriggerDefinition, { kind: 'interactionAutocomplete' }>, 'kind'>,
  ): TriggerDefinition => ({ kind: 'interactionAutocomplete', ...input }),
  http: (input: Omit<Extract<TriggerDefinition, { kind: 'http' }>, 'kind'>): TriggerDefinition => ({
    kind: 'http',
    ...input,
  }),
  schedule: (
    input: Omit<Extract<TriggerDefinition, { kind: 'schedule' }>, 'kind'>,
  ): TriggerDefinition => ({ kind: 'schedule', ...input }),
  manual: (
    input: Omit<Extract<TriggerDefinition, { kind: 'manual' }>, 'kind'>,
  ): TriggerDefinition => ({
    kind: 'manual',
    ...input,
  }),
} as const

// ---------------------------------------------------------------- the workflow itself

export interface WorkflowDefinition {
  readonly triggers: ReadonlyArray<TriggerDefinition>
}

export interface Workflow {
  readonly definition: WorkflowDefinition
  /** Marks the default export so the build sandbox can tell a workflow from any other object. */
  readonly [WORKFLOW_MARKER]: true
}

export const WORKFLOW_MARKER = Symbol.for('@discord-mcp/workflow-sdk/Workflow')

export const Workflow = {
  make: (definition: WorkflowDefinition): Workflow => ({
    definition,
    [WORKFLOW_MARKER]: true,
  }),
}

export const isWorkflow = (value: unknown): value is Workflow =>
  value !== null && typeof value === 'object' && WORKFLOW_MARKER in value

// ---------------------------------------------------------------- manifest

/**
 * The serializable description the build sandbox emits.
 *
 * Deliberately contains no functions. The control plane validates *this* — not the module — before
 * granting or enabling anything, so nothing executable crosses the sandbox boundary.
 */
export interface CompiledManifest {
  readonly triggers: ReadonlyArray<CompiledTrigger>
  /** Logical action keys the workflow binds components to. */
  readonly actions: ReadonlyArray<string>
  readonly routes: ReadonlyArray<{
    readonly method: string
    readonly path: string
    readonly auth: RouteAuth
    /** Which trigger serves this route. The control plane dispatches by index, not by name. */
    readonly triggerIndex: number
  }>
  readonly commands: ReadonlyArray<{
    readonly name: string
    readonly description: string
    readonly triggerIndex: number
  }>
  readonly schedules: ReadonlyArray<{
    readonly expression: string
    readonly triggerIndex: number
  }>
  readonly gatewayEventTypes: ReadonlyArray<string>
}

export interface CompiledTrigger {
  readonly kind: TriggerDefinition['kind']
  readonly identifier: string
}

/** Reduce a workflow to its manifest. Runs inside the build sandbox, never in the control plane. */
export const compileManifest = (workflow: Workflow): CompiledManifest => {
  const triggers: CompiledTrigger[] = []
  const actions: string[] = []
  const routes: CompiledManifest['routes'] = []
  const commands: Array<{ name: string; description: string; triggerIndex: number }> = []
  const schedules: Array<{ expression: string; triggerIndex: number }> = []
  const gatewayEventTypes: string[] = []

  for (const [triggerIndex, trigger] of workflow.definition.triggers.entries()) {
    switch (trigger.kind) {
      case 'gateway':
        triggers.push({ kind: trigger.kind, identifier: trigger.events.join(',') })
        gatewayEventTypes.push(...trigger.events)
        break
      case 'interactionCommand':
        triggers.push({ kind: trigger.kind, identifier: trigger.name })
        commands.push({ name: trigger.name, description: trigger.description, triggerIndex })
        break
      case 'interactionComponent':
      case 'interactionModal':
        triggers.push({ kind: trigger.kind, identifier: trigger.action })
        actions.push(trigger.action)
        break
      case 'interactionAutocomplete':
        triggers.push({ kind: trigger.kind, identifier: trigger.command })
        break
      case 'http':
        triggers.push({ kind: trigger.kind, identifier: `${trigger.method} ${trigger.path}` })
        ;(routes as Array<CompiledManifest['routes'][number]>).push({
          method: trigger.method,
          path: trigger.path,
          auth: trigger.auth,
          triggerIndex,
        })
        break
      case 'schedule':
        triggers.push({ kind: trigger.kind, identifier: trigger.schedule })
        schedules.push({ expression: trigger.schedule, triggerIndex })
        break
      case 'manual':
        triggers.push({ kind: trigger.kind, identifier: trigger.name })
        break
    }
  }

  return {
    triggers,
    actions: [...new Set(actions)].sort(),
    routes,
    commands,
    schedules,
    gatewayEventTypes: [...new Set(gatewayEventTypes)].sort(),
  }
}

// ---------------------------------------------------------------- grants

/**
 * What a revision is allowed to do. Default-deny throughout.
 *
 * **An empty target list means no access, not unrestricted access.** That is the opposite of the
 * usual convention and it is deliberate: the failure mode of the usual convention is a workflow
 * that can reach every guild because someone left a field out.
 */
export interface WorkflowGrant {
  readonly discord: {
    readonly operationIds: ReadonlyArray<string>
    readonly operationFamilies: ReadonlyArray<string>
    readonly guildIds: ReadonlyArray<string>
    readonly channelIds: ReadonlyArray<string>
    readonly oauthProfileIds: ReadonlyArray<string>
    readonly botAdmin: boolean
    readonly broadMentions: boolean
    readonly maxActionsPerMinute: number
  }
  readonly gateway: {
    readonly eventTypes: ReadonlyArray<string>
    readonly includeBotAuthoredEvents: boolean
  }
  readonly interactions: {
    readonly guildCommandPublishing: boolean
    readonly globalCommandPublishing: boolean
  }
  readonly routes: {
    readonly public: boolean
    readonly allowedHosts: ReadonlyArray<string>
    readonly allowedOrigins: ReadonlyArray<string>
    readonly allowedSourceCidrs: ReadonlyArray<string>
    readonly maxBodyBytes: number
  }
  readonly network: { readonly allowedOutboundHosts: ReadonlyArray<string> }
  readonly runtime: {
    readonly allowNpmInstallScripts: boolean
    readonly timeoutSeconds: number
    readonly concurrency: number
  }
}

export const DEFAULT_GRANT: WorkflowGrant = {
  discord: {
    operationIds: [],
    operationFamilies: [],
    guildIds: [],
    channelIds: [],
    oauthProfileIds: [],
    botAdmin: false,
    broadMentions: false,
    maxActionsPerMinute: 60,
  },
  gateway: { eventTypes: [], includeBotAuthoredEvents: false },
  interactions: { guildCommandPublishing: false, globalCommandPublishing: false },
  routes: {
    public: false,
    allowedHosts: [],
    allowedOrigins: [],
    allowedSourceCidrs: [],
    maxBodyBytes: 1024 * 1024,
  },
  network: { allowedOutboundHosts: [] },
  runtime: { allowNpmInstallScripts: false, timeoutSeconds: 30, concurrency: 1 },
}

/** Limits the control plane enforces regardless of what a grant asks for. */
export const WORKFLOW_LIMITS = {
  sourceBytes: 256 * 1024,
  directDependencies: 100,
  artifactBytes: 20 * 1024 * 1024,
  buildSeconds: 300,
  logBytesPerExecution: 64 * 1024,
  defaultTimeoutSeconds: 30,
  maxTimeoutSeconds: 300,
  maxConcurrency: 8,
  queuedEventsPerWorkflow: 1000,
  /** A workflow that triggers itself cannot recurse past this. */
  maxCausalDepth: 5,
} as const
