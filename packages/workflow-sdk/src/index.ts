import type { Effect as EffectProgram } from 'effect/Effect'

export type { MessagePresentation, ModalPresentation } from '@discord-mcp/discord-presentations'
export { Effect, Schema } from 'effect'
export {
  Clock,
  Discord,
  Execution,
  Http,
  Log,
  runWithWorkflowServices,
  WorkflowKv,
} from './runtime.js'

export interface WorkflowContext {
  readonly executionId: string
  readonly correlationId: string
  readonly causationId?: string
  readonly causalDepth: number
}

export type WorkflowHandler<A = unknown, B = unknown> = (
  input: A,
  context: WorkflowContext,
) => B | Promise<B> | EffectProgram<B, unknown>

export type TriggerDefinition =
  | {
      readonly type: 'gateway'
      readonly eventTypes: ReadonlyArray<string>
      readonly handler: WorkflowHandler
    }
  | {
      readonly type: 'interactionCommand'
      readonly name: string
      readonly commandType?: 'chatInput' | 'user' | 'message'
      /** Required for chat-input commands and omitted for user/message context commands. */
      readonly description?: string
      readonly options?: ReadonlyArray<Readonly<Record<string, unknown>>>
      readonly contexts?: ReadonlyArray<number>
      readonly integrationTypes?: ReadonlyArray<number>
      readonly global?: boolean
      readonly handler: WorkflowHandler
    }
  | {
      readonly type: 'interactionComponent'
      readonly action: string
      readonly handler: WorkflowHandler
    }
  | {
      readonly type: 'interactionModal'
      readonly action: string
      readonly handler: WorkflowHandler
    }
  | {
      readonly type: 'interactionAutocomplete'
      readonly command: string
      readonly handler: WorkflowHandler
    }
  | {
      readonly type: 'http'
      readonly method: string
      readonly path: string
      readonly auth: RouteAuthentication
      readonly request?: unknown
      readonly handler: WorkflowHandler
    }
  | { readonly type: 'schedule'; readonly schedule: string; readonly handler: WorkflowHandler }
  | { readonly type: 'manual'; readonly key: string; readonly handler: WorkflowHandler }

export type RouteAuthentication =
  | { readonly type: 'apiKey'; readonly secretRef: string }
  | { readonly type: 'bearer'; readonly secretRef: string }
  | { readonly type: 'hmacSha256'; readonly secretRef: string }
  | { readonly type: 'none' }

export interface WorkflowDefinition {
  readonly triggers: ReadonlyArray<TriggerDefinition>
  /** Capabilities requested by source. An administrator still approves a concrete grant separately. */
  readonly requestedGrants?: Readonly<Record<string, unknown>>
}

export const Workflow = {
  make: <A extends WorkflowDefinition>(definition: A): A => definition,
}

export const Trigger = {
  gateway: (
    input: Omit<Extract<TriggerDefinition, { type: 'gateway' }>, 'type'>,
  ): TriggerDefinition => ({ type: 'gateway', ...input }),
  interactionCommand: (
    input: Omit<Extract<TriggerDefinition, { type: 'interactionCommand' }>, 'type'>,
  ): TriggerDefinition => ({ type: 'interactionCommand', ...input }),
  interactionComponent: (
    input: Omit<Extract<TriggerDefinition, { type: 'interactionComponent' }>, 'type'>,
  ): TriggerDefinition => ({ type: 'interactionComponent', ...input }),
  interactionModal: (
    input: Omit<Extract<TriggerDefinition, { type: 'interactionModal' }>, 'type'>,
  ): TriggerDefinition => ({ type: 'interactionModal', ...input }),
  interactionAutocomplete: (
    input: Omit<Extract<TriggerDefinition, { type: 'interactionAutocomplete' }>, 'type'>,
  ): TriggerDefinition => ({ type: 'interactionAutocomplete', ...input }),
  http: (input: Omit<Extract<TriggerDefinition, { type: 'http' }>, 'type'>): TriggerDefinition => ({
    type: 'http',
    ...input,
  }),
  schedule: (
    input: Omit<Extract<TriggerDefinition, { type: 'schedule' }>, 'type'>,
  ): TriggerDefinition => ({ type: 'schedule', ...input }),
  manual: (
    input: Omit<Extract<TriggerDefinition, { type: 'manual' }>, 'type'>,
  ): TriggerDefinition => ({ type: 'manual', ...input }),
}

export interface DiscordCapability {
  request<A>(operationId: string, input: unknown): Promise<A>
  sendMessage(input: {
    readonly channelId: string
    readonly presentation: import('@discord-mcp/discord-presentations').MessagePresentation
  }): Promise<unknown>
  respondToInteraction(input: unknown): Promise<unknown>
  respondToAutocomplete(
    choices: ReadonlyArray<{ readonly name: string; readonly value: string | number }>,
  ): Promise<unknown>
}

export interface WorkflowKvCapability {
  get<A>(key: string): Promise<A | undefined>
  set(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<void>
}

export interface HttpCapability {
  fetch(url: string, init?: RequestInit): Promise<Response>
  json(value: unknown, status?: number): Response
}

export interface LogCapability {
  info(message: string, fields?: Readonly<Record<string, unknown>>): void
  error(message: string, fields?: Readonly<Record<string, unknown>>): void
}

export interface ExecutionCapability {
  context(): WorkflowContext
}

export interface ClockCapability {
  now(): Date
  sleep(milliseconds: number): Promise<void>
}
