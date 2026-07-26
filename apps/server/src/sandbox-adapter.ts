import { SandboxError } from '@discord-mcp/core'
import { SupervisorClient } from '@discord-mcp/sandbox-supervisor'
import { SandboxSupervisor } from '@discord-mcp/workflow-runtime'
import type { CompiledManifest } from '@discord-mcp/workflow-sdk'
import { Effect, Layer, Schema } from 'effect'

/**
 * Wiring the runtime's sandbox port to the supervisor socket.
 *
 * This is the whole of the server's relationship with containers: it can ask for a build or a run
 * by workflow and revision, and nothing else. The Docker socket lives in another process, owned by
 * another user.
 */

/** The supervisor's replies are `unknown` on the wire; decode rather than assert. */
const BuildResult = Schema.Struct({
  artifactDigest: Schema.String,
  manifest: Schema.Unknown,
  logs: Schema.String,
})

const RunResult = Schema.Struct({
  exitCode: Schema.Number,
  timedOut: Schema.Boolean,
  logs: Schema.String,
})

const decode = <S extends Schema.Top>(schema: S, value: unknown, what: string) =>
  Effect.mapError(
    Schema.decodeUnknownEffect(schema)(value),
    () =>
      new SandboxError({
        message: `The sandbox supervisor returned a ${what} this server does not understand. Check that both are the same version.`,
        phase: 'protocol',
      }),
  )

export const SandboxSupervisorLayer: Layer.Layer<SandboxSupervisor, never, SupervisorClient> =
  Layer.effect(SandboxSupervisor)(
    Effect.map(SupervisorClient, (client) => ({
      build: (input) =>
        Effect.flatMap(
          client.send({
            kind: 'build',
            workflowId: input.workflowId,
            revision: input.revision,
            source: input.source,
            dependencies: { ...(input.dependencies ?? {}) },
            allowInstallScripts: input.allowInstallScripts ?? false,
          }),
          (result) =>
            Effect.map(decode(BuildResult, result, 'build result'), (decoded) => ({
              artifactDigest: decoded.artifactDigest,
              // Validated by the SDK's own compiler on the way in; the supervisor only carries it.
              manifest: decoded.manifest as CompiledManifest,
              logs: decoded.logs,
            })),
        ),

      run: (input) =>
        Effect.flatMap(
          client.send({
            kind: 'start',
            workflowId: input.workflowId,
            revision: input.revision,
            executionId: input.executionId,
            capabilityCredential: input.capabilityCredential,
            payload: input.payload,
            timeoutSeconds: input.timeoutSeconds,
          }),
          (result) => decode(RunResult, result, 'run result'),
        ),

      stop: (input) =>
        Effect.asVoid(
          client.send({ kind: 'stop', workflowId: input.workflowId, revision: input.revision }),
        ),

      destroy: (input) =>
        Effect.asVoid(
          client.send({ kind: 'destroy', workflowId: input.workflowId, revision: input.revision }),
        ),
    })),
  )
