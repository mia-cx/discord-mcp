import type { McpServer } from '@modelcontextprotocol/server'
import { ResourceTemplate } from '@modelcontextprotocol/server'
import type { ManagedRuntime } from 'effect'
import type { AnyResourceDef, ResourceContents } from './resources.ts'
import { renderCause } from './result.ts'

/**
 * Registering resources on an MCP server.
 *
 * The same shape as the tool registry and for the same reason: everything is registered before any
 * transport accepts a connection, so a broken definition fails startup rather than breaking
 * `resources/list` for a client that is already connected.
 */

const encode = (uri: string, mimeType: string, value: unknown): ResourceContents => ({
  uri,
  mimeType,
  text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
})

export const registerResources = <R>(options: {
  readonly server: McpServer
  readonly resources: ReadonlyArray<AnyResourceDef>
  readonly runtime: ManagedRuntime.ManagedRuntime<R, never>
}): void => {
  for (const resource of options.resources) {
    const metadata = {
      title: resource.title,
      description: resource.description,
      mimeType: resource.mimeType,
    }

    const read = async (uri: URL, variables: Record<string, string>) => {
      const exit = await options.runtime.runPromiseExit(
        resource.read(variables) as Parameters<typeof options.runtime.runPromiseExit>[0],
      )

      if (exit._tag === 'Failure') {
        // A resource read has no `isError` channel the way a tool result does, so a failure has to
        // throw. The rendered payload still carries the suggestion, because this is often the
        // first thing a model sees about a URI it constructed itself.
        const rendered = renderCause(exit.cause)
        throw new Error(`${rendered.message} ${rendered.suggestion}`)
      }

      return { contents: [encode(uri.href, resource.mimeType, exit.value)] }
    }

    if (resource.variables === undefined) {
      options.server.registerResource(resource.name, resource.uri, metadata, (uri) => read(uri, {}))
      continue
    }

    const template = new ResourceTemplate(resource.uri, {
      list:
        resource.list === undefined
          ? undefined
          : async () => {
              const exit = await options.runtime.runPromiseExit(
                resource.list?.() as Parameters<typeof options.runtime.runPromiseExit>[0],
              )
              // An unlistable resource is not an error; the template still resolves by URI.
              return exit._tag === 'Success'
                ? {
                    resources: (exit.value as ReadonlyArray<{ uri: string; name: string }>).map(
                      (entry) => ({ ...entry, mimeType: resource.mimeType }),
                    ),
                  }
                : { resources: [] }
            },
    })

    options.server.registerResource(resource.name, template, metadata, (uri, variables) =>
      read(
        uri,
        Object.fromEntries(
          Object.entries(variables).map(([key, value]) => [
            key,
            Array.isArray(value) ? (value[0] ?? '') : String(value),
          ]),
        ),
      ),
    )
  }
}
