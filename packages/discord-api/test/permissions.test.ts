import { PermissionFlagsBits } from 'discord-api-types/v10'
import { describe, expect, it } from 'vitest'
import {
  canManageRole,
  computeEffectivePermissions,
  explainMissing,
  namesToBits,
  permissionNames,
} from '../src/permissions.ts'

const GUILD = '123456789012345678'
const OWNER = '111111111111111111'
const MEMBER = '222222222222222222'
const ROLE_A = '333333333333333333'
const ROLE_B = '444444444444444444'

const everyone = (perms: bigint) => ({
  id: GUILD,
  name: '@everyone',
  permissions: perms.toString(),
  position: 0,
})

const role = (id: string, name: string, perms: bigint, position: number, managed = false) => ({
  id,
  name,
  permissions: perms.toString(),
  position,
  managed,
})

const base = {
  guildId: GUILD,
  guildOwnerId: OWNER,
  memberId: MEMBER,
  memberRoleIds: [ROLE_A],
}

describe('bitfield handling', () => {
  it('uses BigInt, because JavaScript bitwise operators truncate to 32 bits', () => {
    // The operative danger today. BypassSlowmode is 1 << 52 — far above 2^31, so `bits & flag`
    // on plain numbers would coerce both to int32 and silently return 0. No single flag exceeds
    // 2^53 at this pin, but many exceed 2^31, and Discord serialises permissions as decimal
    // strings precisely because they will keep growing.
    const high = PermissionFlagsBits.BypassSlowmode
    expect(high).toBeGreaterThan(2n ** 31n)
    expect(Number(high) & Number(PermissionFlagsBits.ViewChannel)).toBe(0)

    expect(permissionNames(high.toString())).toContain('BypassSlowmode')
    expect(namesToBits(['BypassSlowmode'])).toBe(high)
    // And it composes correctly with a low flag, which is what a truncating implementation loses.
    const combined = namesToBits(['BypassSlowmode', 'ViewChannel'])
    expect(permissionNames(combined).sort()).toEqual(['BypassSlowmode', 'ViewChannel'])
  })

  it('round-trips names through bits', () => {
    const names = ['SendMessages', 'ManageRoles', 'ViewChannel'] as const
    expect(permissionNames(namesToBits(names)).sort()).toEqual([...names].sort())
  })
})

describe('short circuits', () => {
  it('grants the guild owner everything, and says that is why', () => {
    const result = computeEffectivePermissions({ ...base, memberId: OWNER, roles: [everyone(0n)] })
    expect(result.shortCircuit).toBe('owner')
    expect(result.permissions).toContain('Administrator')
    // Overwrite reasoning would be misleading here, so there is none.
    expect(result.steps).toHaveLength(1)
  })

  it('grants an administrator everything and ignores channel overwrites entirely', () => {
    const result = computeEffectivePermissions({
      ...base,
      roles: [everyone(0n), role(ROLE_A, 'Admins', PermissionFlagsBits.Administrator, 5)],
      channelId: '555555555555555555',
      // A deny that would matter for anyone else.
      overwrites: [
        { id: GUILD, type: 0, allow: '0', deny: PermissionFlagsBits.SendMessages.toString() },
      ],
    })

    expect(result.shortCircuit).toBe('administrator')
    expect(result.permissions).toContain('SendMessages')
    expect(result.steps.at(-1)?.source).toBe('Admins')
  })
})

describe('overwrite order', () => {
  it('applies @everyone base, then roles, then the @everyone overwrite', () => {
    const result = computeEffectivePermissions({
      ...base,
      roles: [
        everyone(PermissionFlagsBits.ViewChannel),
        role(ROLE_A, 'Writers', PermissionFlagsBits.SendMessages, 3),
      ],
      overwrites: [
        { id: GUILD, type: 0, allow: '0', deny: PermissionFlagsBits.SendMessages.toString() },
      ],
    })

    expect(result.permissions).toContain('ViewChannel')
    expect(result.permissions).not.toContain('SendMessages')
    expect(result.steps.map((s) => s.stage)).toEqual(['base', 'roles', 'channel'])
  })

  it('lets one role’s allow rescue another role’s deny, because denies apply as a group first', () => {
    // The counter-intuitive one. Discord accumulates every role deny, applies them together, then
    // accumulates every role allow and applies those — so allow wins across roles.
    const result = computeEffectivePermissions({
      ...base,
      memberRoleIds: [ROLE_A, ROLE_B],
      roles: [
        everyone(PermissionFlagsBits.SendMessages),
        role(ROLE_A, 'Muted', 0n, 1),
        role(ROLE_B, 'Staff', 0n, 2),
      ],
      overwrites: [
        { id: ROLE_A, type: 0, allow: '0', deny: PermissionFlagsBits.SendMessages.toString() },
        { id: ROLE_B, type: 0, allow: PermissionFlagsBits.SendMessages.toString(), deny: '0' },
      ],
    })

    expect(result.permissions).toContain('SendMessages')
  })

  it('lets a member overwrite beat every role overwrite', () => {
    const result = computeEffectivePermissions({
      ...base,
      roles: [everyone(PermissionFlagsBits.SendMessages)],
      overwrites: [
        { id: ROLE_A, type: 0, allow: PermissionFlagsBits.SendMessages.toString(), deny: '0' },
        { id: MEMBER, type: 1, allow: '0', deny: PermissionFlagsBits.SendMessages.toString() },
      ],
    })

    expect(result.permissions).not.toContain('SendMessages')
    expect(result.steps.at(-1)?.source).toBe('member overwrite deny')
  })
})

describe('explainMissing', () => {
  it('names the overwrite that removed the permission, not just the fact it is missing', () => {
    const result = computeEffectivePermissions({
      ...base,
      roles: [everyone(PermissionFlagsBits.SendMessages)],
      overwrites: [
        { id: GUILD, type: 0, allow: '0', deny: PermissionFlagsBits.SendMessages.toString() },
      ],
    })

    const explanation = explainMissing(result, 'SendMessages')
    expect(explanation).toContain('@everyone channel overwrite')
    expect(explanation).toContain('granted earlier by @everyone role')
  })

  it('says so plainly when nothing ever granted it', () => {
    const result = computeEffectivePermissions({ ...base, roles: [everyone(0n)] })
    expect(explainMissing(result, 'ManageRoles')).toContain('not granted by any of this member')
  })

  it('confirms a granted permission', () => {
    const result = computeEffectivePermissions({
      ...base,
      roles: [everyone(PermissionFlagsBits.ViewChannel)],
    })
    expect(explainMissing(result, 'ViewChannel')).toBe('ViewChannel is granted.')
  })
})

describe('role hierarchy', () => {
  it('refuses a role at or above the bot’s highest', () => {
    expect(canManageRole(5, role(ROLE_A, 'Admins', 0n, 5), GUILD).allowed).toBe(false)
    expect(canManageRole(5, role(ROLE_A, 'Admins', 0n, 6), GUILD).reason).toContain(
      'strictly below',
    )
    expect(canManageRole(5, role(ROLE_A, 'Members', 0n, 4), GUILD).allowed).toBe(true)
  })

  it('refuses @everyone and integration-managed roles', () => {
    expect(canManageRole(99, role(GUILD, '@everyone', 0n, 0), GUILD).reason).toContain('@everyone')
    expect(canManageRole(99, role(ROLE_A, 'Bot Role', 0n, 1, true), GUILD).reason).toContain(
      'managed',
    )
  })
})
