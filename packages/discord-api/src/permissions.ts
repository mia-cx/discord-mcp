import { PermissionFlagsBits } from 'discord-api-types/v10'

/**
 * Effective-permission computation, following Discord's own order exactly.
 *
 * Every 403 renderer in this server points here instead of inviting a retry. That matters more
 * than it sounds: a model's reflex on 403 is to retry with permuted arguments, and repeated
 * rejections are what walk an installation toward Cloudflare's ban threshold. One cheap
 * deterministic diagnostic turns a retry loop into a report to the user.
 *
 * All arithmetic is BigInt. Permission flags already exceed 2^31 (BypassSlowmode is 1 << 52), and
 * JavaScript's bitwise operators coerce their operands to int32 — so `bits & flag` on plain
 * numbers silently returns 0 for every modern permission. Discord serialises these as decimal
 * strings for the same reason.
 */

export type PermissionName = keyof typeof PermissionFlagsBits

const ALL_FLAGS = Object.entries(PermissionFlagsBits) as ReadonlyArray<[PermissionName, bigint]>

export const ADMINISTRATOR = PermissionFlagsBits.Administrator

export const toBigInt = (bits: string | bigint): bigint =>
  typeof bits === 'bigint' ? bits : BigInt(bits)

/** Decompose a bitfield into permission names. Names, never raw integers, cross our boundaries. */
export const permissionNames = (bits: string | bigint): ReadonlyArray<PermissionName> => {
  const value = toBigInt(bits)
  return ALL_FLAGS.filter(([, flag]) => (value & flag) === flag).map(([name]) => name)
}

export const namesToBits = (names: ReadonlyArray<PermissionName>): bigint =>
  names.reduce((acc, name) => acc | PermissionFlagsBits[name], 0n)

export const has = (bits: bigint, name: PermissionName): boolean =>
  (bits & ADMINISTRATOR) === ADMINISTRATOR ||
  (bits & PermissionFlagsBits[name]) === PermissionFlagsBits[name]

export interface RoleLike {
  readonly id: string
  readonly name: string
  readonly permissions: string
  readonly position: number
  readonly managed?: boolean
}

export interface OverwriteLike {
  readonly id: string
  /** 0 = role, 1 = member. Discord's own encoding. */
  readonly type: 0 | 1
  readonly allow: string
  readonly deny: string
}

export interface EffectivePermissionInput {
  readonly guildId: string
  readonly guildOwnerId: string
  readonly memberId: string
  readonly memberRoleIds: ReadonlyArray<string>
  /** Every role in the guild, including `@everyone` (whose id equals the guild id). */
  readonly roles: ReadonlyArray<RoleLike>
  /** Channel overwrites, when asking about a specific channel. */
  readonly overwrites?: ReadonlyArray<OverwriteLike>
  readonly channelId?: string
}

export interface PermissionExplanation {
  readonly permissions: ReadonlyArray<PermissionName>
  readonly bits: string
  /** Set when the answer short-circuits, because further reasoning would be misleading. */
  readonly shortCircuit?: 'owner' | 'administrator'
  /** Why each stage changed the answer, in the order Discord applies them. */
  readonly steps: ReadonlyArray<{
    readonly stage: string
    readonly source: string
    readonly allowed: ReadonlyArray<PermissionName>
    readonly denied: ReadonlyArray<PermissionName>
  }>
}

const diffNames = (before: bigint, after: bigint) => ({
  allowed: permissionNames(after & ~before),
  denied: permissionNames(before & ~after),
})

/**
 * Discord's overwrite order, which is not intuitive and is the usual cause of "why can't the bot
 * post here":
 *
 *   base @everyone → aggregated role permissions → @everyone overwrite → role denies →
 *   role allows → member deny → member allow
 *
 * Role denies are applied as a group *before* role allows, so one role's allow can rescue another
 * role's deny. Member overwrites always win over role ones.
 */
export const computeEffectivePermissions = (
  input: EffectivePermissionInput,
): PermissionExplanation => {
  const steps: PermissionExplanation['steps'] = []
  const push = (stage: string, source: string, before: bigint, after: bigint) => {
    const { allowed, denied } = diffNames(before, after)
    if (allowed.length > 0 || denied.length > 0) {
      ;(steps as Array<PermissionExplanation['steps'][number]>).push({
        stage,
        source,
        allowed,
        denied,
      })
    }
  }

  // The guild owner has everything, unconditionally. Reporting per-overwrite reasoning here would
  // be actively misleading, because none of it applies.
  if (input.memberId === input.guildOwnerId) {
    return {
      permissions: ALL_FLAGS.map(([name]) => name),
      bits: ALL_FLAGS.reduce((acc, [, flag]) => acc | flag, 0n).toString(),
      shortCircuit: 'owner',
      steps: [
        {
          stage: 'owner',
          source: 'guild owner',
          allowed: ALL_FLAGS.map(([name]) => name),
          denied: [],
        },
      ],
    }
  }

  const everyoneRole = input.roles.find((r) => r.id === input.guildId)
  let bits = everyoneRole === undefined ? 0n : toBigInt(everyoneRole.permissions)
  push('base', '@everyone role', 0n, bits)

  const memberRoles = input.roles.filter((r) => input.memberRoleIds.includes(r.id))
  for (const role of memberRoles) {
    const before = bits
    bits |= toBigInt(role.permissions)
    push('roles', `role ${role.name}`, before, bits)
  }

  // Administrator grants everything and ignores every channel overwrite. Saying so is the whole
  // answer; walking the overwrites afterwards would suggest they matter.
  if ((bits & ADMINISTRATOR) === ADMINISTRATOR) {
    return {
      permissions: ALL_FLAGS.map(([name]) => name),
      bits: ALL_FLAGS.reduce((acc, [, flag]) => acc | flag, 0n).toString(),
      shortCircuit: 'administrator',
      steps: [
        ...steps,
        {
          stage: 'administrator',
          source:
            memberRoles.find((r) => (toBigInt(r.permissions) & ADMINISTRATOR) === ADMINISTRATOR)
              ?.name ?? 'a role',
          allowed: ALL_FLAGS.map(([name]) => name),
          denied: [],
        },
      ],
    }
  }

  const overwrites = input.overwrites ?? []
  if (overwrites.length === 0) {
    return { permissions: permissionNames(bits), bits: bits.toString(), steps }
  }

  const everyoneOverwrite = overwrites.find((o) => o.id === input.guildId)
  if (everyoneOverwrite !== undefined) {
    const before = bits
    bits &= ~toBigInt(everyoneOverwrite.deny)
    bits |= toBigInt(everyoneOverwrite.allow)
    push('channel', '@everyone channel overwrite', before, bits)
  }

  // Role denies are accumulated and applied together, then role allows. A member with two roles
  // where one denies and the other allows ends up allowed, which surprises people.
  const roleOverwrites = overwrites.filter(
    (o) => o.type === 0 && input.memberRoleIds.includes(o.id),
  )
  const roleDeny = roleOverwrites.reduce((acc, o) => acc | toBigInt(o.deny), 0n)
  const roleAllow = roleOverwrites.reduce((acc, o) => acc | toBigInt(o.allow), 0n)

  if (roleDeny !== 0n) {
    const before = bits
    bits &= ~roleDeny
    push('channel', 'role overwrite denies', before, bits)
  }
  if (roleAllow !== 0n) {
    const before = bits
    bits |= roleAllow
    push('channel', 'role overwrite allows', before, bits)
  }

  const memberOverwrite = overwrites.find((o) => o.type === 1 && o.id === input.memberId)
  if (memberOverwrite !== undefined) {
    const beforeDeny = bits
    bits &= ~toBigInt(memberOverwrite.deny)
    push('channel', 'member overwrite deny', beforeDeny, bits)

    const beforeAllow = bits
    bits |= toBigInt(memberOverwrite.allow)
    push('channel', 'member overwrite allow', beforeAllow, bits)
  }

  return { permissions: permissionNames(bits), bits: bits.toString(), steps }
}

/**
 * Explain why a specific permission is missing, naming the stage that removed it.
 *
 * "Missing ManageRoles" is a fact. "The @everyone channel overwrite denies it" is something the
 * user can act on.
 */
export const explainMissing = (
  explanation: PermissionExplanation,
  required: PermissionName,
): string => {
  if (explanation.permissions.includes(required)) return `${required} is granted.`

  const removedBy = [...explanation.steps].reverse().find((s) => s.denied.includes(required))
  const grantedBy = explanation.steps.find((s) => s.allowed.includes(required))

  if (removedBy !== undefined) {
    return `${required} is denied by ${removedBy.source} (${removedBy.stage} stage).${
      grantedBy === undefined ? '' : ` It was granted earlier by ${grantedBy.source}.`
    }`
  }
  return `${required} is not granted by any of this member's roles, and no channel overwrite adds it.`
}

/**
 * Discord's role hierarchy: a bot may only manage roles strictly below its highest role, and may
 * only grant permissions it holds. Reporting this at plan time is the difference between a clear
 * explanation and a mid-apply 403.
 */
export const canManageRole = (
  actorHighestPosition: number,
  target: RoleLike,
  guildId: string,
): { readonly allowed: boolean; readonly reason?: string } => {
  if (target.id === guildId) {
    return { allowed: false, reason: 'The @everyone role cannot be repositioned or deleted.' }
  }
  if (target.managed === true) {
    return {
      allowed: false,
      reason: `"${target.name}" is managed by an integration or bot, so Discord does not permit editing it.`,
    }
  }
  if (target.position >= actorHighestPosition) {
    return {
      allowed: false,
      reason: `"${target.name}" is at position ${target.position}, at or above the bot's highest role (${actorHighestPosition}). A bot can only manage roles strictly below its own.`,
    }
  }
  return { allowed: true }
}
