#!/usr/bin/env node
import { DiscordOAuth } from '@discord-mcp/auth'
import { routeInteraction } from '@discord-mcp/discord-api'
import { NodeRuntime } from '@effect/platform-node'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { Cause, Effect, Layer, Logger, ManagedRuntime } from 'effect'
import { AppLayer, httpAuthorize, stdioAuthorize } from './app.ts'
import { loadServerConfig } from './config.ts'
import { startHttpServer } from './http-server.ts'
import { buildMcpServer } from './mcp-server.ts'

/**
 * Under stdio, stdout carries the JSON-RPC stream and nothing else: one stray `console.log`
 * corrupts every subsequent message. `LogToStderr` is the switch that guarantees it, and Biome's
 * `suspicious/noConsole` rule is the second line of defence.
 */
const StderrLogging = Layer.succeed(Logger.LogToStderr)(true)

const main = Effect.gen(function* () {
  // A configuration failure is an operator problem, so it is reported as prose naming the
  // variable, not as a stack trace. runMain turns the die into a non-zero exit.
  const config = yield* Effect.catchTag(loadServerConfig, 'ConfigurationError', (e) =>
    Effect.die(new Error(`Configuration error in ${e.variable}: ${e.message}`)),
  )

  // One ManagedRuntime for the process. `Runtime<R>` was removed in v4, so this is the single
  // Effect<->Promise boundary every MCP handler crosses.
  const runtime = ManagedRuntime.make(AppLayer(config))

  if (config.transport === 'http') {
    const handle = yield* Effect.acquireRelease(
      startHttpServer({
        config: {
          host: config.http.host,
          port: config.http.port,
          allowedHosts: config.http.allowedHosts,
          publicBaseUrl: config.http.publicBaseUrl,
          proxy: {
            trustProxyIdentity: config.http.trustProxyIdentity,
            trustedProxyCidrs: config.http.trustedProxyCidrs,
            allowedHosts: config.http.allowedHosts,
            identityHeader: 'X-Forwarded-User',
            groupsHeader: 'X-Forwarded-Groups',
          },
          oidc: config.oidc,
        },
        // Rebuilt per connection here rather than once, because each carries a different
        // principal. Registration still happens before the listener accepts anything.
        buildServer: (resolve) =>
          buildMcpServer({ config, runtime, authorize: httpAuthorize(resolve) }),
        runtime,
        completeOAuth: (state, code) =>
          Effect.flatMap(DiscordOAuth, (oauth) => oauth.callback({ state, code })),
        ...(config.discordPublicKey === undefined
          ? {}
          : {
              handleInteraction: (inbound) =>
                Effect.map(
                  routeInteraction({
                    ...inbound,
                    publicKey: config.discordPublicKey as string,
                    now: Date.now(),
                  }),
                  (r) => ({ status: r.response.status, body: r.response.body }),
                ),
            }),
      }),
      (h) =>
        Effect.promise(async () => {
          await h.close()
          await runtime.dispose()
        }),
    )

    yield* Effect.log(`discord-mcp listening on http://${config.http.host}:${handle.port}/mcp`)
    yield* Effect.never
    return
  }

  yield* Effect.acquireRelease(
    Effect.sync(() =>
      serveStdio(() => buildMcpServer({ config, runtime, authorize: stdioAuthorize })),
    ),
    // Disposing the runtime runs layer finalizers in order, so the Discord client is torn down
    // before the process exits.
    (handle) =>
      Effect.promise(async () => {
        await handle.close()
        await runtime.dispose()
      }),
  )

  yield* Effect.log('discord-mcp ready on stdio')
  // Hold the scope open; finalizers run on SIGINT/SIGTERM via NodeRuntime.runMain.
  yield* Effect.never
})

/**
 * Report failures ourselves, inside the logging layer.
 *
 * `runMain`'s built-in reporting wraps the program with `Effect.tapCause(..., Effect.logError)`,
 * which therefore runs *outside* anything the program provides internally — so `LogToStderr` does
 * not reach it and a startup defect lands on stdout. Once the transport is up that corrupts the
 * JSON-RPC stream. Reporting inside the layer and disabling the built-in reporter is the fix; the
 * stdio-purity suite asserts it. Exit codes still come from the default teardown.
 */
export const program = Layer.launch(Layer.effectDiscard(main)).pipe(
  Effect.tapCause((cause) =>
    Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.logError(cause),
  ),
  Effect.provide(StderrLogging),
)

// A ConfigurationError surfaces here, printed with its offending variable and a non-zero exit.
NodeRuntime.runMain(program, { disableErrorReporting: true })
