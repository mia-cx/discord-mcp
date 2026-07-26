import { Schema } from 'effect'

/**
 * The server↔supervisor protocol.
 *
 * Newline-delimited JSON over a private Unix socket. Every request carries a service credential; the
 * socket's filesystem permissions are the first gate and the credential is the second, because a
 * permission bit is one `chmod` away from being wrong.
 *
 * Note what these messages *cannot* express: a container name, an image, a mount, a network, or a
 * resource limit. All of those are derived inside the supervisor from `workflowId` and `revision`.
 */

const RevisionFields = {
  workflowId: Schema.String.pipe(Schema.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,64}$/))),
  revision: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
}

export const BuildCommand = Schema.Struct({
  kind: Schema.Literal('build'),
  ...RevisionFields,
  source: Schema.String,
  dependencies: Schema.Record(Schema.String, Schema.String),
  allowInstallScripts: Schema.Boolean,
})

export const StartCommand = Schema.Struct({
  kind: Schema.Literal('start'),
  ...RevisionFields,
  executionId: Schema.String,
  capabilityCredential: Schema.String,
  payload: Schema.Unknown,
  timeoutSeconds: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
})

export const StopCommand = Schema.Struct({ kind: Schema.Literal('stop'), ...RevisionFields })
export const InspectCommand = Schema.Struct({ kind: Schema.Literal('inspect'), ...RevisionFields })
export const DestroyCommand = Schema.Struct({ kind: Schema.Literal('destroy'), ...RevisionFields })

export const SupervisorCommand = Schema.Union([
  BuildCommand,
  StartCommand,
  StopCommand,
  InspectCommand,
  DestroyCommand,
])
export type SupervisorCommand = typeof SupervisorCommand.Type

export const SupervisorRequest = Schema.Struct({
  id: Schema.String,
  credential: Schema.String,
  command: SupervisorCommand,
})
export type SupervisorRequest = typeof SupervisorRequest.Type

export const SupervisorResponse = Schema.Union([
  Schema.Struct({ id: Schema.String, ok: Schema.Literal(true), result: Schema.Unknown }),
  Schema.Struct({
    id: Schema.String,
    ok: Schema.Literal(false),
    error: Schema.Struct({
      message: Schema.String,
      phase: Schema.String,
      diagnostics: Schema.optionalKey(Schema.Array(Schema.String)),
    }),
  }),
])
export type SupervisorResponse = typeof SupervisorResponse.Type

/** One request must not be able to exhaust the supervisor's memory before it is even parsed. */
export const MAX_REQUEST_BYTES = 512 * 1024

/** Owner-only. The socket is the Docker socket by proxy. */
export const SOCKET_MODE = 0o600
