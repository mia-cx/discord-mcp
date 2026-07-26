import { Schema } from 'effect'

/**
 * Sandbox failures.
 *
 * `phase` is what an operator needs first: a build that failed to compile is a workflow author's
 * problem, an engine failure is theirs.
 */
export class SandboxError extends Schema.TaggedErrorClass<SandboxError>()('SandboxError', {
  message: Schema.String,
  phase: Schema.Literals(['engine', 'build', 'start', 'protocol', 'policy']),
  diagnostics: Schema.optionalKey(Schema.Array(Schema.String)),
}) {}
