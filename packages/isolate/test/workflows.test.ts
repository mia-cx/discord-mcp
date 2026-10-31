import { DiscordRest } from '@discord-mcp/discord-api/relay'
import { inMemoryStorage } from '@discord-mcp/storage/testing'
import { OperationCatalog } from '@mia-cx/discord-catalog'
import { Effect, Layer } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IsolateHost, ScriptExecution, ScriptOutcome } from '../src/isolate-host.ts'
import { makeIsolateHost } from '../src/isolate-host.ts'
import { makeWorkflowHost, type WorkflowEvent } from '../src/workflows.ts'

const BOT = { id: '345678901234567890', username: 'textile', discriminator: '0', bot: true }
const HUMAN = '234567890123456789'
const GUILD = '223456789012345678'
const caller = { botId: BOT.id, botUser: BOT, actorId: HUMAN }
const GUILDS = 1
const GUILD_MESSAGES = 1 << 9
const MESSAGE_CONTENT = 1 << 15
/** Every application flag that allows a privileged intent. */
const ALL_FLAGS = 0xff000
const grants = { operations: [], families: ['message'], hosts: [] }

const catalog = await Effect.runPromise(Effect.provide(OperationCatalog, OperationCatalog.layer))
const cleanup: Array<() => unknown> = []
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})

/**
 * Isolates that run nothing: each execution waits, in its queue like the real host's, until the
 * test finishes it. They record what each run was handed.
 */
const recordingIsolates = () => {
  const runs: Array<{ execution: ScriptExecution; started: boolean; finish: () => void }> = []
  const queues = new Map<string, Promise<unknown>>()
  const host: IsolateHost = {
    run: (execution) => {
      const run = { execution, started: false, finish: () => {} }
      runs.push(run)
      const current = (queues.get(execution.queue) ?? Promise.resolve()).then(() => {
        execution.signal?.throwIfAborted()
        run.started = true
        return new Promise<ScriptOutcome>((resolve) => {
          run.finish = () => resolve({ outcome: 'completed', result: null, logs: [] })
        })
      })
      queues.set(
        execution.queue,
        current.catch(() => {}),
      )
      return current
    },
  }
  return { host, runs }
}

const setup = async (isolates: IsolateHost = recordingIsolates().host) => {
  const storage = await inMemoryStorage()
  cleanup.push(() => storage.close())
  const bots = { hold: vi.fn(async () => {}), updatePresence: vi.fn() }
  const host = makeWorkflowHost({
    storage,
    isolates,
    bots,
    operations: catalog.all,
    rest: () =>
      Layer.succeed(DiscordRest)({ raw: undefined as never, request: () => Effect.succeed(BOT) }),
    log: () => {},
  })
  /** Store and enable a workflow listening for `events`, declaring `intents`. */
  const enable = async (name: string, intents: number, events = ['messageCreate']) => {
    await storage.publishWorkflow({
      botId: BOT.id,
      name,
      source: '',
      grants,
      events,
      intents,
      actorId: HUMAN,
    })
    await host.enable(caller, name, undefined, ALL_FLAGS)
  }
  return { storage, bots, host, enable }
}

const event = (t: string, d: Record<string, unknown>): WorkflowEvent => ({
  botId: BOT.id,
  token: 'private-bot-token',
  dispatch: { t, d },
})
const message = (content: string, extra: Record<string, unknown> = {}) =>
  event('MESSAGE_CREATE', {
    id: '900000000000000001',
    channel_id: '123456789012345678',
    guild_id: GUILD,
    author: { id: HUMAN },
    content,
    mentions: [],
    ...extra,
  })

/** What each run was handed, by workflow name. */
const handed = (runs: ReturnType<typeof recordingIsolates>['runs']) =>
  runs.map(({ execution }) => {
    const input = execution.input as { event: { d: { content?: string } } }
    return input.event.d.content
  })

describe('the workflow dispatcher', () => {
  it('hands each workflow only the events and message content its own intents cover', async () => {
    const { runs, host: isolates } = recordingIsolates()
    const { host, enable } = await setup(isolates)
    await enable('content', GUILDS | GUILD_MESSAGES | MESSAGE_CONTENT)
    await enable('no-content', GUILDS | GUILD_MESSAGES)
    await enable('guilds-only', GUILDS)

    host.dispatch(message('secret'))
    host.dispatch(message('hey bot', { mentions: [{ id: BOT.id }] }))

    await vi.waitFor(() => expect(runs).toHaveLength(4))
    // Workflows run in name order: content, then no-content.
    expect(handed(runs)).toEqual(['secret', '', 'hey bot', 'hey bot'])
  })

  it("runs a guild's events in order across workflows, and lets interactions skip the queue", async () => {
    const { runs, host: isolates } = recordingIsolates()
    const { host, enable } = await setup(isolates)
    await enable('a', GUILDS | GUILD_MESSAGES | MESSAGE_CONTENT, [
      'messageCreate',
      'interactionCreate',
    ])
    await enable('b', GUILDS | GUILD_MESSAGES | MESSAGE_CONTENT)

    host.dispatch(message('first'))
    host.dispatch(message('second'))
    host.dispatch(
      event('INTERACTION_CREATE', { id: '7', application_id: BOT.id, token: 't', guild_id: GUILD }),
    )

    await vi.waitFor(() => expect(runs).toHaveLength(5))
    expect(handed(runs)).toEqual(['first', 'first', 'second', 'second', undefined])
    // The first message is still running; the slash command already started.
    await vi.waitFor(() =>
      expect(runs.map((r) => r.started)).toEqual([true, false, false, false, true]),
    )
  })

  it('stops the queued and running events of a workflow once it is disabled', async () => {
    const { runs, host: isolates } = recordingIsolates()
    const { host, enable } = await setup(isolates)
    await enable('slow', GUILDS | GUILD_MESSAGES | MESSAGE_CONTENT)

    host.dispatch(message('first'))
    host.dispatch(message('second'))
    await vi.waitFor(() => expect(runs).toHaveLength(2))
    await host.disable(caller, 'slow')

    expect(runs.map((r) => r.execution.signal?.aborted)).toEqual([true, true])
    runs[0]?.finish()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(runs[1]?.started).toBe(false)
  })

  it('refuses to publish a client that declares intent bits Discord does not define', async () => {
    const { host } = await setup(makeIsolateHost())

    await expect(
      host.publish(caller, {
        name: 'odd',
        source: `import { Client } from 'discord.js'
          const client = new Client({ intents: 131072 })
          client.on('messageCreate', () => {})`,
        grants,
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining('intent bits') })
  })
})
