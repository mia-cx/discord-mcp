#!/usr/bin/env node
import { createServer, type IncomingMessage } from 'node:http'
import { hostname } from 'node:os'
import type { Duplex } from 'node:stream'
import {
  type BotRuntimes,
  createBotRuntimes,
  createTokenVault,
  systemClock,
} from '@discord-mcp/bot-host'
import { ConfigurationError } from '@discord-mcp/core'
import {
  DiscordRest,
  OperationCatalog,
  RateGuard,
  type RestConfig,
} from '@discord-mcp/discord-api/relay'
import {
  makeIsolateHost,
  makeWorkflowHost,
  type WorkflowEvent,
  type WorkflowHost,
} from '@discord-mcp/isolate'
import { connectStorage } from '@discord-mcp/storage'
import { NodeRuntime } from '@effect/platform-node'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { Cause, Config, Effect, Layer, Logger, Redacted } from 'effect'
import { checkPublicExposure } from './public-exposure.ts'
import {
  buildRelayServer,
  createBotLimiters,
  createExecutor,
  createRelay,
  createTokenCheck,
  relayRuntime,
} from './relay.ts'
import { ownerOf } from './router.ts'
import { nodeListener } from './routes.ts'
import {
  createBotHost,
  forwardRoutesToBotHosts,
  forwardToBotHosts,
  forwardVoiceToBotHosts,
  routeDispatches,
} from './tiers.ts'
import { createVoiceUpgrade } from './voice.ts'

const StderrLogging = Layer.succeed(Logger.LogToStderr)(true)
const csv = (value: string) =>
  value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)

const VAULT_KEY_BYTES = 32

/** Where this process sits among the bot hosts sharing the database. */
interface Placement {
  /** This host's name among them, such as its URL. */
  readonly self: string
  readonly hostCount: number
  /** Whether this host's list makes it the bot's REST owner, which restores its workflows. */
  readonly owns: (botId: string) => boolean
  /**
   * Where the workflow events of this host's shards run: on the bot's REST owner, so their calls
   * share its one rate limiter.
   */
  readonly route: (local: {
    readonly bots: BotRuntimes
    readonly workflows: WorkflowHost
  }) => (event: WorkflowEvent) => void
}

/**
 * Bot hosting keeps bots online, stores their tokens and Gateway sessions, and runs their
 * workflows. It starts only with a database and an allowlist naming who may use it; otherwise the
 * process stays a plain relay.
 */
const startBotHosting = (
  allowedUserIds: ReadonlyArray<string> | undefined,
  rest: Omit<RestConfig, 'token'>,
  placement: Placement,
) =>
  Effect.gen(function* () {
    const databaseUrl = yield* Config.string('DATABASE_URL').pipe(Config.withDefault(''))
    if (databaseUrl === '') return undefined
    if (allowedUserIds === undefined || allowedUserIds.length === 0) {
      yield* Effect.logWarning(
        'Bot hosting is off: it needs DISCORD_OAUTH_ALLOWED_USER_IDS to list allowed users. Serving the relay only.',
      )
      return undefined
    }
    const vaultKey = Buffer.from(
      Redacted.value(yield* Config.redacted('TOKEN_VAULT_KEY')),
      'base64',
    )
    if (vaultKey.length !== VAULT_KEY_BYTES) {
      return yield* Effect.fail(
        new ConfigurationError({
          variable: 'TOKEN_VAULT_KEY',
          message: `Expected ${VAULT_KEY_BYTES} bytes, base64-encoded. Generate one with: openssl rand -base64 32`,
        }),
      )
    }
    const context = yield* Effect.context<never>()
    const log = (message: string) => Effect.runForkWith(context)(Effect.log(message))
    const storage = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () =>
          connectStorage(databaseUrl, (error) =>
            log(`Lost a Postgres connection; reconnecting on next use: ${error.message}`),
          ),
        catch: (cause) =>
          new ConfigurationError({
            variable: 'DATABASE_URL',
            message: `DATABASE_URL: ${cause instanceof Error ? cause.message : String(cause)}`,
          }),
      }),
      (storage) => Effect.promise(() => storage.close()),
    )
    const catalog = yield* Effect.provide(OperationCatalog, OperationCatalog.layer)
    // A bot's agent requests and workflows share its one rate limiter.
    const limiters = createBotLimiters(rest)
    // The runtimes hand events to the workflow host, which needs the runtimes in turn.
    let workflows: WorkflowHost | undefined
    let route: ((event: WorkflowEvent) => void) | undefined
    const bots = yield* Effect.acquireRelease(
      Effect.promise(async () => {
        const bots: BotRuntimes = createBotRuntimes({
          vault: createTokenVault(vaultKey, storage),
          storage,
          clock: systemClock,
          log,
          self: placement.self,
          hostCount: placement.hostCount,
          owns: placement.owns,
          onDispatch: (botId, t, d) => {
            const token = bots.tokenOf(botId)
            if (route === undefined || token === undefined) return
            if (typeof d !== 'object' || d === null) return
            route({ botId, token, dispatch: { t, d: d as Record<string, unknown> } })
          },
        })
        workflows = makeWorkflowHost({
          storage,
          isolates: makeIsolateHost(),
          // Schedules and routes act for a bot only while this host holds its REST lease.
          bots: {
            ...bots,
            tokenOf: (botId) => (bots.serves(botId) ? bots.tokenOf(botId) : undefined),
          },
          clock: systemClock,
          operations: catalog.all,
          rest: limiters.lend,
          log,
        })
        route = placement.route({ bots, workflows })
        // Brings the bots with enabled workflows online, wherever their shards run.
        await workflows.restore(placement.owns)
        return bots
      }),
      (bots) =>
        Effect.promise(async () => {
          // No tick fires for a bot that is going offline.
          await workflows?.close()
          await bots.close()
        }),
    )
    return { bots, workflows, limiters }
  })

/** Undefined allows any human. */
const allowedUsers = Config.string('DISCORD_OAUTH_ALLOWED_USER_IDS').pipe(
  Config.withDefault('*'),
  Config.map((ids) => (ids === '*' ? undefined : csv(ids))),
)

const BOT_HOST_SECRET_MIN_LENGTH = 32

const origin = (url: string) => {
  const parsed = URL.canParse(url) ? new URL(url) : undefined
  return parsed?.protocol === 'http:' || parsed?.protocol === 'https:' ? parsed.origin : undefined
}

/** The bot hosts central routes to, and the secret central proves itself to them with. */
const membership = Effect.gen(function* () {
  const { listed, secret } = yield* Config.all({
    listed: Config.string('BOT_HOSTS').pipe(Config.map(csv)),
    secret: Config.redacted('BOT_HOST_SECRET'),
  })
  const hosts = listed.map(origin).filter((host) => host !== undefined)
  if (hosts.length === 0 || hosts.length !== listed.length) {
    return yield* Effect.fail(
      new ConfigurationError({
        variable: 'BOT_HOSTS',
        message:
          'BOT_HOSTS must list every bot host\'s base URL, comma-separated, for example "http://bot-host-0.bot-host:3001,http://bot-host-1.bot-host:3001".',
      }),
    )
  }
  if (Redacted.value(secret).length < BOT_HOST_SECRET_MIN_LENGTH) {
    return yield* Effect.fail(
      new ConfigurationError({
        variable: 'BOT_HOST_SECRET',
        message: `Expected at least ${BOT_HOST_SECRET_MIN_LENGTH} characters. Generate one with: openssl rand -base64 32`,
      }),
    )
  }
  return { hosts, secret: Redacted.value(secret) }
})

interface Handler {
  readonly fetch: (request: Request) => Promise<Response>
  /** Takes over WebSocket upgrades: the voice socket. */
  readonly upgrade?: (request: IncomingMessage, socket: Duplex, head: Buffer) => void
  /** Runs at shutdown before the server closes, such as taking bots offline. */
  readonly close?: () => Promise<void>
}

/** Serve `handler` over HTTP until the program stops. */
const serve = (handler: Handler, host: string, port: number, name: string) =>
  Effect.gen(function* () {
    /** Upgraded sockets, which would hold the server open at shutdown. */
    const upgraded = new Set<Duplex>()
    const server = yield* Effect.acquireRelease(
      Effect.tryPromise(
        () =>
          new Promise<ReturnType<typeof createServer>>((resolve, reject) => {
            const server = createServer(
              // Only WebSocket upgrades go to the voice socket. Others, such as h2c, stay requests.
              {
                shouldUpgradeCallback: (request) =>
                  handler.upgrade !== undefined &&
                  request.headers.upgrade?.toLowerCase() === 'websocket',
              },
              nodeListener(handler),
            )
            server.on('upgrade', (request, socket, head) => {
              upgraded.add(socket)
              socket.once('close', () => upgraded.delete(socket))
              handler.upgrade?.(request, socket, head)
            })
            server.once('error', reject)
            server.listen(port, host, () => resolve(server))
          }),
      ),
      (server) =>
        Effect.promise(async () => {
          // Bots going offline close their voice sockets with 1001; whatever is left, such as a
          // central's relayed socket, is cut.
          await handler.close?.()
          for (const socket of upgraded) socket.destroy()
          await new Promise<void>((resolve, reject) => {
            server.close((error) => (error === undefined ? resolve() : reject(error)))
          })
        }),
    )
    const address = server.address()
    const bound = typeof address === 'object' && address !== null ? address.port : port
    yield* Effect.log(`${name} listening on http://${host}:${bound}/mcp`)
    return yield* Effect.never
  })

const main = Effect.gen(function* () {
  const config = yield* Config.all({
    transport: Config.string('MCP_TRANSPORT').pipe(Config.withDefault('http')),
    host: Config.string('MCP_HTTP_HOST').pipe(Config.withDefault('127.0.0.1')),
    port: Config.int('MCP_HTTP_PORT').pipe(Config.withDefault(3000)),
    publicBaseUrl: Config.string('PUBLIC_BASE_URL').pipe(Config.withDefault('')),
    allowedHosts: Config.string('ALLOWED_HOSTS').pipe(Config.withDefault('')),
    allowedOrigins: Config.string('ALLOWED_ORIGINS').pipe(Config.withDefault('')),
    timeoutMs: Config.int('DISCORD_MCP_REST_TIMEOUT_MS').pipe(Config.withDefault(15_000)),
  })
  const rest = { timeoutMs: config.timeoutMs, retries: 0, maxRateLimitWaitMs: 0 }

  if (config.transport === 'stdio') {
    // Stdio has one local caller. Its token is supplied by that caller's process environment, and
    // its scripts run on that caller's own machine.
    const token = yield* Config.redacted('DISCORD_TOKEN')
    const runtime = yield* Effect.acquireRelease(
      Effect.sync(() =>
        relayRuntime(
          DiscordRest.layer({ ...rest, token }).pipe(Layer.provide(RateGuard.layer())),
          makeIsolateHost(),
        ),
      ),
      (runtime) => Effect.promise(() => runtime.dispose()),
    )
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        serveStdio(() => buildRelayServer(runtime, { scripts: true, workflows: false })),
      ),
      (handle) => Effect.promise(() => handle.close()),
    )
    yield* Effect.log('discord-mcp ready on stdio')
    return yield* Effect.never
  }

  if (config.transport !== 'http') {
    return yield* Effect.fail(
      new ConfigurationError({
        variable: 'MCP_TRANSPORT',
        message: 'MCP_TRANSPORT must be "http" or "stdio".',
      }),
    )
  }

  const tier = yield* Config.string('DISCORD_MCP_TIER').pipe(Config.withDefault('all'))
  if (tier !== 'all' && tier !== 'central' && tier !== 'bot-host') {
    return yield* Effect.fail(
      new ConfigurationError({
        variable: 'DISCORD_MCP_TIER',
        message: 'DISCORD_MCP_TIER must be "all", "central", or "bot-host".',
      }),
    )
  }
  const allowlist = yield* allowedUsers
  // Running agent code is a platform feature, which an unrestricted relay never offers.
  const scripts = allowlist !== undefined
  const listen = (handler: Handler) =>
    serve(handler, config.host, config.port, tier === 'all' ? 'discord-mcp' : `discord-mcp ${tier}`)
  /** Voice sockets for this process's bots, which bot hosting serves. */
  const voiceFor = (hosting: { readonly bots: BotRuntimes } | undefined) =>
    hosting && createVoiceUpgrade({ bots: hosting.bots, checkToken: createTokenCheck({ rest }) })
  const closing = (hosting: { readonly bots: BotRuntimes } | undefined) =>
    hosting === undefined ? {} : { close: () => hosting.bots.close() }

  if (tier === 'bot-host') {
    const members = yield* membership
    const self = yield* Config.string('BOT_HOST_URL').pipe(Config.map(origin))
    if (self === undefined || !members.hosts.includes(self)) {
      return yield* Effect.fail(
        new ConfigurationError({
          variable: 'BOT_HOST_URL',
          message: "BOT_HOST_URL must be this bot host's base URL, exactly as BOT_HOSTS lists it.",
        }),
      )
    }
    const context = yield* Effect.context<never>()
    const log = (message: string) => Effect.runForkWith(context)(Effect.log(message))
    // Every bot host shares the database and runs its share of every online bot's shards.
    const hosting = yield* startBotHosting(allowlist, rest, {
      self,
      hostCount: members.hosts.length,
      owns: (botId) => ownerOf(members.hosts, botId) === self,
      route: (local) => routeDispatches({ ...members, self }, local, log),
    })
    return yield* listen({
      ...createBotHost({ ...members, self }, createExecutor({ rest, scripts, ...hosting }), {
        ...hosting,
        upgrade: voiceFor(hosting),
        route: hosting?.workflows?.serve,
      }),
      ...closing(hosting),
    })
  }

  yield* checkPublicExposure({
    bindHost: config.host,
    publicBaseUrl: config.publicBaseUrl || undefined,
    allowedHosts: csv(config.allowedHosts),
    trustProxyIdentity: false,
    trustedProxyCidrs: [],
  })
  const oauth = yield* Config.all({
    clientId: Config.string('DISCORD_OAUTH_CLIENT_ID'),
    clientSecret: Config.redacted('DISCORD_OAUTH_CLIENT_SECRET'),
    encryptionKey: Config.redacted('OAUTH_ENCRYPTION_KEY'),
  })
  // Central holds no bot tokens: it only forwards them, voice sockets, and workflow routes to the
  // bot host that owns each bot.
  const members = tier === 'central' ? yield* membership : undefined
  // Replicas of one process, such as during a rolling update, share shards like bot hosts, and
  // each serves every bot's REST traffic.
  const hosting =
    members === undefined
      ? yield* startBotHosting(allowlist, rest, {
          self: hostname(),
          hostCount: 1,
          owns: () => true,
          route: ({ workflows }) => workflows.dispatch,
        })
      : undefined
  const execute =
    members === undefined
      ? createExecutor({ rest, scripts, ...hosting })
      : forwardToBotHosts(members)
  const owners =
    members === undefined
      ? { upgrade: voiceFor(hosting), route: hosting?.workflows?.serve }
      : { upgrade: forwardVoiceToBotHosts(members), route: forwardRoutesToBotHosts(members) }
  const relay = createRelay(
    {
      allowedHosts: csv(config.allowedHosts),
      allowedOrigins: [
        ...csv(config.allowedOrigins),
        ...(config.publicBaseUrl === '' ? [] : [new URL(config.publicBaseUrl).origin]),
      ],
      login: {
        ...oauth,
        ...(allowlist === undefined ? {} : { allowedUserIds: allowlist }),
        publicBaseUrl: config.publicBaseUrl || `http://127.0.0.1:${config.port}`,
      },
    },
    execute,
    fetch,
    owners,
  )
  return yield* listen({ ...relay, ...closing(hosting) })
})

const program = Layer.launch(Layer.effectDiscard(main)).pipe(
  Effect.tapCause((cause) =>
    Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.logError(cause),
  ),
  Effect.provide(StderrLogging),
)

NodeRuntime.runMain(program, { disableErrorReporting: true })
