import type { Effect } from 'effect'

/**
 * MCP resources: read-only detail, addressed by URI.
 *
 * These exist so a tool result can stay small. A tool that returns a 40 KiB operation schema pushes
 * everything else out of a model's context to answer a question it may not have asked; a tool that
 * returns a resource link lets the model fetch the detail only when it needs it.
 *
 * Everything here is readable through some tool as well. A resource is never the only way to reach
 * something, because not every client supports them.
 */

export interface ResourceContents {
  readonly uri: string
  readonly mimeType: string
  readonly text: string
}

export interface ResourceDef<R> {
  readonly name: string
  readonly title: string
  readonly description: string
  /**
   * Either a literal URI or an RFC 6570 template. A template carries a `list` callback so a client
   * can enumerate what exists rather than guessing identifiers.
   */
  readonly uri: string
  readonly mimeType: string
  /** Absent for a fixed URI; present for a template, and the variables it declares. */
  readonly variables?: ReadonlyArray<string>
  readonly read: (variables: Record<string, string>) => Effect.Effect<unknown, unknown, R>
  /** Enumerate concrete URIs for a template. `undefined` means "cannot be listed", not "empty". */
  readonly list?: () => Effect.Effect<
    ReadonlyArray<{ readonly uri: string; readonly name: string }>,
    unknown,
    R
  >
}

export const defineResource = <R>(d: ResourceDef<R>): ResourceDef<R> => d

/** A resource erased of its type parameter, for storage in a heterogeneous registry. */
// biome-ignore lint/suspicious/noExplicitAny: proven at each `defineResource` call site.
export type AnyResourceDef = ResourceDef<any>

/**
 * A link a tool result can carry instead of the detail itself.
 *
 * MCP defines `resource_link` for exactly this, and a model that wants the detail fetches it.
 */
export const resourceLink = (uri: string, name: string, description?: string) => ({
  type: 'resource_link' as const,
  uri,
  name,
  ...(description === undefined ? {} : { description }),
})
