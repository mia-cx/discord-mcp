import { defineTool, McpRequestContext, ValidationError } from '@discord-mcp/core'
import { DiscordRest } from '@discord-mcp/discord-api/relay'
import { OperationCatalog } from '@mia-cx/discord-catalog'
import { Context, Effect, Schema } from 'effect'
import { type Denial, makeBroker } from './broker.ts'
import { prepareScript, ScriptBuildError } from './bundle.ts'
import type { ScriptGrants } from './grants.ts'
import type { IsolateHost } from './isolate-host.ts'

const SOURCE_LIMIT_BYTES = 256 * 1024
const DEFAULT_TIMEOUT_SECONDS = 30
const MAX_TIMEOUT_SECONDS = 120
const DENIALS_REPORTED = 20

/** The process-wide isolate host. It outlives each request; the token it never sees does not. */
export class ScriptRunner extends Context.Service<ScriptRunner, IsolateHost>()(
  'isolate/ScriptRunner',
) {}

const Names = Schema.optionalKey(Schema.Array(Schema.String))

const Input = Schema.Struct({
  source: Schema.String,
  grants: Schema.Struct({ operations: Names, families: Names, hosts: Names }),
  timeoutSeconds: Schema.optionalKey(
    Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: MAX_TIMEOUT_SECONDS }))),
  ),
})

/** Unknown names in a grant are typos, and a typo would otherwise surface as a denial mid-run. */
const resolveGrants = (input: typeof Input.Type.grants) =>
  Effect.gen(function* () {
    const catalog = yield* OperationCatalog
    const grants: ScriptGrants = {
      operations: input.operations ?? [],
      families: input.families ?? [],
      hosts: input.hosts ?? [],
    }
    const ids = new Set(catalog.all.map((operation) => operation.operationId))
    const families = new Set<string>(catalog.all.map((operation) => operation.family))
    const issues = [
      ...grants.operations
        .filter((id) => !ids.has(id))
        .map(
          (id) => `grants.operations: unknown operation "${id}"; find it with discord_api_search.`,
        ),
      ...grants.families
        .filter((family) => !families.has(family))
        .map((family) => `grants.families: unknown family "${family}".`),
    ]
    if (issues.length === 0) return grants
    return yield* Effect.fail(
      new ValidationError({ message: 'The grants name unknown operations or families.', issues }),
    )
  })

const prepare = (source: string) =>
  Buffer.byteLength(source) > SOURCE_LIMIT_BYTES
    ? Effect.fail(
        new ValidationError({
          message: `The source exceeds ${SOURCE_LIMIT_BYTES} bytes.`,
          issues: ['source: split the work across several scripts.'],
        }),
      )
    : Effect.promise(() => prepareScript(source)).pipe(
        Effect.catchDefect((error) =>
          error instanceof ScriptBuildError
            ? Effect.fail(new ValidationError({ message: error.message, issues: error.issues }))
            : Effect.die(error),
        ),
      )

export const scriptRun = defineTool({
  name: 'discord_script_run',
  title: 'Run a discord.js script',
  description: [
    'Run one-off discord.js code as this bot, so many Discord calls cost one tool call.',
    '`source` is a JavaScript or TypeScript module whose default export is `async ({ client }) => result`; `client` is a discord.js Client already logged in as the bot, with REST only and no Gateway. Import only from discord.js and node:*, with no top-level await. The result must be JSON-serializable; console output comes back as logs.',
    'Every request the script makes is checked against `grants`: `operations` lists catalog operation IDs; `families` grants every read and write operation in a family, never a destructive or admin one, which must be listed in `operations`; `hosts` lists hostnames reachable with fetch(). Private, loopback, and link-local addresses are never reachable. A refused call fails in the script with a 403 and is listed under `denied`.',
    `The script is stopped after timeoutSeconds (default ${DEFAULT_TIMEOUT_SECONDS}, at most ${MAX_TIMEOUT_SECONDS}). JSON bodies only; file uploads and Gateway-only calls such as setPresence are unsupported.`,
  ].join('\n\n'),
  toolset: 'api',
  risk: 'destructive',
  scopes: [],
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  input: Input,
  handler: (args: typeof Input.Type) =>
    Effect.gen(function* () {
      const grants = yield* resolveGrants(args.grants)
      const modules = yield* prepare(args.source)
      const catalog = yield* OperationCatalog
      const rest = yield* DiscordRest
      const runner = yield* ScriptRunner
      const context = yield* McpRequestContext
      const bot = (yield* rest.request({
        method: 'GET',
        route: '/users/@me',
        operationFamily: 'user',
      })) as { readonly id: string }

      const denied: Denial[] = []
      const broker = makeBroker({
        operations: catalog.all,
        grants,
        // DiscordRest takes its abort signal from the request context; the script's is narrower.
        discord: (call, signal) =>
          rest.request(call).pipe(Effect.provideService(McpRequestContext, { ...context, signal })),
        onDenied: (denial) => {
          if (denied.length < DENIALS_REPORTED) denied.push(denial)
        },
      })
      // A failure here is workerd failing to run at all: a defect, not something the agent can fix.
      const outcome = yield* Effect.promise((signal) =>
        runner.run({
          botId: bot.id,
          botUser: bot,
          modules,
          timeoutMs: (args.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000,
          broker,
          signal,
        }),
      )
      return { ...outcome, denied }
    }),
})
