#!/usr/bin/env node
import { createServer } from 'node:http'
import { createBotRuntimes, createTokenVault, systemClock } from '@discord-mcp/bot-host'
import { ConfigurationError } from '@discord-mcp/core'
import { DiscordRest, RateGuard } from '@discord-mcp/discord-api/relay'
import { makeIsolateHost } from '@discord-mcp/isolate'
import { connectStorage } from '@discord-mcp/storage'
import { NodeRuntime } from '@effect/platform-node'
import { toNodeHandler } from '@modelcontextprotocol/node'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { Cause, Config, Effect, Layer, Logger, Redacted } from 'effect'
import { checkPublicExposure } from './public-exposure.ts'
import { buildRelayServer, createRelay, relayRuntime } from './relay.ts'

const StderrLogging = Layer.succeed(Logger.LogToStderr)(true)
const csv = (value: string) =>
  value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)

const VAULT_KEY_BYTES = 32

/**
 * Bot hosting keeps bots online and stores their tokens and Gateway sessions, resuming the bots
 * the previous process left online. It starts only with a database and an allowlist naming who
 * may use it; otherwise the process stays a plain relay.
 */
const startBotHosting = (allowedUserIds: ReadonlyArray<string> | undefined) =>
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
    return yield* Effect.acquireRelease(
      Effect.promise(async () => {
        const bots = createBotRuntimes({
          vault: createTokenVault(vaultKey, storage),
          clock: systemClock,
          log,
        })
        await bots.resume()
        return bots
      }),
      (bots) => Effect.promise(() => bots.close()),
    )
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
      Effect.sync(() => serveStdio(() => buildRelayServer(runtime, true))),
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

  yield* checkPublicExposure({
    bindHost: config.host,
    publicBaseUrl: config.publicBaseUrl || undefined,
    allowedHosts: csv(config.allowedHosts),
    trustProxyIdentity: false,
    trustedProxyCidrs: [],
  })
  const { allowedUserIds, ...oauth } = yield* Config.all({
    clientId: Config.string('DISCORD_OAUTH_CLIENT_ID'),
    clientSecret: Config.redacted('DISCORD_OAUTH_CLIENT_SECRET'),
    encryptionKey: Config.redacted('OAUTH_ENCRYPTION_KEY'),
    allowedUserIds: Config.string('DISCORD_OAUTH_ALLOWED_USER_IDS').pipe(Config.withDefault('*')),
  })
  const allowlist = allowedUserIds === '*' ? undefined : csv(allowedUserIds)
  const bots = yield* startBotHosting(allowlist)
  const relay = createRelay(
    {
      allowedHosts: csv(config.allowedHosts),
      allowedOrigins: [
        ...csv(config.allowedOrigins),
        ...(config.publicBaseUrl === '' ? [] : [new URL(config.publicBaseUrl).origin]),
      ],
      rest,
      login: {
        ...oauth,
        ...(allowlist === undefined ? {} : { allowedUserIds: allowlist }),
        publicBaseUrl: config.publicBaseUrl || `http://127.0.0.1:${config.port}`,
      },
    },
    undefined,
    fetch,
    bots,
  )
  const handle = toNodeHandler(relay)
  const server = yield* Effect.acquireRelease(
    Effect.tryPromise(
      () =>
        new Promise<ReturnType<typeof createServer>>((resolve, reject) => {
          const server = createServer((request, response) => {
            void handle(
              {
                method: request.method ?? 'GET',
                url: request.url ?? '/',
                headers: request.headers,
                [Symbol.asyncIterator]: () => request[Symbol.asyncIterator](),
              },
              response,
            )
          })
          server.once('error', reject)
          server.listen(config.port, config.host, () => resolve(server))
        }),
    ),
    (server) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve, reject) => {
            server.close((error) => (error === undefined ? resolve() : reject(error)))
          }),
      ),
  )
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : config.port
  yield* Effect.log(`discord-mcp listening on http://${config.host}:${port}/mcp`)
  return yield* Effect.never
})

const program = Layer.launch(Layer.effectDiscard(main)).pipe(
  Effect.tapCause((cause) =>
    Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.logError(cause),
  ),
  Effect.provide(StderrLogging),
)

NodeRuntime.runMain(program, { disableErrorReporting: true })
