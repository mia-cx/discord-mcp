#!/usr/bin/env node
import { NodeRuntime } from '@effect/platform-node'
import { Config, Effect, Layer, Redacted } from 'effect'
import { checkDaemon, DockerEngine } from './docker.ts'
import { serve } from './server.ts'
import { Supervisor } from './supervisor.ts'

/**
 * `discord-mcp-supervisor` — the only process that holds the rootless Docker socket.
 *
 * Run it as its own user. The MCP server reaches it through a Unix socket that user owns, so
 * compromising the server does not yield container control.
 */

const config = Config.all({
  socketPath: Config.string('DISCORD_MCP_SUPERVISOR_SOCKET').pipe(
    Config.withDefault('/run/discord-mcp/supervisor.sock'),
  ),
  // Redacted, so a startup log or an error report cannot print the credential that stands between
  // a local process and the Docker socket.
  serviceCredential: Config.redacted('DISCORD_MCP_SUPERVISOR_CREDENTIAL'),
  dockerHost: Config.string('DOCKER_HOST').pipe(
    Config.withDefault(`unix://${process.env.XDG_RUNTIME_DIR ?? '/run/user/1000'}/docker.sock`),
  ),
  dockerBinary: Config.string('DISCORD_MCP_DOCKER_BINARY').pipe(Config.withDefault('docker')),
  buildImage: Config.string('DISCORD_MCP_BUILD_IMAGE').pipe(
    Config.withDefault('discord-mcp/workflow-build:latest'),
  ),
  runtimeImage: Config.string('DISCORD_MCP_RUNTIME_IMAGE').pipe(
    Config.withDefault('discord-mcp/workflow-runner:latest'),
  ),
  registry: Config.string('DISCORD_MCP_NPM_REGISTRY').pipe(
    Config.withDefault('https://registry.npmjs.org/'),
  ),
})

const main = Effect.gen(function* () {
  // A missing credential is the common first-run mistake, and the raw ConfigError says only
  // "Invalid data <redacted>" — which names the variable but not what to do about it.
  const settings = yield* Effect.catchTag(config, 'ConfigError', () =>
    Effect.die(
      new Error(
        'DISCORD_MCP_SUPERVISOR_CREDENTIAL is not set. Generate one with `openssl rand -base64 32` and set the same value on both this supervisor and the control plane — it is what stops any other local process from driving the sandbox.',
      ),
    ),
  )

  const layer = Supervisor.layer({
    build: settings.buildImage,
    runtime: settings.runtimeImage,
    registry: settings.registry,
  }).pipe(
    // `provideMerge`, not `provide`: the startup preflight queries the daemon directly, so the
    // engine has to stay visible rather than being consumed by the supervisor.
    Layer.provideMerge(
      DockerEngine.layer({ binary: settings.dockerBinary, dockerHost: settings.dockerHost }),
    ),
  )

  yield* Effect.provide(
    Effect.gen(function* () {
      // Before anything can be asked to run: a daemon that cannot enforce the limits the sandbox
      // promises is worse than no sandbox, because everything downstream still reports as
      // constrained.
      const docker = yield* DockerEngine
      const capabilities = yield* docker.capabilities
      const problems = checkDaemon(capabilities)

      if (problems.length > 0) {
        yield* Effect.die(
          new Error(
            `The Docker daemon at ${settings.dockerHost} cannot enforce the sandbox's guarantees:\n${problems.map((p) => `  - ${p}`).join('\n')}`,
          ),
        )
      }

      if (!capabilities.rootless) {
        // Not fatal — an operator may have decided this is acceptable — but it invalidates the
        // isolation the rest of the design is built on, so it is said plainly and every time.
        yield* Effect.logWarning(
          'This is a ROOTFUL Docker daemon. A container escape is then a host root compromise, and none of the sandbox restrictions compensate for that. Run rootless, or accept that workflows are only as isolated as the kernel.',
        )
      }

      yield* Effect.log(
        `Supervisor ready on ${settings.socketPath} (${capabilities.rootless ? 'rootless' : 'rootful'}, cgroup v${capabilities.cgroupVersion})`,
      )

      return yield* serve({
        socketPath: settings.socketPath,
        serviceCredential: Redacted.value(settings.serviceCredential),
      })
    }),
    layer,
  )
})

NodeRuntime.runMain(main)
