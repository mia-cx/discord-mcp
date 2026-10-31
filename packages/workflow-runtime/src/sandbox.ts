import { SandboxError } from '@discord-mcp/core'
import type { CompiledManifest } from '@discord-mcp/workflow-sdk'
import { Context, Effect, Layer } from 'effect'

/**
 * The control plane's port to the sandbox.
 *
 * An interface rather than a backend client, so the dependency runs one way: the runtime states
 * what it needs, and the application wires it to whatever executes workflows. It also means the
 * lifecycle tools are testable without one.
 */

export interface SandboxBuild {
  readonly workflowId: string
  readonly revision: number
  readonly source: string
  readonly dependencies?: Readonly<Record<string, string>>
  readonly allowInstallScripts?: boolean
}

export interface SandboxBuildOutcome {
  readonly artifactDigest: string
  readonly manifest: CompiledManifest
  readonly logs: string
}

export interface SandboxRun {
  readonly workflowId: string
  readonly revision: number
  readonly executionId: string
  readonly capabilityCredential: string
  readonly payload: unknown
  readonly timeoutSeconds: number
}

export interface SandboxRunOutcome {
  readonly exitCode: number
  readonly timedOut: boolean
  readonly logs: string
}

export class SandboxSupervisor extends Context.Service<
  SandboxSupervisor,
  {
    readonly build: (input: SandboxBuild) => Effect.Effect<SandboxBuildOutcome, SandboxError>
    readonly run: (input: SandboxRun) => Effect.Effect<SandboxRunOutcome, SandboxError>
    readonly stop: (input: {
      readonly workflowId: string
      readonly revision: number
    }) => Effect.Effect<void, SandboxError>
    readonly destroy: (input: {
      readonly workflowId: string
      readonly revision: number
    }) => Effect.Effect<void, SandboxError>
  }
>()('workflow-runtime/SandboxSupervisor') {
  /**
   * A sandbox that refuses everything, for a server with no workflow execution backend.
   *
   * The alternative — omitting the service — would make every workflow tool fail at layer
   * construction rather than with an explanation the operator can act on.
   */
  static readonly unavailable = (reason: string): Layer.Layer<SandboxSupervisor> =>
    Layer.sync(SandboxSupervisor)(() => {
      const refuse = <A>(): Effect.Effect<A, SandboxError> =>
        Effect.fail(new SandboxError({ message: reason, phase: 'policy' }))

      return {
        build: () => refuse(),
        run: () => refuse(),
        stop: () => refuse(),
        destroy: () => refuse(),
      }
    })
}
