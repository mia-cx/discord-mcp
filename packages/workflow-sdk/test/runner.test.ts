import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect } from 'effect'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Trigger, Workflow, WorkflowError } from '../src/index.ts'
import { environmentFromProcess, type RunnerEnvironment, runWorkflow } from '../src/runner.ts'

/**
 * The runner against a stand-in broker.
 *
 * A real Unix socket, because the thing worth testing is that the runner survives what a broker
 * does to it: refusals, ordinary results, and a channel that goes away mid-call.
 */

interface Recorded {
  readonly credential: string
  readonly call: Record<string, unknown>
}

let directory: string
let server: Server
let socketPath: string
let received: Recorded[]
let respond: (call: Record<string, unknown>) => Record<string, unknown>

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'runner-test-'))
  socketPath = join(directory, 'broker.sock')
  received = []
  respond = () => ({ ok: true, result: { id: '42' } })

  server = createServer((socket) => {
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      buffer += chunk
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')

        const request = JSON.parse(line) as {
          id: string
          credential: string
          call: Record<string, unknown>
        }
        received.push({ credential: request.credential, call: request.call })
        socket.write(`${JSON.stringify({ id: request.id, ...respond(request.call) })}\n`)
      }
    })
  })

  await new Promise<void>((resolve) => server.listen(socketPath, resolve))
})

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await rm(directory, { recursive: true, force: true })
})

const environment = (input: unknown, deadlineMs = 5000): RunnerEnvironment => ({
  socketPath,
  credential: 'cap-token',
  workflowId: 'wf',
  revision: 1,
  executionId: 'exec-1',
  correlationId: 'corr-1',
  causalDepth: 0,
  deadlineMs,
  trigger: { index: 0, input },
})

describe('a workflow handler', () => {
  it('reaches Discord only through the capability channel', async () => {
    const workflow = Workflow.make({
      triggers: [
        Trigger.manual({
          name: 'post',
          handler: ({ Discord }) =>
            Discord.sendMessage({
              channelId: '222222222222222222',
              presentation: { kind: 'legacy', content: 'hello' } as never,
            }),
        }),
      ],
    })

    const result = await runWorkflow(workflow, environment(null))

    expect(result).toEqual({ id: '42' })
    const call = received[0]
    expect(call?.credential).toBe('cap-token')
    expect(call?.call).toMatchObject({ kind: 'discord', operationId: 'create_message' })
  })

  it('receives a refusal as a WorkflowError that says it was denied', async () => {
    respond = (call) =>
      call.kind === 'finish'
        ? { ok: true, result: null }
        : {
            ok: false,
            denied: true,
            message: 'Operation "delete_guild" is not granted.',
            suggestion: 'Add it to discord.operationIds.',
          }

    const workflow = Workflow.make({
      triggers: [
        Trigger.manual({
          name: 'try',
          handler: ({ Discord }) =>
            Effect.result(Discord.call({ operationId: 'delete_guild', path: { guild_id: '1' } })),
        }),
      ],
    })

    const result = (await runWorkflow(workflow, environment(null))) as {
      _tag: string
      failure: WorkflowError
    }

    expect(result._tag).toBe('Failure')
    expect(result.failure).toBeInstanceOf(WorkflowError)
    // `denied` is what tells a workflow author the difference between "Discord said no" and "you
    // were never allowed to ask" — the second is not something a retry fixes.
    expect(result.failure.denied).toBe(true)
    expect(result.failure.suggestion).toContain('discord.operationIds')
  })

  it('sends its result to the broker exactly once, at the end', async () => {
    const workflow = Workflow.make({
      triggers: [Trigger.manual({ name: 'quiet', handler: () => Effect.succeed('done') })],
    })

    await runWorkflow(workflow, environment(null))

    const finishes = received.filter((r) => r.call.kind === 'finish')
    expect(finishes).toHaveLength(1)
    expect(finishes[0]?.call.result).toBe('done')
  })

  it('receives the trigger payload it was dispatched with', async () => {
    let seen: unknown
    const workflow = Workflow.make({
      triggers: [
        Trigger.manual({
          name: 'echo',
          handler: ({ input }) =>
            Effect.sync(() => {
              seen = input
            }),
        }),
      ],
    })

    await runWorkflow(workflow, environment({ user: 'mia' }))
    expect(seen).toEqual({ user: 'mia' })
  })

  it('fails with a deadline message rather than hanging', async () => {
    const workflow = Workflow.make({
      triggers: [Trigger.manual({ name: 'slow', handler: () => Effect.never })],
    })

    await expect(runWorkflow(workflow, environment(null, 50))).rejects.toThrow(
      /did not finish within 50ms/,
    )
  })

  it('reports remaining time against its deadline', async () => {
    let remaining = -1
    const workflow = Workflow.make({
      triggers: [
        Trigger.manual({
          name: 'clock',
          handler: ({ Execution }) =>
            Effect.map(Execution.remainingMs, (ms) => {
              remaining = ms
            }),
        }),
      ],
    })

    await runWorkflow(workflow, environment(null, 5000))
    expect(remaining).toBeGreaterThan(0)
    expect(remaining).toBeLessThanOrEqual(5000)
  })
})

describe('a module that is not a workflow', () => {
  it('is refused with an explanation rather than a type error at run time', async () => {
    await expect(runWorkflow({ handler: () => {} }, environment(null))).rejects.toThrow(
      /must default-export Workflow.make/,
    )
  })
})

describe('the runner environment', () => {
  const complete = {
    DISCORD_MCP_CAPABILITY_SOCKET: '/run/capability/broker.sock',
    DISCORD_MCP_CAPABILITY_TOKEN: 'cap',
    DISCORD_MCP_WORKFLOW_ID: 'wf',
    DISCORD_MCP_REVISION: '3',
    DISCORD_MCP_EXECUTION_ID: 'exec',
  }

  it('reads what the supervisor sets', () => {
    const resolved = environmentFromProcess(complete, { index: 0, input: null })
    expect(resolved.revision).toBe(3)
    expect(resolved.credential).toBe('cap')
    // Absent means "this execution starts its own chain", not "depth unknown".
    expect(resolved.causalDepth).toBe(0)
  })

  it('refuses to start outside the supervisor', () => {
    expect(() =>
      environmentFromProcess(
        { ...complete, DISCORD_MCP_CAPABILITY_TOKEN: undefined },
        { index: 0, input: null },
      ),
    ).toThrow(/only started by the sandbox supervisor/)
  })
})
