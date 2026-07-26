import { connect, type Socket } from 'node:net'
import { Effect } from 'effect'
import {
  type DiscordService,
  type ExecutionService,
  type HandlerContext,
  type HttpRequestContext,
  type HttpService,
  isWorkflow,
  type LogService,
  type MessagePresentation,
  type TriggerDefinition,
  type Workflow,
  WorkflowError,
  type WorkflowKvService,
} from './index.ts'

/**
 * The runner, which is what actually executes inside a workflow container.
 *
 * It has no Discord credential, no database, and no network. Every service below is a message on
 * one Unix socket, and the broker on the other end checks the revision's grant before doing
 * anything — so a workflow that calls something it was not granted receives a refusal, not a
 * failure it can retry into success.
 *
 * Published as part of the SDK because it ships inside the artifact: a runner fix reaches a
 * workflow through a rebuild, not through an image swap under a pinned revision.
 */

interface Pending {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: WorkflowError) => void
}

interface Channel {
  readonly call: (payload: Record<string, unknown>) => Promise<unknown>
  readonly close: () => void
}

const openChannel = (socketPath: string, credential: string): Channel => {
  const socket: Socket = connect(socketPath)
  socket.setEncoding('utf8')

  const pending = new Map<string, Pending>()
  let sequence = 0
  let buffer = ''

  socket.on('data', (chunk: string) => {
    buffer += chunk
    let newline = buffer.indexOf('\n')
    while (newline !== -1) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf('\n')

      const response = JSON.parse(line) as
        | { id: string; ok: true; result: unknown }
        | { id: string; ok: false; denied: boolean; message: string; suggestion?: string }

      const waiter = pending.get(response.id)
      if (waiter === undefined) continue
      pending.delete(response.id)

      if (response.ok) {
        waiter.resolve(response.result)
      } else {
        waiter.reject(
          new WorkflowError({
            message: response.message,
            denied: response.denied,
            ...(response.suggestion === undefined ? {} : { suggestion: response.suggestion }),
          }),
        )
      }
    }
  })

  // A socket that dies takes every in-flight call with it. Leaving them pending would hang the
  // handler until its deadline for no reason it could report.
  const failAll = (message: string) => {
    for (const waiter of pending.values()) {
      waiter.reject(new WorkflowError({ message, denied: false }))
    }
    pending.clear()
  }
  socket.on('error', (cause) => failAll(`The capability channel failed: ${cause.message}`))
  socket.on('close', () => failAll('The capability channel closed.'))

  return {
    call: (payload) =>
      new Promise((resolve, reject) => {
        sequence += 1
        const id = String(sequence)
        pending.set(id, { resolve, reject })
        socket.write(`${JSON.stringify({ id, credential, call: payload })}\n`)
      }),
    close: () => socket.destroy(),
  }
}

const request = (channel: Channel, payload: Record<string, unknown>) =>
  Effect.tryPromise({
    try: () => channel.call(payload),
    catch: (cause) =>
      cause instanceof WorkflowError
        ? cause
        : new WorkflowError({ message: String(cause), denied: false }),
  })

const discordService = (channel: Channel): DiscordService => ({
  sendMessage: (input) =>
    Effect.map(
      request(channel, {
        kind: 'discord',
        operationId: 'create_message',
        path: { channel_id: input.channelId },
        body: presentationBody(input.presentation),
      }),
      (data) => ({ id: String((data as { id?: unknown }).id ?? '') }),
    ),

  editMessage: (input) =>
    Effect.asVoid(
      request(channel, {
        kind: 'discord',
        operationId: 'update_message',
        path: { channel_id: input.channelId, message_id: input.messageId },
        body: presentationBody(input.presentation),
      }),
    ),

  respondToInteraction: (input) =>
    Effect.asVoid(
      request(channel, {
        kind: 'discord',
        operationId: 'create_interaction_response',
        path: { interaction_id: input.interaction.id },
        body: {
          presentation: input.presentation,
          ...(input.ephemeral === undefined ? {} : { ephemeral: input.ephemeral }),
        },
      }),
    ),

  call: (input) =>
    request(channel, {
      kind: 'discord',
      operationId: input.operationId,
      ...(input.path === undefined ? {} : { path: input.path }),
      ...(input.query === undefined ? {} : { query: input.query }),
      ...(input.body === undefined ? {} : { body: input.body }),
      ...(input.authProfile === undefined ? {} : { authProfile: input.authProfile }),
    }),
})

/**
 * A presentation crosses the socket as-is.
 *
 * Encoding it here would put the Components V2 rules inside the sandbox, where a workflow could
 * bypass them by not using the SDK. The broker encodes and validates instead.
 */
const presentationBody = (presentation: MessagePresentation) => ({ presentation })

const kvService = (channel: Channel): WorkflowKvService => ({
  get: <A>(key: string) =>
    Effect.map(request(channel, { kind: 'kv', op: 'get', key }), (value) => value as A | undefined),
  set: (key, value, options) =>
    Effect.asVoid(
      request(channel, {
        kind: 'kv',
        op: 'set',
        key,
        value,
        ...(options?.ttlSeconds === undefined ? {} : { ttlSeconds: options.ttlSeconds }),
      }),
    ),
  delete: (key) => Effect.asVoid(request(channel, { kind: 'kv', op: 'delete', key })),
})

const httpService = (channel: Channel): HttpService => ({
  fetch: (input) =>
    Effect.map(
      request(channel, {
        kind: 'http',
        url: input.url,
        ...(input.method === undefined ? {} : { method: input.method }),
        ...(input.headers === undefined ? {} : { headers: input.headers }),
        ...(input.body === undefined ? {} : { body: input.body }),
      }),
      (value) => value as { readonly status: number; readonly body: string },
    ),
  json: (body, status = 200) => ({ status, body }),
})

const logService = (channel: Channel): LogService => {
  const emit = (level: 'info' | 'warn' | 'error') => (message: string, fields?: unknown) =>
    Effect.ignore(
      request(channel, {
        kind: 'log',
        level,
        message,
        ...(fields === undefined ? {} : { fields }),
      }),
    )

  return { info: emit('info'), warn: emit('warn'), error: emit('error') }
}

export interface RunnerEnvironment {
  readonly socketPath: string
  readonly credential: string
  readonly workflowId: string
  readonly revision: number
  readonly executionId: string
  readonly correlationId: string
  readonly causalDepth: number
  readonly deadlineMs: number
  readonly trigger: { readonly index: number; readonly input: unknown }
}

/** Pick the trigger the control plane dispatched to, by index rather than by name. */
const triggerAt = (workflow: Workflow, index: number): TriggerDefinition => {
  const trigger = workflow.definition.triggers[index]
  if (trigger === undefined) {
    throw new Error(
      `This artifact has no trigger at index ${index}. The control plane and the artifact disagree about the manifest, which means the revision was not built from this source.`,
    )
  }
  return trigger
}

/**
 * Invoke a trigger's handler with a context built over the channel.
 *
 * The shapes differ per trigger kind because the handler signatures do; there is no single payload
 * that would be honest for all of them.
 */
const invoke = (
  trigger: TriggerDefinition,
  input: unknown,
  context: HandlerContext,
): Effect.Effect<unknown, unknown> => {
  switch (trigger.kind) {
    case 'gateway':
      return trigger.handler({ event: input as never, ...context })
    case 'interactionCommand':
    case 'interactionComponent':
    case 'interactionModal':
    case 'interactionAutocomplete':
      return trigger.handler({ interaction: input as never, ...context })
    case 'http':
      return trigger.handler({ ...(input as HttpRequestContext), ...context })
    case 'schedule':
      return trigger.handler(context)
    case 'manual':
      return trigger.handler({ input, ...context })
  }
}

export const runWorkflow = async (
  workflow: unknown,
  environment: RunnerEnvironment,
): Promise<unknown> => {
  if (!isWorkflow(workflow)) {
    throw new Error('The workflow module must default-export Workflow.make({...}).')
  }

  const channel = openChannel(environment.socketPath, environment.credential)
  const startedAt = Date.now()

  const execution: ExecutionService = {
    id: environment.executionId,
    workflowId: environment.workflowId,
    revision: environment.revision,
    correlationId: environment.correlationId,
    causalDepth: environment.causalDepth,
    remainingMs: Effect.sync(() => Math.max(0, environment.deadlineMs - (Date.now() - startedAt))),
  }

  const context: HandlerContext = {
    Discord: discordService(channel),
    WorkflowKv: kvService(channel),
    Http: httpService(channel),
    Log: logService(channel),
    Execution: execution,
  }

  try {
    const trigger = triggerAt(workflow, environment.trigger.index)
    const result = await Effect.runPromise(
      // The container is killed at the deadline regardless; this exists so a handler that finishes
      // late still reports a timeout rather than being cut off mid-sentence.
      Effect.timeoutOrElse(invoke(trigger, environment.trigger.input, context), {
        duration: environment.deadlineMs,
        orElse: () =>
          Effect.fail(
            new WorkflowError({
              message: `The handler did not finish within ${environment.deadlineMs}ms.`,
              denied: false,
              suggestion:
                'Raise runtime.timeoutSeconds in the grant, or do less work per execution.',
            }),
          ),
      }),
    )

    await channel.call({ kind: 'finish', result })
    return result
  } finally {
    channel.close()
  }
}

/** Read the runner's environment from the variables the supervisor sets. */
export const environmentFromProcess = (
  env: Readonly<Record<string, string | undefined>>,
  payload: { readonly index: number; readonly input: unknown },
): RunnerEnvironment => {
  const required = (name: string): string => {
    const value = env[name]
    if (value === undefined || value === '') {
      throw new Error(`${name} is not set. The runner is only started by the sandbox supervisor.`)
    }
    return value
  }

  return {
    socketPath: required('DISCORD_MCP_CAPABILITY_SOCKET'),
    credential: required('DISCORD_MCP_CAPABILITY_TOKEN'),
    workflowId: required('DISCORD_MCP_WORKFLOW_ID'),
    revision: Number(required('DISCORD_MCP_REVISION')),
    executionId: required('DISCORD_MCP_EXECUTION_ID'),
    correlationId: env.DISCORD_MCP_CORRELATION_ID ?? required('DISCORD_MCP_EXECUTION_ID'),
    causalDepth: Number(env.DISCORD_MCP_CAUSAL_DEPTH ?? '0'),
    deadlineMs: Number(env.DISCORD_MCP_DEADLINE_MS ?? '30000'),
    trigger: payload,
  }
}
