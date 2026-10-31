import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { packedOperations, tokenTable } from '../src/generated/index.ts'
import { OperationCatalog } from '../src/service.ts'
import { unpackOperation } from '../src/types.ts'

const run = <A, E>(effect: Effect.Effect<A, E, OperationCatalog>) =>
  Effect.runPromise(Effect.provide(effect, OperationCatalog.layer) as Effect.Effect<A, E>)

const operations = packedOperations.map(unpackOperation)

describe('generated catalog', () => {
  it('matches the counts recorded for the pin', () => {
    // Facts about this pin, not constants. If Discord's spec changes these must change with it,
    // deliberately, through spec:drift and a re-pin.
    expect(operations).toHaveLength(242)
    expect(new Set(operations.map((o) => o.path)).size).toBe(150)
  })

  it('classifies every operation with a risk and at least one auth mode', () => {
    for (const op of operations) {
      expect(op.risk, op.operationId).toBeDefined()
      expect(op.auth.length, `${op.operationId} has no executable auth mode`).toBeGreaterThan(0)
    }
  })

  it('merges path-item parameters, which operation-level parameters never carry', () => {
    // The single easiest thing in this project to get wrong. 130 of 150 paths declare their path
    // parameters on the path item; reading op.parameters alone yields zero of them.
    for (const op of operations) {
      for (const match of op.path.matchAll(/\{([^}]+)\}/g)) {
        expect(op.pathParams, `${op.operationId} ${op.path}`).toContain(match[1])
      }
    }

    // A concrete case: this path carries both of its parameters on the path item.
    const addRole = operations.find((o) => o.operationId === 'add_guild_member_role')
    expect(addRole?.pathParams).toEqual(['guild_id', 'role_id', 'user_id'])
  })

  it('records exactly the six operations that reject a bot token', () => {
    const oauthOnly = operations.filter((o) => !o.auth.includes('bot')).map((o) => o.operationId)
    expect(oauthOnly.sort()).toEqual([
      'delete_application_user_role_connection',
      'get_application_user_role_connection',
      'get_current_user_application_entitlements',
      'get_my_guild_member',
      'set_guild_application_command_permissions',
      'update_application_user_role_connection',
    ])
    for (const id of oauthOnly) {
      expect(operations.find((o) => o.operationId === id)?.auth).toContain('oauth2')
    }
  })

  it('classifies operations whose HTTP method understates them', () => {
    const risk = (id: string) => operations.find((o) => o.operationId === id)?.risk
    // POST, but it removes members in bulk and cannot be undone.
    expect(risk('prune_guild')).toBe('destructive')
    expect(risk('bulk_delete_messages')).toBe('destructive')
    expect(risk('ban_user_from_guild')).toBe('destructive')
    // Bot identity and command registration are administrative, not ordinary writes.
    expect(risk('create_application_command')).toBe('bot_admin')
    expect(risk('get_guild')).toBe('read')
  })

  it('resolves every interned search token', () => {
    for (const op of operations) {
      for (const index of op.tokens)
        expect(tokenTable[index], `${op.operationId}`).toBeTypeOf('string')
    }
  })
})

describe('catalog search', () => {
  it('finds an operation from plain language via the gloss', async () => {
    // "kick" appears nowhere in delete_guild_member's ID or path; the gloss is what bridges it.
    const hits = await run(
      Effect.map(OperationCatalog, (c) =>
        c.search({ query: 'kick a member from the server', limit: 5 }),
      ),
    )
    expect(hits.hits.map((h) => h.operation.operationId)).toContain('delete_guild_member')
  })

  it('ranks an exact operation ID first', async () => {
    const hits = await run(
      Effect.map(OperationCatalog, (c) => c.search({ query: 'get_guild', limit: 5 })),
    )
    expect(hits.hits[0]?.operation.operationId).toBe('get_guild')
  })

  it('names the curated tool when one covers the operation', async () => {
    const hits = await run(
      Effect.map(OperationCatalog, (c) => c.search({ query: 'get_guild', limit: 1 })),
    )
    expect(hits.hits[0]?.operation.curatedTool).toBe('discord_guild_get')
  })

  it('filters by risk so a destructive search never returns reads', async () => {
    const hits = await run(
      Effect.map(OperationCatalog, (c) =>
        c.search({ query: 'message', risk: 'destructive', limit: 50 }),
      ),
    )
    expect(hits.hits.length).toBeGreaterThan(0)
    for (const h of hits.hits) expect(h.operation.risk).toBe('destructive')
  })

  it('pages stably', async () => {
    const first = await run(
      Effect.map(OperationCatalog, (c) => c.search({ query: 'guild', limit: 5 })),
    )
    const second = await run(
      Effect.map(OperationCatalog, (c) =>
        c.search({
          query: 'guild',
          limit: 5,
          ...(first.nextCursor === undefined ? {} : { cursor: first.nextCursor }),
        }),
      ),
    )
    const firstIds = first.hits.map((h) => h.operation.operationId)
    const secondIds = second.hits.map((h) => h.operation.operationId)
    expect(firstIds.some((id) => secondIds.includes(id))).toBe(false)
  })

  it('reports an unknown operation without inviting a guess', async () => {
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        Effect.flatMap(OperationCatalog, (c) => c.get('get_the_thing')),
        OperationCatalog.layer,
      ) as Effect.Effect<unknown, unknown>,
    )
    expect(exit._tag).toBe('Failure')
  })
})

describe('lazy schema tier', () => {
  it('returns a self-contained body schema with a scoped $defs closure', async () => {
    const schema = await run(
      Effect.flatMap(OperationCatalog, (c) => c.bodySchema('create_message')),
    )
    expect(schema).toBeDefined()
    expect(schema?.$ref).toMatch(/^#\/\$defs\//)

    const defs = schema?.$defs as Record<string, unknown>
    expect(Object.keys(defs).length).toBeGreaterThan(0)

    // Every internal reference must resolve inside the closure, or a validator would fail on a
    // dangling $ref rather than on the caller's actual mistake.
    const refs = [...JSON.stringify(defs).matchAll(/"#\/\$defs\/([^"]+)"/g)].map(
      (m) => m[1] as string,
    )
    for (const ref of new Set(refs)) expect(Object.keys(defs)).toContain(ref)
  })

  it('terminates on Discord’s recursive schemas', async () => {
    // Channel.parent and Message.referenced_message are self-referential; a dereferencing catalog
    // would never finish building this.
    const schema = await run(
      Effect.flatMap(OperationCatalog, (c) => c.bodySchema('create_guild_channel')),
    )
    expect(schema).toBeDefined()
  })

  it('returns undefined for an operation with no body', async () => {
    const schema = await run(Effect.flatMap(OperationCatalog, (c) => c.bodySchema('get_guild')))
    expect(schema).toBeUndefined()
  })
})
