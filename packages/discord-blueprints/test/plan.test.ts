import { namesToBits } from '@discord-mcp/discord-api'
import { describe, expect, it } from 'vitest'
import { type GuildSnapshot, planBlueprint } from '../src/plan.ts'
import type { Blueprint } from '../src/schema.ts'

const GUILD = '123456789012345678'
const OWNER = '111111111111111111'

const ALL = namesToBits(['Administrator'])

const snapshot = (over: Partial<GuildSnapshot> = {}): GuildSnapshot => ({
  guildId: GUILD,
  ownerId: OWNER,
  roles: [{ id: GUILD, name: '@everyone', permissions: '0', position: 0 }],
  channels: [],
  ...over,
})

const plan = (
  blueprint: Blueprint,
  snap: GuildSnapshot,
  bindings: ReadonlyMap<string, string> = new Map(),
  over: { deleteManaged?: boolean; botHighestRolePosition?: number; botPermissions?: bigint } = {},
) =>
  planBlueprint({
    blueprint,
    snapshot: snap,
    bindings,
    botPermissions: over.botPermissions ?? ALL,
    botHighestRolePosition: over.botHighestRolePosition ?? 100,
    ...(over.deleteManaged === undefined ? {} : { deleteManaged: over.deleteManaged }),
  })

describe('planning never mutates and is idempotent', () => {
  it('plans creates for an empty guild', () => {
    const result = plan(
      {
        roles: [{ key: 'mods', name: 'Moderators' }],
        channels: [
          { kind: 'category', key: 'staff', name: 'Staff' },
          { kind: 'text', key: 'general', name: 'general', parent: 'staff' },
        ],
      },
      snapshot(),
    )

    expect(result.blockers).toEqual([])
    expect(result.actions.map((a) => a.kind)).toEqual([
      'createRole',
      'createChannel',
      'createChannel',
    ])
    expect(result.converged).toBe(false)
  })

  it('produces a zero-action diff for a converged guild', () => {
    // The property that makes reapplying safe. Everything already matches, so nothing is planned.
    const bindings = new Map([
      ['mods', '900000000000000001'],
      ['general', '900000000000000002'],
    ])
    const result = plan(
      {
        roles: [{ key: 'mods', name: 'Moderators' }],
        channels: [{ kind: 'text', key: 'general', name: 'general' }],
      },
      snapshot({
        roles: [
          { id: GUILD, name: '@everyone', permissions: '0', position: 0 },
          { id: '900000000000000001', name: 'Moderators', permissions: '0', position: 5 },
        ],
        channels: [{ id: '900000000000000002', name: 'general', type: 0, position: 0 }],
      }),
      bindings,
    )

    expect(result.actions).toEqual([])
    expect(result.converged).toBe(true)
  })
})

describe('logical keys, not names', () => {
  it('treats a rename as an update rather than a create, because the binding survives', () => {
    const bindings = new Map([['general', '900000000000000002']])
    const result = plan(
      { channels: [{ kind: 'text', key: 'general', name: 'general-chat' }] },
      snapshot({ channels: [{ id: '900000000000000002', name: 'general', type: 0, position: 0 }] }),
      bindings,
    )

    // Name matching would have planned a create here and left a duplicate behind.
    expect(result.actions).toHaveLength(1)
    expect(result.actions[0]?.kind).toBe('updateChannel')
    expect(result.actions[0]?.changes).toContainEqual({
      field: 'name',
      from: 'general',
      to: 'general-chat',
    })
  })

  it('re-creates a bound object the guild no longer has', () => {
    const bindings = new Map([['general', '900000000000000002']])
    const result = plan(
      { channels: [{ kind: 'text', key: 'general', name: 'general' }] },
      snapshot({ channels: [] }),
      bindings,
    )
    expect(result.actions[0]?.kind).toBe('createChannel')
  })
})

describe('unmanaged resources survive', () => {
  it('never plans an action against a resource with no binding', () => {
    const result = plan(
      { channels: [{ kind: 'text', key: 'general', name: 'general' }] },
      snapshot({
        channels: [
          { id: '999999999999999999', name: 'someone-elses-channel', type: 0, position: 0 },
        ],
      }),
      new Map(),
    )

    expect(result.actions.every((a) => a.targetId !== '999999999999999999')).toBe(true)
    expect(result.warnings.join()).toContain('not managed by this blueprint')
  })

  it('leaves an absent key alone unless deleteManaged is enabled', () => {
    const bindings = new Map([['old', '900000000000000009']])
    const snap = snapshot({
      channels: [{ id: '900000000000000009', name: 'old', type: 0, position: 0 }],
    })

    const withoutFlag = plan({ absent: ['old'] }, snap, bindings)
    expect(withoutFlag.actions).toEqual([])
    expect(withoutFlag.warnings.join()).toContain('Deletion is opt-in')

    const withFlag = plan({ absent: ['old'] }, snap, bindings, { deleteManaged: true })
    expect(withFlag.actions.map((a) => a.kind)).toEqual(['deleteChannel'])
    expect(withFlag.actions[0]?.destructive).toBe(true)
  })
})

describe('failures are reported at plan time, not discovered mid-apply', () => {
  it('reports a role above the bot’s highest', () => {
    const bindings = new Map([['admins', '900000000000000001']])
    const result = plan(
      { roles: [{ key: 'admins', name: 'Admins renamed' }] },
      snapshot({
        roles: [
          { id: GUILD, name: '@everyone', permissions: '0', position: 0 },
          { id: '900000000000000001', name: 'Admins', permissions: '0', position: 50 },
        ],
      }),
      bindings,
      { botHighestRolePosition: 10 },
    )

    expect(result.actions).toEqual([])
    expect(result.blockers[0]?.reason).toContain('strictly below')
  })

  it('reports permissions the bot cannot grant, because Discord forbids escalation', () => {
    const result = plan(
      { roles: [{ key: 'mods', name: 'Mods', permissions: ['ManageGuild', 'BanMembers'] }] },
      snapshot(),
      new Map(),
      { botPermissions: namesToBits(['BanMembers']) },
    )

    expect(result.actions).toEqual([])
    expect(result.blockers[0]?.reason).toContain('ManageGuild')
  })

  it('reports a channel whose Discord type cannot be converted', () => {
    const bindings = new Map([['general', '900000000000000002']])
    const result = plan(
      { channels: [{ kind: 'voice', key: 'general', name: 'general' }] },
      snapshot({ channels: [{ id: '900000000000000002', name: 'general', type: 0, position: 0 }] }),
      bindings,
    )
    expect(result.blockers[0]?.reason).toContain('cannot convert')
  })

  it('reports a parent that is not a category in the blueprint', () => {
    const result = plan(
      {
        channels: [
          { kind: 'text', key: 'notacategory', name: 'nope' },
          { kind: 'text', key: 'child', name: 'child', parent: 'notacategory' },
        ],
      },
      snapshot(),
    )
    expect(result.blockers.some((b) => b.key === 'child')).toBe(true)
  })
})

describe('ordering is derived, not requested', () => {
  it('sequences roles before channels, and positions last', () => {
    const result = plan(
      {
        roles: [{ key: 'mods', name: 'Mods', order: 1 }],
        channels: [
          { kind: 'category', key: 'staff', name: 'Staff', order: 1 },
          {
            kind: 'text',
            key: 'general',
            name: 'general',
            parent: 'staff',
            order: 2,
            overwrites: [{ target: { type: 'roleKey', key: 'mods' }, allow: ['ViewChannel'] }],
          },
        ],
      },
      snapshot(),
    )

    const kinds = result.actions.map((a) => a.kind)
    // Roles exist before channels reference them; overwrites only once IDs resolve.
    expect(kinds.indexOf('createRole')).toBeLessThan(kinds.indexOf('createChannel'))
    expect(kinds.indexOf('createChannel')).toBeLessThan(kinds.indexOf('setOverwrites'))
  })

  it('plans a reorder only when the relative sequence actually differs', () => {
    const bindings = new Map([
      ['a', '900000000000000001'],
      ['b', '900000000000000002'],
    ])
    const channels = (aPos: number, bPos: number) => [
      { id: '900000000000000001', name: 'a', type: 0, position: aPos },
      { id: '900000000000000002', name: 'b', type: 0, position: bPos },
    ]
    const blueprint: Blueprint = {
      channels: [
        { kind: 'text', key: 'a', name: 'a', order: 1 },
        { kind: 'text', key: 'b', name: 'b', order: 2 },
      ],
    }

    // Already in order — absolute positions differ from the order numbers, which must not matter.
    expect(plan(blueprint, snapshot({ channels: channels(7, 9) }), bindings).actions).toEqual([])
    // Out of order.
    expect(
      plan(blueprint, snapshot({ channels: channels(9, 7) }), bindings).actions.map((a) => a.kind),
    ).toEqual(['reorderChannels'])
  })
})
