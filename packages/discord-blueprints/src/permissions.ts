import { PermissionFlagsBits } from 'discord-api-types/v10'
import { BlueprintError } from './errors.js'
import type { GuildSnapshot } from './types.js'

const permissions = PermissionFlagsBits as Readonly<Record<string, bigint>>

const namesForBits = (bits: bigint): ReadonlyArray<string> =>
  Object.entries(permissions)
    .filter(([, value]) => (bits & value) === value)
    .map(([name]) => name)
    .sort()

export const permissionBits = (names: ReadonlyArray<string>): bigint => {
  let bits = 0n
  for (const name of names) {
    const value = permissions[name]
    if (value === undefined) throw new BlueprintError(`Unknown Discord permission: ${name}`)
    bits |= value
  }
  return bits
}

export interface PermissionExplanation {
  readonly permissions: ReadonlyArray<string>
  readonly bits: string
  readonly trace: ReadonlyArray<string>
}

export const explainPermissions = (options: {
  readonly snapshot: GuildSnapshot
  readonly memberId: string
  readonly roleIds: ReadonlyArray<string>
  readonly channelId?: string
}): PermissionExplanation => {
  const { snapshot, memberId, roleIds, channelId } = options
  const trace: Array<string> = []
  const all = Object.values(permissions).reduce((left, right) => left | right, 0n)
  if (memberId === snapshot.ownerId) {
    return {
      permissions: namesForBits(all),
      bits: all.toString(),
      trace: ['guild owner: all permissions'],
    }
  }
  const everyone = snapshot.roles.find(({ id }) => id === snapshot.guildId)
  let bits = BigInt(everyone?.permissions ?? '0')
  trace.push(`@everyone base: ${bits}`)
  for (const role of snapshot.roles) {
    if (roleIds.includes(role.id)) {
      bits |= BigInt(role.permissions)
      trace.push(`role ${role.name} (${role.id}): aggregate ${role.permissions}`)
    }
  }
  if ((bits & PermissionFlagsBits.Administrator) !== 0n) {
    return {
      permissions: namesForBits(all),
      bits: all.toString(),
      trace: [...trace, 'Administrator: all permissions'],
    }
  }
  const channel = snapshot.channels.find(({ id }) => id === channelId)
  if (channel) {
    const everyoneOverwrite = channel.overwrites.find(
      ({ id, type }) => type === 'role' && id === snapshot.guildId,
    )
    if (everyoneOverwrite) {
      bits = (bits & ~BigInt(everyoneOverwrite.deny)) | BigInt(everyoneOverwrite.allow)
      trace.push('@everyone channel overwrite')
    }
    let roleDeny = 0n
    let roleAllow = 0n
    for (const overwrite of channel.overwrites) {
      if (overwrite.type === 'role' && roleIds.includes(overwrite.id)) {
        roleDeny |= BigInt(overwrite.deny)
        roleAllow |= BigInt(overwrite.allow)
      }
    }
    bits = (bits & ~roleDeny) | roleAllow
    if (roleDeny !== 0n || roleAllow !== 0n) trace.push('aggregated role channel overwrites')
    const memberOverwrite = channel.overwrites.find(
      ({ id, type }) => type === 'member' && id === memberId,
    )
    if (memberOverwrite) {
      bits = (bits & ~BigInt(memberOverwrite.deny)) | BigInt(memberOverwrite.allow)
      trace.push('member channel overwrite')
    }
  }
  return { permissions: namesForBits(bits), bits: bits.toString(), trace }
}
