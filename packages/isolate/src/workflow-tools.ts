import { defineTool, ValidationError } from '@discord-mcp/core'
import { DiscordRest } from '@discord-mcp/discord-api/relay'
import type { WorkflowRevision } from '@discord-mcp/storage'
import { Context, Effect, Schema } from 'effect'
import { GrantsInput, resolveGrants } from './tool.ts'
import { EVENT_TIMEOUT_MS, intentNames, WORKFLOW_EVENTS, type WorkflowHost } from './workflows.ts'

/** The process's workflow host, and the Discord user whose relay login made this request. */
export class Workflows extends Context.Service<
  Workflows,
  { readonly host: WorkflowHost; readonly actorId: string }
>()('isolate/Workflows') {}

/** The host and the caller: the bot this request's token belongs to, and the acting human. */
const access = Effect.gen(function* () {
  const { host, actorId } = yield* Workflows
  const rest = yield* DiscordRest
  const bot = (yield* rest.request({
    method: 'GET',
    route: '/users/@me',
    operationFamily: 'user',
  })) as { readonly id: string }
  return { host, rest, caller: { botId: bot.id, botUser: bot, actorId } }
})

/** The host's validation errors are the agent's to fix; anything else is a defect. */
const attempt = <A>(run: () => Promise<A>) =>
  Effect.promise(run).pipe(
    Effect.catchDefect((error) =>
      error instanceof ValidationError ? Effect.fail(error) : Effect.die(error),
    ),
  )

const describeRevision = ({ name, revision, events, intents, grants }: WorkflowRevision) => ({
  name,
  revision,
  events,
  intents: intentNames(intents),
  grants,
})

const Name = Schema.String.annotate({ description: 'The workflow name, unique per bot.' })

const PublishInput = Schema.Struct({
  name: Name,
  source: Schema.String,
  grants: GrantsInput,
})

export const workflowPublish = defineTool({
  name: 'discord_workflow_publish',
  title: 'Publish a workflow',
  description: [
    "Publish discord.js code that runs as this bot on Gateway events, even while no agent is connected. Each publish stores the workflow's next immutable revision; it runs only once enabled with discord_workflow_enable.",
    `\`source\` is a module that creates a discord.js Client at the top level and adds listeners, as an ordinary bot does; \`login()\` does nothing. It can listen for ${Object.keys(WORKFLOW_EVENTS).join(', ')}, and receives the events its Client's intents cover. Import only from discord.js and node:*, with no top-level await.`,
    `Each event runs in a fresh isolate for at most ${EVENT_TIMEOUT_MS / 1000} seconds, so nothing in memory lasts between events: collectors and awaitMessages never fire, and caches start empty, so listeners may receive partial objects (check `.partial` and fetch). Without MessageContent, guild messages arrive without content unless they mention the bot. Events of one guild run in order. The bot's own messages are not delivered.`,
    'Every request the workflow makes is checked against `grants`, as for discord_script_run. Answering an interaction (reply, deferReply, editReply, followUp) needs the `interaction` and `webhook` families or those operations, and works only for the interaction being handled. setPresence needs no grant.',
    '`name` is unique per bot: lowercase letters, digits, and dashes. Publishing an existing name adds a revision and leaves the running one in place.',
  ].join('\n\n'),
  toolset: 'api',
  risk: 'destructive',
  scopes: [],
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  input: PublishInput,
  handler: (args: typeof PublishInput.Type) =>
    Effect.gen(function* () {
      const grants = yield* resolveGrants(args.grants)
      const { host, caller } = yield* access
      const revision = yield* attempt(() =>
        host.publish(caller, { name: args.name, source: args.source, grants }),
      )
      return { ...describeRevision(revision), enabled: false }
    }),
})

const ListInput = Schema.Struct({})

export const workflowList = defineTool({
  name: 'discord_workflow_list',
  title: 'List workflows',
  description:
    "List this bot's workflows: each one's latest revision, and the revision it runs with its events, intents, and grants. `changes` lists the 20 most recent publishes, enables, disables, and deletes, newest first, with the Discord user ID of the human who made each.",
  toolset: 'api',
  risk: 'read',
  scopes: [],
  annotations: { readOnlyHint: true, openWorldHint: false },
  input: ListInput,
  handler: () =>
    Effect.gen(function* () {
      const { host, caller } = yield* access
      return yield* attempt(() => host.list(caller.botId))
    }),
})

const EnableInput = Schema.Struct({
  name: Name,
  revision: Schema.optionalKey(
    Schema.Int.annotate({ description: 'The revision to run. Defaults to the latest.' }),
  ),
})

export const workflowEnable = defineTool({
  name: 'discord_workflow_enable',
  title: 'Enable a workflow',
  description:
    "Run a workflow revision, the latest by default, on this bot's Gateway events, replacing the revision it ran before. While any workflow is enabled the bot stays online without agent calls. Returns the grants and intents the revision runs with: show them to the human you act for. Privileged intents (MessageContent, GuildMembers, GuildPresences) must be turned on in the Discord Developer Portal first.",
  toolset: 'api',
  risk: 'destructive',
  scopes: [],
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  input: EnableInput,
  handler: (args: typeof EnableInput.Type) =>
    Effect.gen(function* () {
      const { host, rest, caller } = yield* access
      const application = (yield* rest.request({
        method: 'GET',
        route: '/applications/@me',
        operationFamily: 'application',
      })) as { readonly flags?: number }
      const revision = yield* attempt(() =>
        host.enable(caller, args.name, args.revision, application.flags ?? 0),
      )
      return { ...describeRevision(revision), enabled: true }
    }),
})

const NameInput = Schema.Struct({ name: Name })

export const workflowDisable = defineTool({
  name: 'discord_workflow_disable',
  title: 'Disable a workflow',
  description:
    'Stop running a workflow. Its revisions stay; enable it again to resume. With no workflow enabled, the bot goes offline 24 hours after the last agent call.',
  toolset: 'api',
  risk: 'write',
  scopes: [],
  annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
  input: NameInput,
  handler: (args: typeof NameInput.Type) =>
    Effect.gen(function* () {
      const { host, caller } = yield* access
      yield* attempt(() => host.disable(caller, args.name))
      return { name: args.name, enabled: false }
    }),
})

export const workflowDelete = defineTool({
  name: 'discord_workflow_delete',
  title: 'Delete a workflow',
  description:
    'Stop a workflow and delete every revision of it. Its entries in the change log stay. This cannot be undone.',
  toolset: 'api',
  risk: 'destructive',
  scopes: [],
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  input: NameInput,
  handler: (args: typeof NameInput.Type) =>
    Effect.gen(function* () {
      const { host, caller } = yield* access
      yield* attempt(() => host.delete(caller, args.name))
      return { name: args.name, deleted: true }
    }),
})

export const workflowTools = [
  workflowPublish,
  workflowList,
  workflowEnable,
  workflowDisable,
  workflowDelete,
] as const
