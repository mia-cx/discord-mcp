import { manualClock } from '@discord-mcp/bot-host/testing'
import { inMemoryStorage } from '@discord-mcp/storage/testing'
import { OperationCatalog } from '@mia-cx/discord-catalog'
import { Effect } from 'effect'
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
  const bots = {
    hold: vi.fn(async () => {}),
    updatePresence: vi.fn(),
    tokenOf: () => 'private-bot-token',
  }
  const host = makeWorkflowHost({
    storage,
    isolates,
    bots,
    clock: manualClock(),
    operations: catalog.all,
    rest: () => ({
      client: { raw: undefined as never, request: () => Effect.succeed(BOT) },
      release: () => {},
    }),
    log: () => {},
  })
  cleanup.push(() => host.close())
  /** Store and enable a workflow listening for `events`, declaring `intents`. */
  const enable = async (name: string, intents: number, events = ['messageCreate']) => {
    await storage.publishWorkflow({
      botId: BOT.id,
      name,
      source: '',
      grants,
      events,
      intents,
      schedules: [],
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
    await enable('content', GUILDS | GUILD_MESSAGES | MESSAGE_CONTENT, [
      'messageCreate',
      'messageUpdate',
    ])
    await enable('no-content', GUILDS | GUILD_MESSAGES, ['messageCreate', 'messageUpdate'])
    await enable('guilds-only', GUILDS, ['messageCreate', 'messageUpdate'])

    host.dispatch(message('secret'))
    // A mention exempts only the message that makes it, not the one it quotes.
    host.dispatch(
      message('hey bot', {
        mentions: [{ id: BOT.id }],
        referenced_message: { author: { id: HUMAN }, content: 'quoted' },
      }),
    )
    // The app always sees its own messages.
    host.dispatch({
      ...message('my edit', { author: { id: BOT.id } }),
      dispatch: {
        t: 'MESSAGE_UPDATE',
        d: message('my edit', { author: { id: BOT.id } }).dispatch.d,
      },
    })

    await vi.waitFor(() => expect(runs).toHaveLength(6))
    // Workflows run in name order: content, then no-content.
    expect(handed(runs)).toEqual(['secret', '', 'hey bot', 'hey bot', 'my edit', 'my edit'])
    const quoted = runs.map(
      (run) =>
        (run.execution.input as { event: { d: { referenced_message?: { content: string } } } })
          .event.d.referenced_message?.content,
    )
    expect(quoted.slice(2, 4)).toEqual(['quoted', ''])
  })

  it("runs each workflow's guild events in order, never waiting on another workflow or for interactions", async () => {
    const { runs, host: isolates } = recordingIsolates()
    const { host, enable } = await setup(isolates)
    const events = ['messageCreate', 'interactionCreate']
    await enable('a', GUILDS | GUILD_MESSAGES | MESSAGE_CONTENT, events)
    await enable('b', GUILDS | GUILD_MESSAGES | MESSAGE_CONTENT, events)

    host.dispatch(message('first'))
    host.dispatch(message('second'))
    host.dispatch(
      event('INTERACTION_CREATE', { id: '7', application_id: BOT.id, token: 't', guild_id: GUILD }),
    )

    await vi.waitFor(() => expect(runs).toHaveLength(6))
    expect(handed(runs)).toEqual(['first', 'first', 'second', 'second', undefined, undefined])
    // Both workflows are still on the first message; both have started the slash command.
    await vi.waitFor(() =>
      expect(runs.map((r) => r.started)).toEqual([true, true, false, false, true, true]),
    )
  })

  it('stops the queued and running events of a workflow once it is disabled', async () => {
    const { runs, host: isolates } = recordingIsolates()
    const { host, enable } = await setup(isolates)
    await enable('slow', GUILDS | GUILD_MESSAGES | MESSAGE_CONTENT)

    host.dispatch(message('first'))
    host.dispatch(message('second'))
    await vi.waitFor(() => expect(runs).toHaveLength(2))
    // An unrelated change in between must not orphan the signal the queued runs carry.
    await enable('other', GUILDS)
    await host.disable(caller, 'slow')

    expect(runs.map((r) => r.execution.signal?.aborted)).toEqual([true, true])
    runs[0]?.finish()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(runs[1]?.started).toBe(false)
  })

  it('stops every queued run when the read after a change fails', async () => {
    const { runs, host: isolates } = recordingIsolates()
    const { storage, host, enable } = await setup(isolates)
    await enable('slow', GUILDS | GUILD_MESSAGES | MESSAGE_CONTENT)
    host.dispatch(message('first'))
    host.dispatch(message('second'))
    await vi.waitFor(() => expect(runs).toHaveLength(2))

    vi.spyOn(storage, 'enabledRevisions').mockRejectedValueOnce(new Error('connection lost'))
    await expect(host.disable(caller, 'slow')).rejects.toThrow('connection lost')

    expect(runs.map((r) => r.execution.signal?.aborted)).toEqual([true, true])
  })

  it('holds only the bots this host owns at startup, when bot hosts share a database', async () => {
    const { storage, bots, host } = await setup()
    const other = '456789012345678901'
    for (const botId of [BOT.id, other]) {
      await storage.publishWorkflow({
        botId,
        name: 'ping',
        source: '',
        grants,
        events: ['messageCreate'],
        intents: GUILDS,
        schedules: [],
        actorId: HUMAN,
      })
      await storage.setEnabledRevision(botId, 'ping', 1, HUMAN, new Date())
    }

    await host.restore((botId) => botId === BOT.id)

    expect(bots.hold.mock.calls).toEqual([[BOT.id, GUILDS]])
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
