import { readFile, rm } from 'node:fs/promises'
import { createConnection, createServer } from 'node:net'
import process from 'node:process'
import {
  runWithWorkflowServices,
  type WorkflowContext,
  type WorkflowDefinition,
} from '@discord-mcp/workflow-sdk'
import { resolveWorkflowResult, serializeWorkflowFailure } from './execution.js'

interface Invocation {
  readonly executionId: string
  readonly triggerIndex: number
  readonly input: unknown
  readonly correlationId: string
  readonly causationId?: string
  readonly causalDepth: number
}

interface RunnerBootstrap {
  readonly credential: string
  readonly workflowId: string
  readonly revision: number
}

const bootstrapPath = '/run/runner/bootstrap.json'
const bootstrap = await readFile(bootstrapPath, 'utf8')
  .then((contents) => JSON.parse(contents) as RunnerBootstrap)
  .finally(() => rm(bootstrapPath, { force: true }))
const { credential, workflowId, revision } = bootstrap
if (
  typeof credential !== 'string' ||
  credential.length < 16 ||
  typeof workflowId !== 'string' ||
  !Number.isInteger(revision) ||
  revision < 1
) {
  throw new Error('workflow identity is required')
}
const capabilitySocket =
  process.env.DISCORD_MCP_CAPABILITY_SOCKET ?? '/run/discord-mcp/capability.sock'
const runnerSocket = process.env.DISCORD_MCP_RUNNER_SOCKET ?? '/run/runner/runner.sock'
const modulePath = process.env.DISCORD_MCP_WORKFLOW_MODULE ?? '/workflow/index.mjs'
for (const key of Object.keys(process.env)) {
  if (key.startsWith('DISCORD_')) delete process.env[key]
}
const loaded = (await import(modulePath)) as { readonly default?: WorkflowDefinition }
const workflow = loaded.default
if (!workflow || !Array.isArray(workflow.triggers)) {
  throw new Error('workflow module must default-export Workflow.make({ triggers: [...] })')
}

let nonce = 0

class CapabilityCallError extends Error {
  readonly tag: string
  readonly retryable: boolean

  constructor(input: {
    readonly tag: string
    readonly message: string
    readonly retryable?: boolean
  }) {
    super(input.message)
    this.name = input.tag
    this.tag = input.tag
    this.retryable = input.retryable ?? false
  }
}

const capabilityCall = <A>(executionId: string, method: string, params: unknown): Promise<A> =>
  new Promise((resolve, reject) => {
    const socket = createConnection(capabilitySocket)
    const id = ++nonce
    let buffer = ''
    let settled = false
    let timer: NodeJS.Timeout
    const finish = (result: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      result()
    }
    timer = setTimeout(
      () => finish(() => reject(new Error(`capability call ${method} timed out`))),
      5 * 60_000,
    )
    socket.setEncoding('utf8')
    socket.once('connect', () =>
      socket.write(
        `${JSON.stringify({
          id,
          credential,
          workflowId,
          revision,
          executionId,
          method,
          params,
        })}\n`,
      ),
    )
    socket.on('data', (chunk) => {
      buffer += chunk
      if (Buffer.byteLength(buffer) > 2 * 1024 * 1024) {
        finish(() => reject(new Error('capability response exceeds 2 MiB')))
        return
      }
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      let response: {
        readonly ok: boolean
        readonly result?: A
        readonly error?:
          | string
          | { readonly tag: string; readonly message: string; readonly retryable?: boolean }
      }
      try {
        response = JSON.parse(buffer.slice(0, newline)) as typeof response
      } catch {
        finish(() => reject(new Error('capability server returned invalid JSON')))
        return
      }
      if (response.ok) finish(() => resolve(response.result as A))
      else {
        const error = response.error
        finish(() =>
          reject(
            typeof error === 'object' && error !== null
              ? new CapabilityCallError(error)
              : new Error(error ?? 'capability call failed'),
          ),
        )
      }
    })
    socket.once('error', (error) => finish(() => reject(error)))
    socket.once('end', () => {
      if (!settled) finish(() => reject(new Error('capability server closed without a response')))
    })
  })

const servicesFor = (executionId: string) => ({
  discord: {
    request: <A>(operationId: string, input: unknown) =>
      capabilityCall<A>(executionId, 'discord.request', { operationId, input }),
    sendMessage: (input: unknown) => capabilityCall(executionId, 'discord.sendMessage', input),
    respondToInteraction: async (input: unknown) => ({ __interactionResponse: input }),
    respondToAutocomplete: async (
      choices: ReadonlyArray<{ readonly name: string; readonly value: string | number }>,
    ) => ({ __autocompleteResponse: choices }),
  },
  kv: {
    get: <A>(key: string) => capabilityCall<A | undefined>(executionId, 'kv.get', { key }),
    set: (key: string, value: unknown) =>
      capabilityCall<void>(executionId, 'kv.set', { key, value }),
    delete: (key: string) => capabilityCall<void>(executionId, 'kv.delete', { key }),
  },
  http: {
    fetch: async (url: string, init?: RequestInit) => {
      const result = await capabilityCall<{
        readonly status: number
        readonly headers: Readonly<Record<string, string>>
        readonly body: string
      }>(executionId, 'http.fetch', { url, init })
      return new Response(Buffer.from(result.body, 'base64'), {
        status: result.status,
        headers: result.headers,
      })
    },
    json: (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  },
  log: {
    info: (message: string, fields?: Readonly<Record<string, unknown>>) => {
      void capabilityCall(executionId, 'log.info', { message, fields })
    },
    error: (message: string, fields?: Readonly<Record<string, unknown>>) => {
      void capabilityCall(executionId, 'log.error', { message, fields })
    },
  },
})

const server = createServer((socket) => {
  let buffer = ''
  let handled = false
  socket.setEncoding('utf8')
  socket.on('data', (chunk) => {
    if (handled) return
    buffer += chunk
    if (Buffer.byteLength(buffer) > 1024 * 1024) {
      handled = true
      socket.end(`${JSON.stringify({ ok: false, error: 'invocation exceeds 1 MiB' })}\n`)
      return
    }
    const newline = buffer.indexOf('\n')
    if (newline < 0) return
    handled = true
    let invocation: Invocation
    try {
      invocation = JSON.parse(buffer.slice(0, newline)) as Invocation
    } catch {
      socket.end(`${JSON.stringify({ ok: false, error: 'invalid JSON invocation' })}\n`)
      return
    }
    const trigger = workflow.triggers[invocation.triggerIndex]
    if (!trigger) {
      socket.end(`${JSON.stringify({ ok: false, error: 'trigger does not exist' })}\n`)
      return
    }
    const context: WorkflowContext = {
      executionId: invocation.executionId,
      correlationId: invocation.correlationId,
      ...(invocation.causationId === undefined ? {} : { causationId: invocation.causationId }),
      causalDepth: invocation.causalDepth,
    }
    void resolveWorkflowResult(
      runWithWorkflowServices(
        {
          ...servicesFor(invocation.executionId),
          execution: { context: () => context },
          clock: {
            now: () => new Date(),
            sleep: (milliseconds: number) =>
              new Promise((resolve) => setTimeout(resolve, milliseconds)),
          },
        },
        () => trigger.handler(invocation.input, context),
      ),
    ).then(
      async (result) => {
        const serialized =
          result instanceof Response
            ? {
                status: result.status,
                headers: Object.fromEntries(result.headers),
                body: await result.text(),
              }
            : result
        socket.end(`${JSON.stringify({ ok: true, result: serialized })}\n`)
      },
      (cause: unknown) =>
        socket.end(
          `${JSON.stringify({
            ok: false,
            error: serializeWorkflowFailure(cause),
          })}\n`,
        ),
    )
  })
})
server.listen(runnerSocket)
