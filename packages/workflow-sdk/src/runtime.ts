import { AsyncLocalStorage } from 'node:async_hooks'
import type {
  ClockCapability,
  DiscordCapability,
  ExecutionCapability,
  HttpCapability,
  LogCapability,
  WorkflowKvCapability,
} from './index.js'

export interface WorkflowRuntimeServices {
  readonly discord: DiscordCapability
  readonly kv: WorkflowKvCapability
  readonly http: HttpCapability
  readonly log: LogCapability
  readonly execution?: ExecutionCapability
  readonly clock?: ClockCapability
}

const runtimeSymbol = Symbol.for('@discord-mcp/workflow-runtime-services')
const globalRuntime = globalThis as typeof globalThis & {
  [runtimeSymbol]?: AsyncLocalStorage<WorkflowRuntimeServices>
}
let storage = globalRuntime[runtimeSymbol]
if (!storage) {
  storage = new AsyncLocalStorage<WorkflowRuntimeServices>()
  globalRuntime[runtimeSymbol] = storage
}

const current = (): WorkflowRuntimeServices => {
  const services = storage.getStore()
  if (!services) throw new Error('workflow capability used outside an active execution')
  return services
}

/** Runner-only hook. Workflow authors should use the exported capability objects. */
export const runWithWorkflowServices = <A>(services: WorkflowRuntimeServices, run: () => A): A =>
  storage.run(services, run)

export const Discord: DiscordCapability = {
  request: <A>(operationId: string, input: unknown) =>
    current().discord.request<A>(operationId, input),
  sendMessage: (input) => current().discord.sendMessage(input),
  respondToInteraction: (input) => current().discord.respondToInteraction(input),
  respondToAutocomplete: (choices) => current().discord.respondToAutocomplete(choices),
}

export const WorkflowKv: WorkflowKvCapability = {
  get: <A>(key: string) => current().kv.get<A>(key),
  set: (key, value) => current().kv.set(key, value),
  delete: (key) => current().kv.delete(key),
}

export const Http: HttpCapability = {
  fetch: (url, init) => current().http.fetch(url, init),
  json: (value, status = 200) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
}

export const Log: LogCapability = {
  info: (message, fields) => current().log.info(message, fields),
  error: (message, fields) => current().log.error(message, fields),
}

export const Execution: ExecutionCapability = {
  context: () => {
    const execution = current().execution
    if (!execution) throw new Error('execution context is unavailable')
    return execution.context()
  },
}

export const Clock: ClockCapability = {
  now: () => current().clock?.now() ?? new Date(),
  sleep: (milliseconds) => {
    if (!Number.isFinite(milliseconds) || milliseconds < 0 || milliseconds > 300_000) {
      return Promise.reject(new Error('sleep duration must be between 0 and 300000ms'))
    }
    const clock = current().clock
    if (clock) return clock.sleep(milliseconds)
    return new Promise((resolve) => setTimeout(resolve, milliseconds))
  },
}
