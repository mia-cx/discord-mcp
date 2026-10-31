import { McpRequestContext, type Principal, ValidationError } from '@discord-mcp/core'
import { DiscordRest } from '@discord-mcp/discord-api/relay'
import type { Storage, WorkflowGrants, WorkflowRevision } from '@discord-mcp/storage'
import type { OperationEntry } from '@mia-cx/discord-catalog'
import { Effect, type Layer, ManagedRuntime, Redacted } from 'effect'
import { makeBroker, type Presence } from './broker.ts'
import { prepareScript, ScriptBuildError, type ScriptModule } from './bundle.ts'
import type { GatewayEvent, IsolateHost, ScriptOutcome } from './isolate-host.ts'

const GUILD_MEMBERS = 1 << 1
const GUILD_MESSAGES = 1 << 9
const GUILD_MESSAGE_REACTIONS = 1 << 10
const DIRECT_MESSAGES = 1 << 12
const DIRECT_MESSAGE_REACTIONS = 1 << 13
const MESSAGE_CONTENT = 1 << 15

interface WorkflowEventKind {
  /** The Gateway dispatch that fires it. */
  readonly t: string
  /** The intent a workflow must declare to receive it in a guild, and in a direct message. */
  readonly guild: number
  readonly direct: number
}

/** The discord.js events a workflow may listen for. */
export const WORKFLOW_EVENTS: Readonly<Record<string, WorkflowEventKind>> = {
  messageCreate: { t: 'MESSAGE_CREATE', guild: GUILD_MESSAGES, direct: DIRECT_MESSAGES },
  messageUpdate: { t: 'MESSAGE_UPDATE', guild: GUILD_MESSAGES, direct: DIRECT_MESSAGES },
  messageDelete: { t: 'MESSAGE_DELETE', guild: GUILD_MESSAGES, direct: DIRECT_MESSAGES },
  messageReactionAdd: {
    t: 'MESSAGE_REACTION_ADD',
    guild: GUILD_MESSAGE_REACTIONS,
    direct: DIRECT_MESSAGE_REACTIONS,
  },
  messageReactionRemove: {
    t: 'MESSAGE_REACTION_REMOVE',
    guild: GUILD_MESSAGE_REACTIONS,
    direct: DIRECT_MESSAGE_REACTIONS,
  },
  guildMemberAdd: { t: 'GUILD_MEMBER_ADD', guild: GUILD_MEMBERS, direct: GUILD_MEMBERS },
  guildMemberRemove: { t: 'GUILD_MEMBER_REMOVE', guild: GUILD_MEMBERS, direct: GUILD_MEMBERS },
  interactionCreate: { t: 'INTERACTION_CREATE', guild: 0, direct: 0 },
}
const EVENT_FOR_DISPATCH = new Map(
  Object.entries(WORKFLOW_EVENTS).map(([name, kind]) => [kind.t, { name, ...kind }]),
)
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
const KNOWN_INTENTS = INTENTS.reduce((all, [, bit]) => all | bit, 0)
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
  /** Aborted once the revision stops running: its queued runs never start, running ones end. */
  readonly stop: AbortController
}

/** Identifies a revision across a delete and a republish under the same name. */
const revisionKey = ({ name, revision, publishedAt }: WorkflowRevision) =>
  `${name}:${revision}:${publishedAt.getTime()}`

/** Who a workflow's Discord calls run as, for the REST client's request context. */
const WORKFLOW_PRINCIPAL: Principal = { id: 'workflow', kind: 'discord-bot', scopes: new Set() }

/**
 * What a revision may see of an event: nothing outside its own intents, and in a guild, no
 * message content without MessageContent unless the message mentions the bot, as Discord does.
 */
const visibleTo = (revision: WorkflowRevision, kind: WorkflowEventKind, event: WorkflowEvent) => {
  const { d } = event.dispatch
  const inGuild = d.guild_id !== undefined
  const needed = inGuild ? kind.guild : kind.direct
  if ((revision.intents & needed) !== needed) return undefined
  const isMessage = kind.t === 'MESSAGE_CREATE' || kind.t === 'MESSAGE_UPDATE'
  const mentioned = ((d.mentions ?? []) as ReadonlyArray<{ id?: unknown }>).some(
    (user) => user.id === event.botId,
  )
  if (!isMessage || !inGuild || mentioned || (revision.intents & MESSAGE_CONTENT) !== 0) {
    return event.dispatch
  }
  const { poll: _, ...rest } = d
  return {
    t: kind.t,
    d: { ...rest, content: '', embeds: [], attachments: [], components: [] },
  }
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
  /** Refreshes for one bot run in order, so the last change decides what the bot host holds. */
  const refreshing = new Map<string, Promise<void>>()
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
      list = storage.enabledRevisions(botId).then((revisions) =>
        revisions.map((revision) => ({
          revision,
          modules: prepareScript(revision.source),
          stop: new AbortController(),
        })),
      )
      enabled.set(botId, list)
      // A failed read is retried on the next event.
      list.catch(() => enabled.delete(botId))
    }
    return list
  }

  /**
   * Point the bot host and the dispatcher at the bot's enabled revisions after a change, and stop
   * every run of a revision that no longer runs.
   */
  const refresh = (botId: string) => {
    const done = (refreshing.get(botId) ?? Promise.resolve()).then(async () => {
      const previous = (await enabled.get(botId)?.catch(() => undefined)) ?? []
      enabled.delete(botId)
      const revisions = await enabledFor(botId)
      const running = new Set(revisions.map(({ revision }) => revisionKey(revision)))
      for (const { revision, stop } of previous) {
        if (!running.has(revisionKey(revision))) stop.abort()
      }
      await bots.hold(
        botId,
        revisions.length === 0
          ? undefined
          : revisions.reduce((all, { revision }) => all | revision.intents, 0),
      )
    })
    refreshing.set(
      botId,
      done.catch(() => {}),
    )
    return done
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

  /** Queue one workflow's run of one event. Enqueues before returning, so callers keep order. */
  const run = (
    event: WorkflowEvent,
    dispatch: GatewayEvent,
    workflow: Enabled,
    botUser: unknown,
    modules: ReadonlyArray<ScriptModule>,
    client: Promise<DiscordRest['Service']>,
  ) => {
    const { botId } = event
    const { d } = dispatch
    const { name, revision, grants } = workflow.revision
    const label = `Workflow ${name} (revision ${revision}) of bot ${botId}`
    const isInteraction = dispatch.t === 'INTERACTION_CREATE'
    return isolates
      .run({
        // A guild's events, and a direct message channel's, run in order. Interactions skip the
        // queue: Discord needs an answer within three seconds, whatever else the guild is doing.
        queue: isInteraction
          ? `${botId}:interaction:${String(d.id)}`
          : `${botId}:${String(d.guild_id ?? `direct:${String(d.channel_id)}`)}`,
        botUser,
        modules,
        timeoutMs: EVENT_TIMEOUT_MS,
        input: { event: dispatch },
        signal: workflow.stop.signal,
        broker: makeBroker({
          operations,
          grants,
          discord: (call, signal) =>
            Effect.flatMap(
              Effect.promise(() => client),
              (c) =>
                c.request(call).pipe(
                  // DiscordRest aborts its HTTP request with the request context's signal.
                  Effect.provideService(McpRequestContext, {
                    requestId: `${label}: ${dispatch.t}`,
                    signal,
                    progressToken: undefined,
                    notify: undefined,
                    principal: WORKFLOW_PRINCIPAL,
                  }),
                ),
            ),
          ...(isInteraction
            ? {
                interaction: {
                  id: String(d.id),
                  applicationId: String(d.application_id),
                  token: String(d.token),
                },
              }
            : {}),
          updatePresence: async (presence) => bots.updatePresence(botId, presence),
          // The URL can hold an interaction token, so only the reason is logged.
          onDenied: ({ method, reason }) => log(`${label}: refused ${method}: ${reason}`),
        }),
      })
      .then(
        (outcome) => {
          if (outcome.outcome !== 'completed') {
            log(`${label} failed on ${dispatch.t}: ${failure(outcome)}`)
          }
        },
        (error: unknown) => {
          // Disabled or deleted while queued or running.
          if (!workflow.stop.signal.aborted) log(`${label} did not run: ${String(error)}`)
        },
      )
  }

  const route = async (event: WorkflowEvent) => {
    const kind = EVENT_FOR_DISPATCH.get(event.dispatch.t)
    if (kind === undefined) return
    // Answering its own messages would loop.
    const author = event.dispatch.d.author as { id?: unknown } | undefined
    if (kind.t === 'MESSAGE_CREATE' && author?.id === event.botId) return
    const matching = (await enabledFor(event.botId)).flatMap((workflow) => {
      if (!workflow.revision.events.includes(kind.name)) return []
      const dispatch = visibleTo(workflow.revision, kind, event)
      return dispatch === undefined ? [] : [{ workflow, dispatch }]
    })
    if (matching.length === 0) return
    const { client, user } = restFor(event.botId, event.token)
    const [botUser, modules] = await Promise.all([
      user,
      Promise.all(matching.map(({ workflow }) => workflow.modules)),
    ])
    // Enqueued together, in order, so every workflow sees a guild's events in the order they came.
    matching.forEach(({ workflow, dispatch }, index) => {
      void run(event, dispatch, workflow, botUser, modules[index] ?? [], client)
    })
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
      const unknownIntents = declared.intents & ~KNOWN_INTENTS
      if (unknownIntents !== 0) {
        throw invalid(
          `The client declares intent bits Discord does not define: ${unknownIntents}.`,
          'source: use GatewayIntentBits names in the Client options.',
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
      if (
        !(await storage.setEnabledRevision(caller.botId, name, revision.revision, caller.actorId))
      ) {
        throw invalid(`No workflow is named ${name}.`)
      }
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
