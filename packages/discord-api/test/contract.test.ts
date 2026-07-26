import { type McpSchema, toMcpInputJsonSchema } from '@discord-mcp/core'
import { Effect, ManagedRuntime } from 'effect'
import { describe, expect, it } from 'vitest'
import { OperationCatalog } from '../src/catalog/service.ts'
import { apiTools } from '../src/tools/api-tools.ts'
import { messageTools } from '../src/tools/message-tools.ts'
import { operatorTools } from '../src/tools/operator-tools.ts'
import { templateTools } from '../src/tools/template-tools.ts'

/**
 * Contract checks between the catalog, the dispatchers, and the advertised tool schemas.
 *
 * These are the claims the rest of the system relies on without re-checking: that every cataloged
 * operation has exactly one classification, that a dispatcher cannot reach outside its risk class,
 * and that every schema a tool advertises is one the MCP layer can actually publish.
 */

const runtime = ManagedRuntime.make(OperationCatalog.layer)

const curatedTools = [...operatorTools, ...messageTools, ...templateTools]

describe('the operation catalog', () => {
  it('classifies every operation exactly once', async () => {
    const operations = await runtime.runPromise(
      Effect.map(OperationCatalog, (catalog) => catalog.all),
    )

    const byId = new Map<string, number>()
    for (const operation of operations) {
      byId.set(operation.operationId, (byId.get(operation.operationId) ?? 0) + 1)
    }

    const duplicated = [...byId.entries()].filter(([, count]) => count > 1)
    expect(duplicated).toEqual([])
  })

  it('gives every operation a risk class and an auth mode', async () => {
    const operations = await runtime.runPromise(
      Effect.map(OperationCatalog, (catalog) => catalog.all),
    )

    const unclassified = operations.filter(
      (operation) => operation.risk === undefined || operation.auth.length === 0,
    )
    expect(unclassified.map((operation) => operation.operationId)).toEqual([])
  })

  it('never claims coverage for an operation no configured profile can run', async () => {
    const operations = await runtime.runPromise(
      Effect.map(OperationCatalog, (catalog) => catalog.all),
    )

    // An operation reachable only by a user token is one this server can never execute, because it
    // never holds one. Advertising it would be a promise the system cannot keep.
    const unreachable = operations.filter(
      (operation) =>
        !operation.auth.includes('bot') &&
        !operation.auth.includes('oauth2') &&
        !operation.auth.includes('webhook') &&
        !operation.auth.includes('interaction'),
    )
    expect(unreachable.map((operation) => operation.operationId)).toEqual([])
  })
})

describe('generic dispatchers', () => {
  const dispatchers = apiTools.filter((tool) => tool.name.startsWith('discord_api_'))

  it('separates risk classes structurally, not by argument', () => {
    // Each dispatcher declares the classes it accepts; an operation outside them is unreachable
    // through that tool regardless of what a caller passes.
    const byName = new Map(dispatchers.map((tool) => [tool.name, tool] as const))

    expect(byName.get('discord_api_read')?.risk).toBe('read')
    expect(byName.get('discord_api_write')?.risk).toBe('write')
    expect(byName.get('discord_api_destructive')?.risk).toBe('destructive')
    expect(byName.get('discord_api_admin')?.risk).toBe('bot_admin')
  })

  it('requires a distinct scope for each escalation', () => {
    const scopesOf = (name: string) => dispatchers.find((tool) => tool.name === name)?.scopes ?? []

    expect(scopesOf('discord_api_read')).toContain('mcp:read')
    expect(scopesOf('discord_api_write')).toContain('mcp:write')
    expect(scopesOf('discord_api_destructive')).toContain('mcp:destructive')
    expect(scopesOf('discord_api_admin')).toContain('bot:admin')
  })
})

describe('curated tools', () => {
  it('names a Discord permission or a diagnostic wherever one applies', () => {
    // Scoped to tools that actually reach Discord — `openWorldHint` is exactly that claim. A local
    // tool like template editing has no permission to name, and demanding one would be noise.
    //
    // A tool that fails on a missing permission and does not say which one produces a retry loop.
    const silent = curatedTools.filter(
      (tool) =>
        tool.risk !== 'read' &&
        tool.annotations.openWorldHint === true &&
        !/permission|requires|discord_permissions_explain|scope/i.test(tool.description),
    )
    expect(silent.map((tool) => tool.name)).toEqual([])
  })

  it('tells a destructive tool’s caller to preview first', () => {
    const destructive = curatedTools.filter((tool) => tool.risk === 'destructive')
    expect(destructive.length).toBeGreaterThan(0)

    const unpreviewed = destructive.filter((tool) => !/preview/i.test(tool.description))
    expect(unpreviewed.map((tool) => tool.name)).toEqual([])
  })
})

/** The registry's own builder, so this checks the shipped schema rather than a rehearsal of it. */
const advertised = toMcpInputJsonSchema

const properties = (schema: Record<string, unknown>): Record<string, unknown> =>
  (schema.properties as Record<string, unknown> | undefined) ?? {}

describe('schema advertisement', () => {
  const allTools = [...curatedTools, ...apiTools]

  it('compiles every tool’s input through McpInput', () => {
    // MCP rejects a non-object root at `tools/list`, which would break discovery for every tool on
    // the server rather than just the offending one — so this is checked eagerly, here and at
    // registry construction.
    for (const tool of allTools) {
      const schema = advertised(tool.input as McpSchema)
      expect(schema.type, `${tool.name} must advertise an object schema`).toBe('object')
    }
  })

  it('preserves descriptions on constrained properties', () => {
    // Effect emits `Schema.check` as `allOf`, and a trailing `.annotate()` lands inside it — so a
    // constrained field advertises no property-level description unless the bridge hoists it.
    const withProperties = allTools
      .map((tool) => ({ tool, schema: advertised(tool.input as McpSchema) }))
      .filter(({ schema }) => Object.keys(properties(schema)).length > 0)

    expect(withProperties.length).toBeGreaterThan(0)

    for (const { tool, schema } of withProperties) {
      for (const [name, property] of Object.entries(properties(schema))) {
        expect(
          Object.hasOwn(property as object, 'allOf'),
          `${tool.name}.${name} still advertises an allOf wrapper`,
        ).toBe(false)
      }
    }
  })
})
