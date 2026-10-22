import {
  OperationCatalog,
  type OperationPermissions,
  operationPermissions,
  permissionTableProblems,
  requiredPermissions,
} from '@mia-cx/discord-catalog'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { relayTools } from '../src/tools/relay-tools.ts'

const run = <A, E>(effect: Effect.Effect<A, E, OperationCatalog>) =>
  Effect.runPromise(Effect.provide(effect, OperationCatalog.layer))

/** Calls a relay tool's handler directly; search and describe need only the catalog. */
const call = (name: string, args: unknown) => {
  const found = relayTools.find((t) => t.name === name)
  if (found === undefined) throw new Error(`no ${name} tool`)
  const handler = found.handler as (a: unknown) => Effect.Effect<unknown, unknown, OperationCatalog>
  return run(handler(args))
}

const operations = await run(Effect.map(OperationCatalog, (catalog) => catalog.all))

describe('operation permission metadata', () => {
  it.each(['constructor', 'toString', '__proto__', 'missing_operation'])(
    'rejects %s as a missing permission entry',
    (operationId) => {
      expect(() => requiredPermissions(operationId)).toThrow(
        `${operationId} has no permission entry. Run pnpm spec:check.`,
      )
    },
  )

  it('returns the documented guild membership requirement for get_guild', () => {
    expect(requiredPermissions('get_guild')).toEqual({
      requires: 'any-of',
      anyOf: [{ permissions: [], scope: { level: 'guild', pathParam: 'guild_id' } }],
      sources: ['https://docs.discord.com/developers/resources/guild#get-guild'],
    })
  })

  it('describes the permission, scope, and hierarchy rule Discord applies to a kick', async () => {
    const described = await call('discord_api_describe', { operationId: 'delete_guild_member' })

    expect(described).toMatchObject({
      permissions: {
        requires: 'any-of',
        anyOf: [{ permissions: ['KickMembers'], scope: { level: 'guild', pathParam: 'guild_id' } }],
        hierarchy: [{ rule: 'member-below', target: 'user_id' }],
      },
    })
  })

  it('returns the requirements with every search result', async () => {
    const found = (await call('discord_api_search', { query: 'delete message', limit: 5 })) as {
      results: Array<{ operationId: string; permissions: OperationPermissions }>
    }

    expect(found.results.length).toBeGreaterThan(0)
    for (const result of found.results) {
      expect(result.permissions, result.operationId).toBe(requiredPermissions(result.operationId))
    }
    // Authorship is an alternative, so a caller without ManageMessages can still delete its own.
    expect(found.results.find((r) => r.operationId === 'delete_message')).toMatchObject({
      permissions: {
        anyOf: [
          { only: 'The caller authored the message.' },
          { permissions: ['ViewChannel', 'ManageMessages'] },
        ],
      },
    })
  })

  // Editing a message and opening a forum post both publish content, so a person who could not
  // upload or ping everyone in a new message cannot do it through these routes either.
  it.each([
    { operationId: 'update_message', needs: ['AttachFiles', 'MentionEveryone'] },
    { operationId: 'create_thread', needs: ['AttachFiles', 'MentionEveryone', 'SendPolls'] },
  ])('requires $needs when $operationId publishes them', ({ operationId, needs }) => {
    const entry = requiredPermissions(operationId)
    const conditional = entry.requires === 'any-of' ? (entry.conditional ?? []) : []
    const required = conditional.flatMap((c) => c.anyOf.flatMap((grant) => grant.permissions))

    expect(required).toEqual(expect.arrayContaining(needs))
  })

  it('covers every cataloged operation with a well-formed entry', () => {
    expect(permissionTableProblems(operations)).toEqual([])
  })

  const guild = requiredPermissions('get_guild')
  it.each([
    {
      reason: 'a catalog operation has no entry',
      table: Object.fromEntries(
        Object.entries(operationPermissions).filter(([id]) => id !== 'get_guild'),
      ),
      problem: 'get_guild has no permission entry',
    },
    {
      reason: 'an entry outlives its operation',
      table: { ...operationPermissions, retired_operation: guild },
      problem: 'retired_operation has a permission entry but is not in the catalog',
    },
    {
      reason: 'a scope names a path parameter the route lacks',
      table: { ...operationPermissions, get_user: guild },
      problem: 'get_user scope names path parameter guild_id, which /users/{user_id} lacks',
    },
    {
      reason: 'a grant would hold for free',
      table: {
        ...operationPermissions,
        get_user: { requires: 'any-of', anyOf: [{ permissions: [] }], sources: ['x'] },
      },
      problem: 'get_user has a grant that requires nothing',
    },
    {
      reason: 'a channel grant skips ViewChannel',
      table: {
        ...operationPermissions,
        get_channel: {
          requires: 'any-of',
          anyOf: [{ permissions: [], scope: { level: 'channel', pathParam: 'channel_id' } }],
          sources: ['x'],
        },
      },
      problem: 'get_channel has a channel grant without ViewChannel',
    },
  ] satisfies ReadonlyArray<{
    reason: string
    table: Record<string, OperationPermissions>
    problem: string
  }>)('fails the check when $reason', ({ table, problem }) => {
    expect(permissionTableProblems(operations, table)).toContain(problem)
  })
})
