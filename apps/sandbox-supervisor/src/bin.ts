#!/usr/bin/env node
import { NodeRuntime } from '@effect/platform-node'
import { Config, Effect, Layer, Redacted } from 'effect'
import { DockerEngine } from './docker.ts'
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
  const settings = yield* config

  const layer = Supervisor.layer({
    build: settings.buildImage,
    runtime: settings.runtimeImage,
    registry: settings.registry,
  }).pipe(
    Layer.provide(
      DockerEngine.layer({ binary: settings.dockerBinary, dockerHost: settings.dockerHost }),
    ),
  )

  yield* Effect.provide(
    serve({
      socketPath: settings.socketPath,
      serviceCredential: Redacted.value(settings.serviceCredential),
    }),
    layer,
  )
})

NodeRuntime.runMain(main)
