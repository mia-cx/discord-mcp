import { catalogResources, OperationCatalog } from '@discord-mcp/discord-api'
import { Effect, Layer } from 'effect'
import { describe, expect, it } from 'vitest'
import { allResources } from '../src/app.ts'
import { stubRest, withClient } from './support/harness.ts'

/**
 * Resources, over a real MCP client.
 *
 * The reason these exist is size: one operation's JSON Schema can run to tens of kilobytes, and
 * returning that from a tool crowds out whatever the model was actually doing. So the assertions
 * that matter are that the detail is reachable and that it is *not* in the tool result.
 */

const read = async (
  client: Parameters<Parameters<typeof withClient>[2]>[0],
  uri: string,
): Promise<{ text: string }> => {
  const result = (await client.readResource({ uri })) as {
    contents: ReadonlyArray<{ text?: string }>
  }
  return { text: result.contents.map((c) => c.text ?? '').join('') }
}

describe('catalog resources', () => {
  it('serves one operation in full, including its request body schema', async () => {
    await withClient(
      stubRest(() => Effect.succeed({})),
      [],
      async (client) => {
        const { text } = await read(client, 'discord://api/operations/create_message')
        const operation = JSON.parse(text) as Record<string, unknown>

        expect(operation.operationId).toBe('create_message')
        expect(operation.method).toBe('POST')
        // The whole point: the schema is here rather than in every tool result.
        expect(operation).toHaveProperty('bodySchema')
      },
      Layer.merge(OperationCatalog.layer, Layer.empty),
    )
  })

  it('serves a family so an area can be surveyed before searching', async () => {
    await withClient(
      stubRest(() => Effect.succeed({})),
      [],
      async (client) => {
        const { text } = await read(client, 'discord://api/families/message')
        const family = JSON.parse(text) as { count: number; operations: ReadonlyArray<unknown> }

        expect(family.count).toBeGreaterThan(0)
        expect(family.operations).toHaveLength(family.count)
      },
      Layer.merge(OperationCatalog.layer, Layer.empty),
    )
  })

  it('explains an unknown operation rather than returning nothing', async () => {
    await withClient(
      stubRest(() => Effect.succeed({})),
      [],
      async (client) => {
        // This is often the first thing a model sees about a URI it constructed itself, so the
        // failure has to say what to do rather than just fail.
        await expect(read(client, 'discord://api/operations/not_an_operation')).rejects.toThrow()
      },
      Layer.merge(OperationCatalog.layer, Layer.empty),
    )
  })

  it('lists every operation, so a client need not guess identifiers', async () => {
    await withClient(
      stubRest(() => Effect.succeed({})),
      [],
      async (client) => {
        const { resources } = await client.listResources()
        expect(resources.length).toBeGreaterThan(200)
      },
      Layer.merge(OperationCatalog.layer, Layer.empty),
    )
  })

  it('advertises its templates', async () => {
    await withClient(
      stubRest(() => Effect.succeed({})),
      [],
      async (client) => {
        const { resourceTemplates } = await client.listResourceTemplates()
        const templates = resourceTemplates.map((t) => t.uriTemplate)

        expect(templates).toContain('discord://api/operations/{operationId}')
        expect(templates).toContain('discord://api/families/{family}')
      },
      Layer.merge(OperationCatalog.layer, Layer.empty),
    )
  })
})

describe('resource definitions', () => {
  it('gives every resource a unique URI', () => {
    const uris = allResources.map((resource) => resource.uri)
    expect(new Set(uris).size).toBe(uris.length)
  })

  it('uses the discord:// scheme throughout', () => {
    const wrong = allResources.filter((resource) => !resource.uri.startsWith('discord://'))
    expect(wrong.map((resource) => resource.name)).toEqual([])
  })

  it('declares the variables its template uses, and no others', () => {
    for (const resource of allResources) {
      const inUri = [...resource.uri.matchAll(/\{(\w+)\}/g)].map((m) => m[1])
      // A declared variable the URI does not use would never be bound; an undeclared one in the
      // URI would register as a literal path and never match.
      expect([...(resource.variables ?? [])].sort(), resource.name).toEqual(inUri.sort())
    }
  })

  it('makes catalog resources listable', () => {
    // A template with no `list` is reachable only by guessing an identifier.
    for (const resource of catalogResources) {
      expect(resource.list, `${resource.name} cannot be listed`).toBeDefined()
    }
  })
})
