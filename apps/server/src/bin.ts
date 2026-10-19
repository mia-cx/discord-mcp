#!/usr/bin/env node
import { createServer } from 'node:http'
import { ConfigurationError } from '@discord-mcp/core'
import { DiscordRest, RateGuard } from '@discord-mcp/discord-api/relay'
import { NodeRuntime } from '@effect/platform-node'
import { toNodeHandler } from '@modelcontextprotocol/node'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { Cause, Config, Effect, Layer, Logger } from 'effect'
import { checkPublicExposure } from './public-exposure.ts'
import { buildRelayServer, createRelay, relayRuntime } from './relay.ts'

const StderrLogging = Layer.succeed(Logger.LogToStderr)(true)
const csv = (value: string) =>
  value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)

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
    // Stdio has one local caller. Its token is supplied by that caller's process environment.
    const token = yield* Config.redacted('DISCORD_TOKEN')
    const runtime = yield* Effect.acquireRelease(
      Effect.sync(() =>
        relayRuntime(DiscordRest.layer({ ...rest, token }).pipe(Layer.provide(RateGuard.layer()))),
      ),
      (runtime) => Effect.promise(() => runtime.dispose()),
    )
    yield* Effect.acquireRelease(
      Effect.sync(() => serveStdio(() => buildRelayServer(runtime))),
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
  const oauth = yield* Config.all({
    clientId: Config.string('DISCORD_OAUTH_CLIENT_ID'),
    clientSecret: Config.redacted('DISCORD_OAUTH_CLIENT_SECRET'),
    encryptionKey: Config.redacted('OAUTH_ENCRYPTION_KEY'),
  })
  const relay = createRelay({
    allowedHosts: csv(config.allowedHosts),
    allowedOrigins: [
      ...csv(config.allowedOrigins),
      ...(config.publicBaseUrl === '' ? [] : [new URL(config.publicBaseUrl).origin]),
    ],
    rest,
    login: {
      ...oauth,
      publicBaseUrl: config.publicBaseUrl || `http://127.0.0.1:${config.port}`,
    },
  })
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
