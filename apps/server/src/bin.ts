#!/usr/bin/env node
import { NodeRuntime } from '@effect/platform-node'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { Cause, Effect, Layer, Logger, ManagedRuntime } from 'effect'
import { AppLayer, stdioAuthorize } from './app.ts'
import { loadServerConfig } from './config.ts'
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

  if (config.transport !== 'stdio') {
    // The authenticated Streamable HTTP transport lands in phase 6 together with the principal
    // resolution it exists to enforce. Shipping the port without the auth would be worse than
    // not shipping it.
    return yield* Effect.die(
      new Error('MCP_TRANSPORT=http is not implemented yet; use stdio (the default).'),
    )
  }

  // One ManagedRuntime for the process. `Runtime<R>` was removed in v4, so this is the single
  // Effect<->Promise boundary every MCP handler crosses.
  const runtime = ManagedRuntime.make(AppLayer(config))

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
