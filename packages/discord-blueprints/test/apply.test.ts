import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { McpRequestContext, type Principal, type Scope } from '@discord-mcp/core'
import { DiscordRest, PreviewTokens } from '@discord-mcp/discord-api'
import {
  AuditRepository,
  BlueprintRepository,
  PersistenceLayer,
  type RevisionRepository,
} from '@discord-mcp/persistence'
import { Effect, Layer, ManagedRuntime } from 'effect'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  blueprintApply,
  blueprintPlan,
  blueprintPublish,
  blueprintUpdateDraft,
} from '../src/tools.ts'

/**
 * The blueprint lifecycle end to end, against a real database and a scripted Discord.
 *
 * The properties that matter here are the ones that only show up when persistence, planning, and
 * apply are wired together: a stale preview must not apply, a partial failure must be resumable,
 * and a reapply must do nothing.
 */

const GUILD = '123456789012345678'
const BOT_ROLE = '900000000000000001'

interface Guild {
  roles: Array<Record<string, unknown>>
  channels: Array<Record<string, unknown>>
}

/** A Discord that records what it was asked to do and mutates an in-memory guild. */
const scriptedDiscord = (
  guild: Guild,
  failOn?: (route: string, method: string) => string | undefined,
) => {
  const calls: Array<{ method: string; route: string }> = []
  let nextId = 1

  const layer = Layer.succeed(DiscordRest)({
    request: (req) => {
      const route = String(req.route)
      calls.push({ method: req.method, route })

      const failure = failOn?.(route, req.method)
      if (failure !== undefined) return Effect.fail(new Error(failure) as never)

      if (route === `/guilds/${GUILD}`) {
        return Effect.succeed({ id: GUILD, owner_id: '111111111111111111', name: 'Test Guild' })
      }
      if (route === `/guilds/${GUILD}/members/@me`) return Effect.succeed({ roles: [BOT_ROLE] })
      if (route === `/guilds/${GUILD}/roles` && req.method === 'GET')
        return Effect.succeed(guild.roles)
      if (route === `/guilds/${GUILD}/channels` && req.method === 'GET')
        return Effect.succeed(guild.channels)

      if (route === `/guilds/${GUILD}/roles` && req.method === 'POST') {
        const id = `70000000000000000${nextId++}`
        const body = req.body as Record<string, unknown>
        guild.roles.push({ id, name: body.name, permissions: '0', position: 1 })
        return Effect.succeed({ id })
      }
      if (route === `/guilds/${GUILD}/channels` && req.method === 'POST') {
        const id = `80000000000000000${nextId++}`
        const body = req.body as Record<string, unknown>
        guild.channels.push({
          id,
          name: body.name,
          type: body.type,
          position: 0,
          parent_id: body.parent_id ?? null,
        })
        return Effect.succeed({ id })
      }
      return Effect.succeed({})
    },
    raw: undefined as never,
  })

  return { layer, calls }
}

const ALL_SCOPES = new Set<Scope>([
  'mcp:read',
  'mcp:write',
  'mcp:destructive',
  'server:plan',
  'server:apply',
])
const principal: Principal = { id: 'test-principal', kind: 'stdio-local', scopes: ALL_SCOPES }

let dir: string

const makeRuntime = (discord: Layer.Layer<DiscordRest>) =>
  ManagedRuntime.make(
    Layer.mergeAll(discord, PreviewTokens.layer, PersistenceLayer(join(dir, 'bp.sqlite'))),
  )

// biome-ignore lint/suspicious/noExplicitAny: the tool handlers are heterogeneous by construction.
const call = (runtime: any, tool: any, args: unknown) =>
  runtime.runPromiseExit(
    Effect.provideService(tool.handler(args), McpRequestContext, {
      requestId: 'r1',
      signal: undefined,
      progressToken: undefined,
      notify: undefined,
      principal,
    }),
  )

const baseGuild = (): Guild => ({
  roles: [
    { id: GUILD, name: '@everyone', permissions: '0', position: 0 },
    // The bot's own role, high enough to manage everything the blueprint asks for.
    { id: BOT_ROLE, name: 'discord-mcp', permissions: '8', position: 50 },
  ],
  channels: [],
})

const blueprint = {
  roles: [{ key: 'mods', name: 'Moderators' }],
  channels: [
    { kind: 'category', key: 'staff', name: 'Staff' },
    { kind: 'text', key: 'general', name: 'general', parent: 'staff' },
  ],
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'discord-mcp-bp-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const seed = async (runtime: ReturnType<typeof makeRuntime>) => {
  await call(runtime, blueprintUpdateDraft, { blueprintId: 'bp1', name: 'Test', blueprint })
  const published = await call(runtime, blueprintPublish, { blueprintId: 'bp1' })
  expect(published._tag).toBe('Success')
}

describe('plan and apply', () => {
  it('creates roles before channels, binds each object, and converges on reapply', async () => {
    const guild = baseGuild()
    const discord = scriptedDiscord(guild)
    const runtime = makeRuntime(discord.layer)

    await seed(runtime)

    const planned = await call(runtime, blueprintPlan, { blueprintId: 'bp1', guildId: GUILD })
    expect(planned._tag).toBe('Success')
    if (planned._tag !== 'Success') return
    const { previewToken, actions } = planned.value as {
      previewToken: string
      actions: Array<{ kind: string }>
    }
    expect(actions.map((a) => a.kind)).toEqual(['createRole', 'createChannel', 'createChannel'])

    const applied = await call(runtime, blueprintApply, {
      blueprintId: 'bp1',
      guildId: GUILD,
      previewToken,
    })
    expect(applied._tag).toBe('Success')
    if (applied._tag !== 'Success') return
    expect((applied.value as { status: string }).status).toBe('completed')

    // Roles are created before the channels whose overwrites would reference them.
    const writes = discord.calls.filter((c) => c.method === 'POST')
    expect(writes[0]?.route).toBe(`/guilds/${GUILD}/roles`)

    // Bindings persisted, so the second plan sees everything as already existing.
    const bindings = await runtime.runPromise(
      Effect.flatMap(BlueprintRepository, (r) => r.bindings('bp1', GUILD)),
    )
    expect([...bindings.keys()].sort()).toEqual(['general', 'mods', 'staff'])

    const replanned = await call(runtime, blueprintPlan, { blueprintId: 'bp1', guildId: GUILD })
    expect(replanned._tag).toBe('Success')
    if (replanned._tag !== 'Success') return
    // The property that makes reapplying safe: a converged guild yields zero actions.
    expect((replanned.value as { converged: boolean; actions: unknown[] }).converged).toBe(true)
    expect((replanned.value as { actions: unknown[] }).actions).toEqual([])

    await runtime.dispose()
  })

  it('refuses an apply whose preview predates a change to the guild', async () => {
    const guild = baseGuild()
    const discord = scriptedDiscord(guild)
    const runtime = makeRuntime(discord.layer)

    await seed(runtime)
    const planned = await call(runtime, blueprintPlan, { blueprintId: 'bp1', guildId: GUILD })
    if (planned._tag !== 'Success') throw new Error('plan failed')
    const { previewToken } = planned.value as { previewToken: string }

    // Someone reorganises the guild between plan and apply. The snapshot digest changes, so the
    // token no longer matches and the apply is refused rather than executing a stale plan.
    guild.channels.push({ id: '999999999999999999', name: 'surprise', type: 0, position: 0 })

    const applied = await call(runtime, blueprintApply, {
      blueprintId: 'bp1',
      guildId: GUILD,
      previewToken,
    })
    expect(applied._tag).toBe('Failure')
    expect(JSON.stringify(applied)).toContain('different')

    await runtime.dispose()
  })

  it('leaves a resumable journal when an action fails part way through', async () => {
    const guild = baseGuild()
    // The role creates fine; the first channel create fails.
    const discord = scriptedDiscord(guild, (route, method) =>
      route === `/guilds/${GUILD}/channels` && method === 'POST'
        ? 'Missing Permissions'
        : undefined,
    )
    const runtime = makeRuntime(discord.layer)

    await seed(runtime)
    const planned = await call(runtime, blueprintPlan, { blueprintId: 'bp1', guildId: GUILD })
    if (planned._tag !== 'Success') throw new Error('plan failed')
    const { previewToken } = planned.value as { previewToken: string }

    const applied = await call(runtime, blueprintApply, {
      blueprintId: 'bp1',
      guildId: GUILD,
      previewToken,
    })
    expect(applied._tag).toBe('Success')
    if (applied._tag !== 'Success') return

    const outcome = applied.value as {
      status: string
      completed: unknown[]
      failed?: { summary: string; error: string }
      pending: unknown[]
      resumeHint?: string
    }

    // Discord has no transactions, so this is the honest answer: some work landed, some did not.
    expect(outcome.status).toBe('partial')
    expect(outcome.completed).toHaveLength(1)
    expect(outcome.failed?.error).toContain('Missing Permissions')
    expect(outcome.pending.length).toBeGreaterThan(0)
    expect(outcome.resumeHint).toContain('will not repeat it')

    // The role that was created is bound, so re-planning after a fix will not duplicate it.
    const bindings = await runtime.runPromise(
      Effect.flatMap(BlueprintRepository, (r) => r.bindings('bp1', GUILD)),
    )
    expect([...bindings.keys()]).toEqual(['mods'])

    await runtime.dispose()
  })

  it('records the apply in the audit log', async () => {
    const guild = baseGuild()
    const runtime = makeRuntime(scriptedDiscord(guild).layer)

    await seed(runtime)
    const planned = await call(runtime, blueprintPlan, { blueprintId: 'bp1', guildId: GUILD })
    if (planned._tag !== 'Success') throw new Error('plan failed')
    await call(runtime, blueprintApply, {
      blueprintId: 'bp1',
      guildId: GUILD,
      previewToken: (planned.value as { previewToken: string }).previewToken,
    })

    const entries = await runtime.runPromise(
      Effect.flatMap(AuditRepository, (r) => r.list({ limit: 10 })),
    )
    expect(entries.map((e) => e.action)).toContain('blueprint.apply')

    await runtime.dispose()
  })
})

describe('lifecycle guards', () => {
  it('refuses to plan a blueprint with no published revision', async () => {
    const runtime = makeRuntime(scriptedDiscord(baseGuild()).layer)
    await call(runtime, blueprintUpdateDraft, { blueprintId: 'bp2', name: 'Draft only', blueprint })

    const planned = await call(runtime, blueprintPlan, { blueprintId: 'bp2', guildId: GUILD })
    expect(planned._tag).toBe('Failure')
    expect(JSON.stringify(planned)).toContain('publish a draft')

    await runtime.dispose()
  })

  it('refuses deleteManaged without the destructive scope', async () => {
    const runtime = makeRuntime(scriptedDiscord(baseGuild()).layer)
    await seed(runtime)

    const limited: Principal = {
      id: 'limited',
      kind: 'pat',
      scopes: new Set<Scope>(['server:plan', 'server:apply']),
    }
    const exit = await runtime.runPromiseExit(
      Effect.provideService(
        blueprintApply.handler({
          blueprintId: 'bp1',
          guildId: GUILD,
          previewToken: 'irrelevant',
          deleteManaged: true,
        }),
        McpRequestContext,
        {
          requestId: 'r',
          signal: undefined,
          progressToken: undefined,
          notify: undefined,
          principal: limited,
        },
      ),
    )

    expect(exit._tag).toBe('Failure')
    // Checked before the token, so a missing scope is reported as such rather than as a bad token.
    expect(JSON.stringify(exit)).toContain('mcp:destructive')

    await runtime.dispose()
  })

  it('does not issue a preview token for a plan that cannot succeed', async () => {
    const guild = baseGuild()
    // Bot role demoted below the role the blueprint wants to manage.
    guild.roles = [
      { id: GUILD, name: '@everyone', permissions: '0', position: 0 },
      { id: BOT_ROLE, name: 'discord-mcp', permissions: '8', position: 1 },
      { id: '900000000000000009', name: 'Moderators', permissions: '0', position: 40 },
    ]
    const runtime = makeRuntime(scriptedDiscord(guild).layer)
    await seed(runtime)

    await runtime.runPromise(
      Effect.flatMap(BlueprintRepository, (r) =>
        r.bind('bp1', GUILD, {
          logicalKey: 'mods',
          discordId: '900000000000000009',
          objectKind: 'role',
        }),
      ),
    )

    const planned = await call(runtime, blueprintPlan, { blueprintId: 'bp1', guildId: GUILD })
    expect(planned._tag).toBe('Success')
    if (planned._tag !== 'Success') return

    const result = planned.value as { blockers: unknown[]; previewToken?: string }
    expect(result.blockers.length).toBeGreaterThan(0)
    // Issuing a token here would invite an apply that fails partway through for a known reason.
    expect(result.previewToken).toBeUndefined()

    await runtime.dispose()
  })
})

/** Re-exported for type-checking the seed helper. */
export type { RevisionRepository }
