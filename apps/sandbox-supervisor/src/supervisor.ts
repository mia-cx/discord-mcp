import { SandboxError } from '@discord-mcp/core'
import type { CompiledManifest } from '@discord-mcp/workflow-sdk'
import { WORKFLOW_LIMITS } from '@discord-mcp/workflow-sdk'
import { Context, Effect, Layer } from 'effect'
import {
  artifactDigest,
  type BuildRequest,
  checkDependencies,
  lastStage,
  workspaceFiles,
} from './build.ts'
import {
  artifactVolume,
  buildSpec,
  CAPABILITY_VOLUME,
  containerName,
  DEFAULT_RUNTIME_LIMITS,
  type RevisionRef,
  type RuntimeLimits,
  runtimeSpec,
  validateRuntimeSpec,
} from './container-spec.ts'
import { DockerEngine } from './docker.ts'

/**
 * The supervisor.
 *
 * Five operations, no more: build, start, stop, inspect, destroy. Every one takes a revision
 * reference and derives what it needs; none takes a container name, image, mount, or limit from its
 * caller. The MCP server never holds the Docker socket, so a bug in a tool handler cannot become
 * container control.
 */

export interface BuildOutcome {
  readonly artifactDigest: string
  readonly manifest: CompiledManifest
  readonly logs: string
}

export interface StartRequest {
  readonly ref: RevisionRef
  readonly executionId: string
  readonly capabilityCredential: string
  readonly payload: unknown
  readonly limits?: RuntimeLimits
}

export interface StartOutcome {
  readonly containerId: string
  readonly exitCode: number
  readonly timedOut: boolean
  readonly logs: string
}

export interface SupervisorImages {
  readonly build: string
  readonly runtime: string
  readonly registry: string
}

export class Supervisor extends Context.Service<
  Supervisor,
  {
    readonly build: (request: BuildRequest) => Effect.Effect<BuildOutcome, SandboxError>
    readonly start: (request: StartRequest) => Effect.Effect<StartOutcome, SandboxError>
    readonly stop: (ref: RevisionRef) => Effect.Effect<void, SandboxError>
    readonly inspect: (ref: RevisionRef) => Effect.Effect<unknown, SandboxError>
    readonly destroy: (ref: RevisionRef) => Effect.Effect<void, SandboxError>
  }
>()('sandbox-supervisor/Supervisor') {
  static readonly layer = (
    images: SupervisorImages,
  ): Layer.Layer<Supervisor, never, DockerEngine> =>
    Layer.effect(Supervisor)(
      Effect.gen(function* () {
        const docker = yield* DockerEngine

        const buildIn = (request: BuildRequest) =>
          Effect.gen(function* () {
            const ref: RevisionRef = { workflowId: request.workflowId, revision: request.revision }
            const spec = buildSpec({
              ref,
              image: images.build,
              registry: images.registry,
              allowInstallScripts: request.allowInstallScripts,
            })

            yield* docker.createVolume(artifactVolume(ref))
            // Create, copy, then start. Starting first would run `build.sh` before it exists.
            yield* docker.create(spec)
            yield* docker.copyInto(spec.name, workspaceFiles(request))
            yield* docker.start(spec.name)

            const result = yield* docker.wait(spec.name, WORKFLOW_LIMITS.buildSeconds * 1000)
            const logs = yield* docker.logs(spec.name, WORKFLOW_LIMITS.logBytesPerExecution)

            if (result.timedOut) {
              return yield* Effect.fail(
                new SandboxError({
                  message: `The build did not finish within ${WORKFLOW_LIMITS.buildSeconds}s. It reached the "${lastStage(logs)}" stage.`,
                  phase: 'build',
                }),
              )
            }

            if (result.exitCode !== 0) {
              return yield* Effect.fail(
                new SandboxError({
                  message: `The build failed at the "${lastStage(logs)}" stage.`,
                  phase: 'build',
                  diagnostics: logs
                    .split('\n')
                    .filter((line) => line.trim().length > 0)
                    .slice(-40),
                }),
              )
            }

            const manifestJson = yield* docker.readFile(spec.name, '/artifact/manifest.json')
            // Part of the content address, so a dependency tree that resolved differently produces
            // a different artifact rather than silently reusing the old one.
            const lockfile = yield* docker.readFile(spec.name, '/artifact/pnpm-lock.yaml')

            const manifest = yield* Effect.try({
              try: () => JSON.parse(manifestJson) as CompiledManifest,
              catch: () =>
                new SandboxError({
                  message: 'The build produced an unreadable manifest.',
                  phase: 'build',
                }),
            })

            return {
              artifactDigest: artifactDigest({
                source: request.source,
                lockfile,
                manifest: manifestJson,
              }),
              manifest,
              logs,
            }
          })

        return {
          build: (request) =>
            Effect.gen(function* () {
              const rejections = checkDependencies(request.dependencies)
              if (rejections.length > 0) {
                return yield* Effect.fail(
                  new SandboxError({
                    message: 'One or more dependencies were rejected before the build started.',
                    phase: 'policy',
                    diagnostics: rejections.map((r) => `${r.name}: ${r.reason}`),
                  }),
                )
              }

              if (request.source.length > WORKFLOW_LIMITS.sourceBytes) {
                return yield* Effect.fail(
                  new SandboxError({
                    message: `Workflow source is ${request.source.length} bytes, over the ${WORKFLOW_LIMITS.sourceBytes}-byte limit.`,
                    phase: 'policy',
                  }),
                )
              }

              const ref = { workflowId: request.workflowId, revision: request.revision }
              // The build container always goes, success or failure. A surviving one holds a
              // resolved dependency tree and a network. A cleanup that itself failed must not mask
              // the build's own outcome, which is the thing an operator needs to see.
              return yield* Effect.ensuring(
                buildIn(request),
                Effect.ignore(docker.destroy(containerName(ref, 'build'))),
              )
            }),

          start: (request) =>
            Effect.gen(function* () {
              const spec = runtimeSpec({
                ref: request.ref,
                image: images.runtime,
                executionId: request.executionId,
                capabilityCredential: request.capabilityCredential,
                ...(request.limits === undefined ? {} : { limits: request.limits }),
              })

              // The supervisor built this spec itself, so a violation means the supervisor is
              // wrong — which is the only case where refusing to start is the right answer.
              const violations = validateRuntimeSpec(spec)
              if (violations.length > 0) {
                return yield* Effect.fail(
                  new SandboxError({
                    message:
                      'The derived container specification failed its own safety checks; no container was started.',
                    phase: 'start',
                    diagnostics: violations.map((v) => `${v.field}: ${v.reason}`),
                  }),
                )
              }

              const limits = request.limits ?? DEFAULT_RUNTIME_LIMITS

              return yield* Effect.ensuring(
                Effect.gen(function* () {
                  // Shared and long-lived: the control plane serves this execution's socket inside
                  // it before asking for the container, so creating it here is idempotent rather
                  // than per-execution setup.
                  yield* docker.createVolume(CAPABILITY_VOLUME)

                  // Nothing is copied in: the trigger payload is written beside the capability
                  // socket by the control plane before this call. Copying it to /tmp would not
                  // survive, because the tmpfs mounts over that path the moment the container
                  // starts.
                  const { containerId } = yield* docker.run(spec)

                  const result = yield* docker.wait(spec.name, limits.timeoutSeconds * 1000)
                  const logs = yield* docker.logs(spec.name, WORKFLOW_LIMITS.logBytesPerExecution)
                  return { containerId, exitCode: result.exitCode, timedOut: result.timedOut, logs }
                }),
                // Forced termination at the deadline. The execution's socket directory is the
                // control plane's to remove, since it is the one that created it.
                Effect.ignore(docker.destroy(containerName(request.ref, 'run'))),
              )
            }),

          stop: (ref) => docker.stop(containerName(ref, 'run')),
          inspect: (ref) => docker.inspect(containerName(ref, 'run')),
          destroy: (ref) =>
            Effect.andThen(
              docker.destroy(containerName(ref, 'run')),
              docker.removeVolume(artifactVolume(ref)),
            ),
        }
      }),
    )
}
