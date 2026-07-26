import { selectTools } from '@discord-mcp/core'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { allTools, selectionFor } from '../src/app.ts'
import { stubRest, testConfig, withClient } from './support/harness.ts'

/**
 * The advertised tool surface, as a snapshot.
 *
 * A model's behaviour is downstream of these names, descriptions, and schemas, so a change to any
 * of them is a change to the product. The snapshot makes that a reviewable diff rather than
 * something noticed after a release.
 */

describe('the tool surface', () => {
  it('advertises a stable set of tools', async () => {
    const names = allTools.map((tool) => tool.name).sort()
    expect(names).toMatchSnapshot()
  })

  it('advertises stable input schemas', async () => {
    await withClient(
      stubRest(() => Effect.succeed({})),
      // Only the ungated tools: the gated ones need subsystems this harness does not build, and a
      // snapshot that changed with the environment would be worthless.
      allTools.filter((tool) => tool.gate === undefined || tool.gate === 'always'),
      async (client) => {
        const { tools } = await client.listTools()

        const surface = [...tools]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((tool) => ({
            name: tool.name,
            title: tool.title,
            description: tool.description,
            annotations: tool.annotations,
            inputSchema: tool.inputSchema,
          }))

        expect(surface).toMatchSnapshot()
      },
    )
  })
})

describe('tool registration invariants', () => {
  it('gives every tool a unique name', () => {
    const names = allTools.map((tool) => tool.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('declares scopes on every tool', () => {
    // A tool with no scopes would be reachable by any authenticated principal regardless of what
    // they were granted.
    const unscoped = allTools.filter((tool) => tool.scopes.length === 0)
    expect(unscoped.map((tool) => tool.name)).toEqual([])
  })

  it('marks every destructive tool as destructive', () => {
    // The annotation is what a client shows a user before confirming, so a destructive tool that
    // claims otherwise is a tool that gets run without anyone looking.
    const mismarked = allTools.filter(
      (tool) => tool.risk === 'destructive' && tool.annotations.destructiveHint !== true,
    )
    expect(mismarked.map((tool) => tool.name)).toEqual([])
  })

  it('marks every read-only tool as read-only', () => {
    const mismarked = allTools.filter(
      (tool) => tool.risk === 'read' && tool.annotations.readOnlyHint !== true,
    )
    expect(mismarked.map((tool) => tool.name)).toEqual([])
  })

  it('never exposes a credential-class tool', () => {
    // Credential operations are reachable only through the dedicated OAuth and secret flows, never
    // as a general tool.
    expect(allTools.filter((tool) => tool.risk === 'credential')).toEqual([])
  })

  it('writes a description long enough to act on', () => {
    // The description is the entire interface a model has to this tool. A one-liner that omits the
    // required permission or the next diagnostic step produces confident wrong calls.
    const thin = allTools.filter((tool) => tool.description.length < 40)
    expect(thin.map((tool) => tool.name)).toEqual([])
  })
})

describe('toolset and gate selection', () => {
  it('registers nothing gated on a subsystem that is off', () => {
    const selected = selectTools(allTools, {
      toolsets: new Set(['operator', 'automation', 'admin', 'api'] as const),
      enabledGates: new Set(['always'] as const),
    })

    expect(selected.some((tool) => tool.gate === 'gateway')).toBe(false)
    expect(selected.some((tool) => tool.gate === 'workflows')).toBe(false)
  })

  it('registers workflow tools only when workflows are enabled', () => {
    const off = selectTools(
      allTools,
      selectionFor({ ...testConfig, workflows: { ...testConfig.workflows, enabled: false } }),
    )
    expect(off.some((tool) => tool.name.startsWith('workflow_'))).toBe(false)

    const on = selectTools(allTools, selectionFor(testConfig))
    expect(on.some((tool) => tool.name.startsWith('workflow_'))).toBe(true)
  })

  it('keeps the admin toolset out of the shipped default', () => {
    // `admin` grants blueprint apply, workflow granting, and OAuth profile management. An operator
    // opts into it; it is not something they discover after the fact.
    const shipped = selectTools(allTools, {
      toolsets: new Set(['operator', 'automation', 'api'] as const),
      enabledGates: new Set(['always', 'gateway', 'workflows'] as const),
    })

    expect(shipped.some((tool) => tool.toolset === 'admin')).toBe(false)
  })
})
