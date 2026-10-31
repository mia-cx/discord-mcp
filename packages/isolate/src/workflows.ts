import { ValidationError } from '@discord-mcp/core'
import { DiscordRest } from '@discord-mcp/discord-api/relay'
import type { Storage, WorkflowGrants, WorkflowRevision } from '@discord-mcp/storage'
import type { OperationEntry } from '@mia-cx/discord-catalog'
import { Effect, type Layer, ManagedRuntime, Redacted } from 'effect'
import { makeBroker, type Presence } from './broker.ts'
import { prepareScript, ScriptBuildError, type ScriptModule } from './bundle.ts'
import type { GatewayEvent, IsolateHost, ScriptOutcome } from './isolate-host.ts'

/** The Gateway dispatch behind each discord.js event a workflow may listen for. */
export const WORKFLOW_EVENTS: Readonly<Record<string, string>> = {
  messageCreate: 'MESSAGE_CREATE',
  messageUpdate: 'MESSAGE_UPDATE',
  messageDelete: 'MESSAGE_DELETE',
  messageReactionAdd: 'MESSAGE_REACTION_ADD',
  messageReactionRemove: 'MESSAGE_REACTION_REMOVE',
  guildMemberAdd: 'GUILD_MEMBER_ADD',
  guildMemberRemove: 'GUILD_MEMBER_REMOVE',
  interactionCreate: 'INTERACTION_CREATE',
}
const EVENT_FOR_DISPATCH = new Map(Object.entries(WORKFLOW_EVENTS).map(([e, t]) => [t, e]))
/** Bots listen for these by habit. A workflow never logs in or connects, so they never fire. */
const SILENT_EVENTS = new Set(['ready', 'clientReady', 'error', 'warn', 'debug'])

/** Discord's Gateway intent bits, by discord.js's names. */
const INTENTS: ReadonlyArray<readonly [string, number]> = [
  ['Guilds', 1 << 0],
  ['GuildMembers', 1 << 1],
  ['GuildModeration', 1 << 2],
  ['GuildExpressions', 1 << 3],
  ['GuildIntegrations', 1 << 4],
  ['GuildWebhooks', 1 << 5],
  ['GuildInvites', 1 << 6],
  ['GuildVoiceStates', 1 << 7],
  ['GuildPresences', 1 << 8],
  ['GuildMessages', 1 << 9],
  ['GuildMessageReactions', 1 << 10],
  ['GuildMessageTyping', 1 << 11],
  ['DirectMessages', 1 << 12],
  ['DirectMessageReactions', 1 << 13],
  ['DirectMessageTyping', 1 << 14],
  ['MessageContent', 1 << 15],
  ['GuildScheduledEvents', 1 << 16],
  ['AutoModerationConfiguration', 1 << 20],
  ['AutoModerationExecution', 1 << 21],
  ['GuildMessagePolls', 1 << 24],
  ['DirectMessagePolls', 1 << 25],
]
export const intentNames = (intents: number) =>
  INTENTS.filter(([, bit]) => (intents & bit) !== 0).map(([name]) => name)

/**
 * Privileged intents Discord refuses, closing the whole Gateway session, unless the bot's
 * application flags allow them. Either flag of each pair does.
 */
const PRIVILEGED: ReadonlyArray<readonly [string, number, number]> = [
  ['GuildPresences', 1 << 8, (1 << 12) | (1 << 13)],
  ['GuildMembers', 1 << 1, (1 << 14) | (1 << 15)],
  ['MessageContent', 1 << 15, (1 << 18) | (1 << 19)],
]

const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/
const SOURCE_LIMIT_BYTES = 256 * 1024
const PROBE_TIMEOUT_MS = 10_000
/** How long one workflow may take over one event. */
export const EVENT_TIMEOUT_MS = 30_000

/** A Gateway event for an online bot, with the token a run acts with. */
export interface WorkflowEvent {
  readonly botId: string
  readonly token: string
  readonly dispatch: GatewayEvent
}

/** The bot host's side of workflows: who stays online, with which intents, and its presence. */
export interface WorkflowBots {
  readonly hold: (botId: string, intents: number | undefined) => Promise<void>
  readonly updatePresence: (botId: string, presence: Presence) => void
}

export interface WorkflowHostOptions {
  readonly storage: Storage
  readonly isolates: IsolateHost
  readonly bots: WorkflowBots
  readonly operations: ReadonlyArray<OperationEntry>
  /** The REST client a bot's workflows call Discord through, holding its real token. */
  readonly rest: (token: Redacted.Redacted<string>) => Layer.Layer<DiscordRest>
  /** Operator-facing failures. Never receives a token. */
  readonly log: (message: string) => void
}

/** Who is changing a bot's workflows. */
export interface WorkflowCaller {
  readonly botId: string
  readonly botUser: unknown
  /** The Discord user ID of the human whose relay login made the call. */
  readonly actorId: string
}

export interface WorkflowListing {
  readonly workflows: ReadonlyArray<{
    readonly name: string
    readonly latestRevision: number
    readonly enabled: {
      readonly revision: number
      readonly events: ReadonlyArray<string>
      readonly intents: ReadonlyArray<string>
      readonly grants: WorkflowGrants
    } | null
  }>
  readonly changes: Awaited<ReturnType<Storage['workflowChanges']>>
}

export interface WorkflowHost {
  /** Load the source in an isolate to find its events and intents, then store a new revision. */
  readonly publish: (
    caller: WorkflowCaller,
    input: { readonly name: string; readonly source: string; readonly grants: WorkflowGrants },
  ) => Promise<WorkflowRevision>
  readonly list: (botId: string) => Promise<WorkflowListing>
  /**
   * Run a revision, the latest by default, on the bot's events. `applicationFlags` are the bot
   * application's, which decide whether Discord allows its privileged intents.
   */
  readonly enable: (
    caller: WorkflowCaller,
    name: string,
    revision: number | undefined,
    applicationFlags: number,
  ) => Promise<WorkflowRevision>
  readonly disable: (caller: WorkflowCaller, name: string) => Promise<void>
  readonly delete: (caller: WorkflowCaller, name: string) => Promise<void>
  /** Run every enabled workflow that listens for this event. Events of one guild run in order. */
  readonly dispatch: (event: WorkflowEvent) => void
  /** Keep every bot with enabled workflows online. Called once at startup. */
  readonly restore: () => Promise<void>
}

const invalid = (message: string, ...issues: ReadonlyArray<string>) =>
  new ValidationError({ message, issues })

const failure = (outcome: Exclude<ScriptOutcome, { outcome: 'completed' }>) => {
  switch (outcome.outcome) {
    case 'threw':
      return `${outcome.error.name}: ${outcome.error.message}`
    case 'timed_out':
      return `it ran past ${outcome.timeoutMs} ms`
    case 'crashed':
      return outcome.message
  }
}

/** Workflows call Discord from their listeners only, never while loading. */
const refuseAll = async () =>
  Response.json(
    { code: 0, message: 'A workflow calls Discord only from its listeners.' },
    { status: 403 },
  )

interface Enabled {
  readonly revision: WorkflowRevision
  readonly modules: Promise<ReadonlyArray<ScriptModule>>
}

export const makeWorkflowHost = ({
  storage,
  isolates,
  bots,
  operations,
  rest,
  log,
}: WorkflowHostOptions): WorkflowHost => {
  /** Each bot's enabled revisions, compiled once and dropped whenever they change. */
  const enabled = new Map<string, Promise<ReadonlyArray<Enabled>>>()
  /** Routing for one bot runs in event order, so its guilds' queues fill in event order. */
  const routing = new Map<string, Promise<void>>()
  /**
   * One REST client per bot, so its workflows share its rate limits, and the bot's user, which
   * its isolates report as `client.user`. A resumed session brings no READY to read it from.
   */
  const clients = new Map<
    string,
    {
      readonly token: string
      readonly runtime: ManagedRuntime.ManagedRuntime<DiscordRest, never>
      readonly client: Promise<DiscordRest['Service']>
      readonly user: Promise<unknown>
    }
  >()

  const enabledFor = (botId: string) => {
    let list = enabled.get(botId)
    if (list === undefined) {
      list = storage
        .enabledRevisions(botId)
        .then((revisions) =>
          revisions.map((revision) => ({ revision, modules: prepareScript(revision.source) })),
        )
      enabled.set(botId, list)
      // A failed read is retried on the next event.
      list.catch(() => enabled.delete(botId))
    }
    return list
  }

  /** Point the bot host and the dispatcher at the bot's enabled revisions after a change. */
  const refresh = async (botId: string) => {
    enabled.delete(botId)
    const revisions = await enabledFor(botId)
    await bots.hold(
      botId,
      revisions.length === 0
        ? undefined
        : revisions.reduce((all, { revision }) => all | revision.intents, 0),
    )
  }

  const restFor = (botId: string, token: string) => {
    const current = clients.get(botId)
    if (current?.token === token) return current
    // A reset token retires the old client.
    void current?.runtime.dispose()
    const runtime = ManagedRuntime.make(rest(Redacted.make(token)))
    const client = runtime.runPromise(Effect.flatMap(DiscordRest, Effect.succeed))
    const user = client.then((c) =>
      Effect.runPromise(c.request({ method: 'GET', route: '/users/@me', operationFamily: 'user' })),
    )
    const entry = { token, runtime, client, user }
    clients.set(botId, entry)
    // A failed lookup is retried with a new client on the next event.
    user.catch(() => {
      if (clients.get(botId) !== entry) return
      clients.delete(botId)
      void runtime.dispose()
    })
    return entry
  }

  const run = async (event: WorkflowEvent, workflow: Enabled) => {
    const { botId, token, dispatch } = event
    const { name, revision, grants } = workflow.revision
    const label = `Workflow ${name} (revision ${revision}) of bot ${botId}`
    const { client, user } = restFor(botId, token)
    const interaction =
      dispatch.t === 'INTERACTION_CREATE'
        ? {
            id: String(dispatch.d.id),
            applicationId: String(dispatch.d.application_id),
            token: String(dispatch.d.token),
          }
        : undefined
    const outcome = await isolates.run({
      queue: `${botId}:${String(dispatch.d.guild_id ?? 'direct')}`,
      botUser: await user,
      modules: await workflow.modules,
      timeoutMs: EVENT_TIMEOUT_MS,
      input: { event: dispatch },
      broker: makeBroker({
        operations,
        grants,
        discord: (call) =>
          Effect.flatMap(
            Effect.promise(() => client),
            (c) => c.request(call),
          ),
        ...(interaction === undefined ? {} : { interaction }),
        updatePresence: async (presence) => bots.updatePresence(botId, presence),
        // The URL can hold an interaction token, so only the reason is logged.
        onDenied: ({ method, reason }) => log(`${label}: refused ${method}: ${reason}`),
      }),
    })
    if (outcome.outcome !== 'completed') {
      log(`${label} failed on ${dispatch.t}: ${failure(outcome)}`)
    }
  }

  const route = async (event: WorkflowEvent) => {
    const { t, d } = event.dispatch
    const name = EVENT_FOR_DISPATCH.get(t)
    if (name === undefined) return
    // Answering its own messages would loop.
    const author = d.author as { id?: unknown } | undefined
    if (t === 'MESSAGE_CREATE' && author?.id === event.botId) return
    for (const workflow of await enabledFor(event.botId)) {
      if (!workflow.revision.events.includes(name)) continue
      void run(event, workflow).catch((error: unknown) =>
        log(
          `Workflow ${workflow.revision.name} of bot ${event.botId} did not run: ${String(error)}`,
        ),
      )
    }
  }

  const probe = async (caller: WorkflowCaller, modules: ReadonlyArray<ScriptModule>) => {
    const outcome = await isolates.run({
      queue: `${caller.botId}:publish`,
      botUser: caller.botUser,
      modules,
      timeoutMs: PROBE_TIMEOUT_MS,
      input: { probe: true },
      broker: refuseAll,
    })
    if (outcome.outcome !== 'completed') {
      throw invalid(`The workflow did not load: ${failure(outcome)}`)
    }
    return outcome.result as { readonly events: ReadonlyArray<string>; readonly intents: number }
  }

  return {
    publish: async (caller, { name, source, grants }) => {
      if (!NAME.test(name)) {
        throw invalid(
          'The name is not valid.',
          'name: use 1 to 63 lowercase letters, digits, and dashes, starting with a letter or digit.',
        )
      }
      if (Buffer.byteLength(source) > SOURCE_LIMIT_BYTES) {
        throw invalid(`The source exceeds ${SOURCE_LIMIT_BYTES} bytes.`)
      }
      const modules = await prepareScript(source).catch((error: unknown) => {
        throw error instanceof ScriptBuildError ? invalid(error.message, ...error.issues) : error
      })
      const declared = await probe(caller, modules)
      const unsupported = declared.events.filter(
        (event) => !(event in WORKFLOW_EVENTS) && !SILENT_EVENTS.has(event),
      )
      if (unsupported.length > 0) {
        throw invalid(
          `Workflows can't listen for ${unsupported.join(', ')} yet.`,
          `source: listen for ${Object.keys(WORKFLOW_EVENTS).join(', ')}.`,
        )
      }
      const events = declared.events.filter((event) => event in WORKFLOW_EVENTS)
      if (events.length === 0) {
        throw invalid(
          'The workflow listens for no Gateway events.',
          `source: add a listener with client.on(), for one of ${Object.keys(WORKFLOW_EVENTS).join(', ')}.`,
        )
      }
      return storage.publishWorkflow({
        botId: caller.botId,
        name,
        source,
        grants,
        events,
        intents: declared.intents,
        actorId: caller.actorId,
      })
    },

    list: async (botId) => {
      const [workflows, running, changes] = await Promise.all([
        storage.listWorkflows(botId),
        storage.enabledRevisions(botId),
        storage.workflowChanges(botId, 20),
      ])
      return {
        workflows: workflows.map(({ name, latestRevision }) => {
          const revision = running.find((r) => r.name === name)
          return {
            name,
            latestRevision,
            enabled:
              revision === undefined
                ? null
                : {
                    revision: revision.revision,
                    events: revision.events,
                    intents: intentNames(revision.intents),
                    grants: revision.grants,
                  },
          }
        }),
        changes,
      }
    },

    enable: async (caller, name, requested, applicationFlags) => {
      const revision = await storage.loadWorkflowRevision(caller.botId, name, requested)
      if (revision === undefined) {
        throw invalid(
          requested === undefined
            ? `No workflow is named ${name}.`
            : `Workflow ${name} has no revision ${requested}.`,
          'name: list workflows with discord_workflow_list.',
        )
      }
      const refused = PRIVILEGED.filter(
        ([, intent, flags]) =>
          (revision.intents & intent) !== 0 && (applicationFlags & flags) === 0,
      ).map(([intent]) => intent)
      if (refused.length > 0) {
        throw invalid(
          `Discord would refuse this bot's ${refused.join(' and ')} intent.`,
          `Turn on ${refused.join(' and ')} under Bot → Privileged Gateway Intents in the Discord Developer Portal, then enable the workflow again.`,
        )
      }
      await storage.setEnabledRevision(caller.botId, name, revision.revision, caller.actorId)
      await refresh(caller.botId)
      return revision
    },

    disable: async (caller, name) => {
      if (!(await storage.setEnabledRevision(caller.botId, name, null, caller.actorId))) {
        throw invalid(`No workflow is named ${name}.`)
      }
      await refresh(caller.botId)
    },

    delete: async (caller, name) => {
      if (!(await storage.deleteWorkflow(caller.botId, name, caller.actorId))) {
        throw invalid(`No workflow is named ${name}.`)
      }
      await refresh(caller.botId)
    },

    dispatch: (event) => {
      const next = (routing.get(event.botId) ?? Promise.resolve())
        .then(() => route(event))
        .catch((error: unknown) =>
          log(`Bot ${event.botId}'s ${event.dispatch.t} reached no workflow: ${String(error)}`),
        )
      routing.set(event.botId, next)
    },

    restore: async () => {
      const intents = new Map<string, number>()
      for (const { botId, intents: own } of await storage.enabledRevisions()) {
        intents.set(botId, (intents.get(botId) ?? 0) | own)
      }
      await Promise.all([...intents].map(([botId, all]) => bots.hold(botId, all)))
    },
  }
}
