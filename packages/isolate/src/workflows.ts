import { McpRequestContext, type Principal, ValidationError } from '@discord-mcp/core'
import type { DiscordRest } from '@discord-mcp/discord-api/relay'
import type {
  RecordedWorkflowRun,
  Storage,
  WorkflowGrants,
  WorkflowRevision,
  WorkflowRunOutcome,
} from '@discord-mcp/storage'
import type { OperationEntry } from '@mia-cx/discord-catalog'
import { Effect, Redacted } from 'effect'
import { transform } from 'esbuild'
import { type KvStore, makeBroker, type Presence } from './broker.ts'
import { bundleWorkflow, ScriptBuildError, type ScriptModule, withRuntime } from './bundle.ts'
import { type Dependencies, DependencyError, withDependencies } from './dependencies.ts'
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
/** How long an interaction may wait for a process slot and still be answered in time. */
const INTERACTION_ADMISSION_MS = 2_000
/** How long one workflow may take over one event. */
export const EVENT_TIMEOUT_MS = 30_000
/** What a workflow's KV keys and values may take together. */
export const KV_LIMIT_BYTES = 1024 * 1024
export const KV_KEY_LIMIT_BYTES = 512
const HOUR_MS = 60 * 60 * 1000
/** How long a run's record stays readable, and how many records each workflow keeps at most. */
export const RUN_RETENTION_MS = 7 * 24 * HOUR_MS
export const RUNS_KEPT = 1000
/** A run's console output, and its error, are each stored up to this many characters. */
const RUN_LOG_LIMIT_CHARS = 16 * 1024
/** How often expired run records are deleted, at most. */
const PRUNE_INTERVAL_MS = HOUR_MS
const REDACTED = '[redacted]'

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
  /** The npm registry workflow dependencies install from; npm's public one by default. */
  readonly registry?: string
  /**
   * Borrow the REST client a bot's workflows call Discord through, acting with `token`. The bot
   * host lends the bot's own rate limiter, so workflows and agent calls share its limits.
   */
  readonly rest: (botId: string, token: Redacted.Redacted<string>) => BorrowedRest
  /** Operator-facing failures. Never receives a token. */
  readonly log: (message: string) => void
  /** Wall-clock milliseconds since the epoch, for run records. Defaults to `Date.now`. */
  readonly now?: () => number
}

/** A bot's REST client, lent until `release`. */
export interface BorrowedRest {
  readonly client: DiscordRest['Service']
  readonly release: () => void
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
      readonly packages: ReadonlyArray<string>
    } | null
  }>
  readonly changes: Awaited<ReturnType<Storage['workflowChanges']>>
}

export interface WorkflowHost {
  /** Load the source in an isolate to find its events and intents, then store a new revision. */
  readonly publish: (
    caller: WorkflowCaller,
    input: {
      readonly name: string
      readonly source: string
      readonly grants: WorkflowGrants
      /** npm packages the source imports, by version, range, or tag. */
      readonly dependencies?: Readonly<Record<string, string>>
      /** A package-lock.json pinning every version `dependencies` installs. */
      readonly lockfile?: string
    },
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
  /** The bot's most recent unexpired workflow runs, newest first. */
  readonly runs: (
    botId: string,
    query: { readonly name?: string; readonly failed?: boolean; readonly limit: number },
  ) => Promise<ReadonlyArray<RecordedWorkflowRun>>
  /** Run every enabled workflow that listens for this event. Events of one guild run in order. */
  readonly dispatch: (event: WorkflowEvent) => void
  /**
   * Keep every bot with enabled workflows that `owns` accepts online, and delete expired run
   * records. Called once at startup, before the bot host resumes stored sessions.
   */
  readonly restore: (owns?: (botId: string) => boolean) => Promise<void>
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

/**
 * Replaces each secret in `text`. A workflow can log the interaction it handles, token included,
 * and Discord's errors can quote a request's path.
 */
const redactor =
  (secrets: ReadonlyArray<string>) =>
  (text: string): string =>
    secrets.reduce((redacted, secret) => redacted.replaceAll(secret, REDACTED), text)

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

/** `text` as Postgres can store it: it refuses NUL and lone surrogates, which JavaScript allows. */
const storable = (text: string) => text.replaceAll('\0', '�').replace(LONE_SURROGATE, '�')

/** A run's error, cut to what a record keeps. Its listener can throw any message. */
const clippedError = (text: string) =>
  text.length > RUN_LOG_LIMIT_CHARS ? `${text.slice(0, RUN_LOG_LIMIT_CHARS)} [truncated]` : text

/** A run's console lines, cut to what a record keeps. */
const storedLogs = (lines: ReadonlyArray<string>) => {
  const kept: string[] = []
  let chars = 0
  for (const line of lines) {
    chars += line.length
    if (chars > RUN_LOG_LIMIT_CHARS) return [...kept, '[logs truncated]']
    kept.push(line)
  }
  return kept
}

/** Workflows call Discord from their listeners only, never while loading. */
const refuseAll = async () =>
  Response.json(
    { code: 0, message: 'A workflow calls Discord only from its listeners.' },
    { status: 403 },
  )

interface Enabled {
  readonly revision: WorkflowRevision
  /** Replaced when compiling fails, so the next event compiles it again. */
  modules: Promise<ReadonlyArray<ScriptModule>>
  /** Aborted once the revision stops running: its queued runs never start, running ones end. */
  readonly stop: AbortController
}

/**
 * Load a revision's modules for later events; a failure is reported by the event that awaits it.
 * Revisions stored before bundles were are bundled from their source here.
 */
const compile = ({ source, bundle }: WorkflowRevision) => {
  const modules = (bundle === null ? bundleWorkflow(source) : Promise.resolve(bundle)).then(
    withRuntime,
  )
  modules.catch(() => {})
  return modules
}

/**
 * discord.js features that need state lasting across events, or uploads, which a fresh isolate
 * per event can't serve. Matched in the source as written, comments removed, so a call built at
 * runtime still gets past them.
 */
const UNSUPPORTED: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /\.(?:create(?:Message|Reaction|MessageComponent)Collector|await(?:Messages|Reactions|MessageComponent|ModalSubmit))\s*\(|\bnew\s+(?:Message|Reaction|Interaction)Collector\b/,
    'source: collectors and awaitMessages wait for later events, but each event runs in a fresh isolate, so they never fire. Handle the later event in its own listener.',
  ],
  [
    /\bfiles\s*:\s*\[[^\]]*?["'`]https?:\/\/|\battachment\s*:\s*["'`]https?:\/\/|\bnew\s+AttachmentBuilder\s*\(\s*["'`]https?:\/\//,
    "source: discord.js uploads a URL attachment as a file, and workflows can't upload files. Put the URL in the message content or an embed.",
  ],
]

/**
 * Check a workflow for what can't run in an isolate, then bundle it with its dependencies. Every
 * failure is the agent's to fix, so each becomes a validation error.
 */
const buildRevision = async (
  source: string,
  dependencies: Dependencies,
): Promise<{ readonly value: string; readonly packages: ReadonlyArray<string> }> => {
  const misuses = await transform(source, { loader: 'ts', logLevel: 'silent' }).then(
    ({ code }) => UNSUPPORTED.filter(([pattern]) => pattern.test(code)).map(([, issue]) => issue),
    // Bundling reports the syntax error.
    () => [],
  )
  if (misuses.length > 0) {
    throw invalid("The workflow uses discord.js features workflows can't run.", ...misuses)
  }
  const none =
    Object.keys(dependencies.dependencies).length === 0 && dependencies.lockfile === undefined
  try {
    return none
      ? { value: await bundleWorkflow(source), packages: [] }
      : await withDependencies(dependencies, (root) => bundleWorkflow(source, root))
  } catch (error) {
    if (error instanceof ScriptBuildError || error instanceof DependencyError) {
      throw invalid(error.message, ...error.issues)
    }
    throw error
  }
}

/** Identifies a revision across a delete and a republish under the same name. */
const revisionKey = ({ name, revision, publishedAt }: WorkflowRevision) =>
  `${name}:${revision}:${publishedAt.getTime()}`

/** Who a workflow's Discord calls run as, for the REST client's request context. */
const WORKFLOW_PRINCIPAL: Principal = { id: 'workflow', kind: 'discord-bot', scopes: new Set() }

/**
 * What a revision may see of an event: nothing outside its own intents, and in a guild, no
 * message content without MessageContent, as Discord applies it.
 */
const visibleTo = (revision: WorkflowRevision, kind: WorkflowEventKind, event: WorkflowEvent) => {
  const { d } = event.dispatch
  const inGuild = d.guild_id !== undefined
  const needed = inGuild ? kind.guild : kind.direct
  if ((revision.intents & needed) !== needed) return undefined
  const isMessage = kind.t === 'MESSAGE_CREATE' || kind.t === 'MESSAGE_UPDATE'
  if (!isMessage || !inGuild || (revision.intents & MESSAGE_CONTENT) !== 0) return event.dispatch
  return { t: kind.t, d: visibleMessage(d, event.botId) }
}

type Message = Record<string, unknown>

/**
 * A message as an app without MessageContent sees it. Each message, including the ones it quotes
 * or forwards, keeps its content only if the app wrote it or it mentions the app.
 */
const visibleMessage = (
  { referenced_message, message_snapshots, ...message }: Message,
  botId: string,
): Message => {
  const { poll: _, ...rest } = message
  const author = message.author as { id?: unknown } | undefined
  const mentioned = ((message.mentions ?? []) as ReadonlyArray<{ id?: unknown }>).some(
    (user) => user.id === botId,
  )
  return {
    ...(author?.id === botId || mentioned
      ? message
      : { ...rest, content: '', embeds: [], attachments: [], components: [] }),
    ...(referenced_message == null
      ? { referenced_message }
      : { referenced_message: visibleMessage(referenced_message as Message, botId) }),
    ...(Array.isArray(message_snapshots)
      ? {
          message_snapshots: message_snapshots.map((snapshot: { message?: Message }) => ({
            ...snapshot,
            ...(snapshot.message === undefined
              ? {}
              : { message: visibleMessage(snapshot.message, botId) }),
          })),
        }
      : {}),
  }
}

export const makeWorkflowHost = ({
  storage,
  isolates,
  bots,
  operations,
  registry,
  rest,
  log,
  now = Date.now,
}: WorkflowHostOptions): WorkflowHost => {
  /** Each bot's enabled revisions, compiled once and dropped whenever they change. */
  const enabled = new Map<string, Promise<ReadonlyArray<Enabled>>>()
  /** Routing for one bot runs in event order, so its guilds' queues fill in event order. */
  const routing = new Map<string, Promise<void>>()
  /** Refreshes for one bot run in order, so the last change decides what the bot host holds. */
  const refreshing = new Map<string, Promise<void>>()
  /**
   * Each bot's own user, which its isolates report as `client.user`, by the token it was read
   * with. A resumed session brings no READY to read it from.
   */
  const users = new Map<string, { readonly token: string; readonly user: Promise<unknown> }>()

  /**
   * Read the bot's enabled revisions. A revision still enabled keeps its entry from `previous`,
   * so the stop signal its queued runs carry is the one a later change aborts.
   */
  const load = (botId: string, previous: ReadonlyArray<Enabled> = []) => {
    const kept = new Map(previous.map((entry) => [revisionKey(entry.revision), entry]))
    const list = storage.enabledRevisions(botId).then((revisions) =>
      revisions.map(
        (revision) =>
          kept.get(revisionKey(revision)) ?? {
            revision,
            modules: compile(revision),
            stop: new AbortController(),
          },
      ),
    )
    enabled.set(botId, list)
    // A failed read is retried on the next event.
    list.catch(() => {
      if (enabled.get(botId) === list) enabled.delete(botId)
    })
    return list
  }

  const enabledFor = (botId: string) => enabled.get(botId) ?? load(botId)

  /**
   * Point the bot host and the dispatcher at the bot's enabled revisions after a change, and stop
   * every run of a revision that no longer runs.
   */
  const refresh = (botId: string) => {
    const done = (refreshing.get(botId) ?? Promise.resolve()).then(async () => {
      const previous = (await enabled.get(botId)?.catch(() => undefined)) ?? []
      const revisions = await load(botId, previous).catch((error: unknown) => {
        // The change is stored, but which revisions still run is unknown: stop them all, and let
        // the next event start the ones that are enabled afresh.
        for (const entry of previous) entry.stop.abort()
        throw error
      })
      for (const entry of previous) if (!revisions.includes(entry)) entry.stop.abort()
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

  const userFor = (botId: string, token: string) => {
    const current = users.get(botId)
    if (current?.token === token) return current.user
    const { client, release } = rest(botId, Redacted.make(token))
    const user = Effect.runPromise(
      client.request({ method: 'GET', route: '/users/@me', operationFamily: 'user' }),
    ).finally(release)
    const entry = { token, user }
    users.set(botId, entry)
    // A failed lookup is retried on the next event.
    user.catch(() => {
      if (users.get(botId) === entry) users.delete(botId)
    })
    return user
  }

  /** A workflow's own KV store, whichever revision runs. Its failures reach the operator. */
  const kvFor = (workflowId: string, label: string, redact: (text: string) => string): KvStore => {
    const reported = <A>(operation: Promise<A>) =>
      operation.catch((error: unknown) => {
        log(`${label}: KV failed: ${redact(String(error))}`)
        throw error
      })
    return {
      get: (key) => reported(storage.loadWorkflowValue(workflowId, key)),
      set: async (key, value) => {
        if (Buffer.byteLength(key) > KV_KEY_LIMIT_BYTES) {
          return `A KV key takes at most ${KV_KEY_LIMIT_BYTES} bytes.`
        }
        const { stored, bytes } = await reported(
          storage.storeWorkflowValue(workflowId, key, value, KV_LIMIT_BYTES),
        )
        return stored
          ? undefined
          : `The workflow's KV keys and values would take ${bytes} bytes, past its limit of ${KV_LIMIT_BYTES}. Delete keys to make room.`
      },
      delete: (key) => reported(storage.deleteWorkflowValue(workflowId, key)),
    }
  }

  let prunedAt = Number.NEGATIVE_INFINITY
  /** Delete expired run records, at most once an interval. Every bot host does, harmlessly. */
  const prune = () => {
    const at = now()
    if (at - prunedAt < PRUNE_INTERVAL_MS) return
    prunedAt = at
    storage
      .pruneWorkflowRuns(new Date(at - RUN_RETENTION_MS))
      .catch((error: unknown) => log(`Pruning workflow runs failed: ${String(error)}`))
  }

  /** Queue one workflow's run of one event. Enqueues before returning, so callers keep order. */
  const run = (
    event: WorkflowEvent,
    dispatch: GatewayEvent,
    workflow: Enabled,
    botUser: unknown,
    modules: ReadonlyArray<ScriptModule>,
  ) => {
    const { botId } = event
    const { client, release } = rest(botId, Redacted.make(event.token))
    const { d } = dispatch
    const { workflowId, name, revision, grants } = workflow.revision
    const label = `Workflow ${name} (revision ${revision}) of bot ${botId}`
    const isInteraction = dispatch.t === 'INTERACTION_CREATE'
    const receivedAt = new Date(now())
    const redact = redactor([
      event.token,
      ...(isInteraction && typeof d.token === 'string' && d.token !== '' ? [d.token] : []),
    ])
    /** Record this run. `error` arrives redacted and clipped; logs are redacted and cut here. */
    const record = (
      outcome: WorkflowRunOutcome,
      error: string | null,
      logs: ReadonlyArray<string>,
    ) =>
      storage
        .recordWorkflowRun(
          {
            workflowId,
            revision,
            event: dispatch.t,
            outcome,
            error: error === null ? null : storable(error),
            logs: storedLogs(logs.map((line) => storable(redact(line)))),
            receivedAt,
            finishedAt: new Date(now()),
          },
          RUNS_KEPT,
        )
        .then(prune, (error: unknown) =>
          log(`${label}: its run was not recorded: ${String(error)}`),
        )
    return isolates
      .run({
        // Each workflow sees a guild's events, and a direct message channel's, in order, and never
        // waits on another workflow. Interactions skip the queue: Discord needs an answer within
        // three seconds, whatever else the guild is doing.
        botId,
        queue: `${botId}:${name}:${
          isInteraction
            ? `interaction:${String(d.id)}`
            : String(d.guild_id ?? `direct:${String(d.channel_id)}`)
        }`,
        botUser,
        modules,
        timeoutMs: EVENT_TIMEOUT_MS,
        input: { event: dispatch },
        signal: workflow.stop.signal,
        urgent: isInteraction,
        // Discord drops an interaction not answered within three seconds of the event.
        ...(isInteraction ? { admitWithinMs: INTERACTION_ADMISSION_MS } : {}),
        broker: makeBroker({
          operations,
          grants,
          discord: (call, signal) =>
            client.request(call).pipe(
              // DiscordRest aborts its HTTP request with the request context's signal.
              Effect.provideService(McpRequestContext, {
                requestId: `${label}: ${dispatch.t}`,
                signal,
                progressToken: undefined,
                notify: undefined,
                principal: WORKFLOW_PRINCIPAL,
              }),
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
          kv: kvFor(workflowId, label, redact),
          // The URL can hold an interaction token, so only the reason is logged.
          onDenied: ({ method, reason }) => log(`${label}: refused ${method}: ${reason}`),
        }),
      })
      .then(
        (outcome) => {
          if (outcome.outcome === 'completed') return record('completed', null, outcome.logs)
          const reason = clippedError(redact(failure(outcome)))
          log(`${label} failed on ${dispatch.t}: ${reason}`)
          return record(outcome.outcome, reason, 'logs' in outcome ? outcome.logs : [])
        },
        (error: unknown) => {
          // Disabled or deleted while queued or running.
          if (workflow.stop.signal.aborted) return
          const reason = clippedError(redact(String(error)))
          log(`${label} did not run: ${reason}`)
          return record('skipped', reason, [])
        },
      )
      .finally(release)
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
    const [botUser, modules] = await Promise.all([
      userFor(event.botId, event.token),
      Promise.all(
        matching.map(({ workflow }) =>
          workflow.modules.catch((error: unknown) => {
            const { name, revision } = workflow.revision
            log(
              `Workflow ${name} (revision ${revision}) of bot ${event.botId} did not compile: ${String(error)}`,
            )
            workflow.modules = compile(workflow.revision)
            return undefined
          }),
        ),
      ),
    ])
    // Enqueued together, in order, so every workflow sees a guild's events in the order they came.
    matching.forEach(({ workflow, dispatch }, index) => {
      const compiled = modules[index]
      if (compiled !== undefined) void run(event, dispatch, workflow, botUser, compiled)
    })
  }

  const probe = async (caller: WorkflowCaller, modules: ReadonlyArray<ScriptModule>) => {
    const outcome = await isolates.run({
      botId: caller.botId,
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
    publish: async (caller, { name, source, grants, dependencies = {}, lockfile }) => {
      if (!NAME.test(name)) {
        throw invalid(
          'The name is not valid.',
          'name: use 1 to 63 lowercase letters, digits, and dashes, starting with a letter or digit.',
        )
      }
      if (Buffer.byteLength(source) > SOURCE_LIMIT_BYTES) {
        throw invalid(`The source exceeds ${SOURCE_LIMIT_BYTES} bytes.`)
      }
      const { value: bundle, packages } = await buildRevision(source, {
        dependencies,
        ...(lockfile === undefined ? {} : { lockfile }),
        ...(registry === undefined ? {} : { registry }),
      })
      const declared = await probe(caller, await withRuntime(bundle))
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
        bundle,
        packages,
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
                    packages: revision.packages,
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

    runs: (botId, query) =>
      storage.workflowRuns(botId, { ...query, since: new Date(now() - RUN_RETENTION_MS) }),

    dispatch: (event) => {
      const next = (routing.get(event.botId) ?? Promise.resolve())
        .then(() => route(event))
        .catch((error: unknown) =>
          log(`Bot ${event.botId}'s ${event.dispatch.t} reached no workflow: ${String(error)}`),
        )
      routing.set(event.botId, next)
    },

    restore: async (owns = () => true) => {
      prune()
      const intents = new Map<string, number>()
      for (const { botId, intents: own } of await storage.enabledRevisions()) {
        // Bot hosts share the database; each holds only the bots it owns.
        if (!owns(botId)) continue
        intents.set(botId, (intents.get(botId) ?? 0) | own)
      }
      await Promise.all([...intents].map(([botId, all]) => bots.hold(botId, all)))
    },
  }
}
