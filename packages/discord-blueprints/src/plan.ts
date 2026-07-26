import { canManageRole, namesToBits, type PermissionName } from '@discord-mcp/discord-api'
import type { Bindings, Blueprint, BlueprintChannel, BlueprintRole } from './schema.ts'

/**
 * Planning. It never mutates Discord.
 *
 * A plan resolves logical keys through persisted bindings, compares normalized desired and actual
 * state, checks the bot's permissions and role position, and returns an ordered diff. Everything
 * that could fail at apply time and be hard to explain — a role above the bot's own, a permission
 * the bot does not hold — is reported here instead, where it costs nothing.
 */

export type ActionKind =
  | 'createRole'
  | 'updateRole'
  | 'deleteRole'
  | 'reorderRoles'
  | 'createChannel'
  | 'updateChannel'
  | 'deleteChannel'
  | 'reorderChannels'
  | 'setOverwrites'

export interface PlannedAction {
  readonly kind: ActionKind
  readonly key: string
  readonly summary: string
  /** Fields that differ, for an update. */
  readonly changes?: ReadonlyArray<{
    readonly field: string
    readonly from: unknown
    readonly to: unknown
  }>
  readonly destructive: boolean
  /** Discord ID, when this acts on an object that already exists. */
  readonly targetId?: string
}

export interface PlanBlocker {
  readonly key: string
  readonly reason: string
}

export interface Plan {
  readonly actions: ReadonlyArray<PlannedAction>
  /** Reported at plan time so they are never discovered as a mid-apply 403. */
  readonly blockers: ReadonlyArray<PlanBlocker>
  readonly warnings: ReadonlyArray<string>
  /** True when the guild already matches: reapplying a converged blueprint must do nothing. */
  readonly converged: boolean
}

export interface ActualRole {
  readonly id: string
  readonly name: string
  readonly permissions: string
  readonly position: number
  readonly color?: number
  readonly hoist?: boolean
  readonly mentionable?: boolean
  readonly managed?: boolean
}

export interface ActualChannel {
  readonly id: string
  readonly name: string
  /** Discord's numeric channel type. */
  readonly type: number
  readonly position: number
  readonly parentId?: string | null
  readonly topic?: string | null
  readonly nsfw?: boolean
  readonly rateLimitPerUser?: number
  readonly overwrites?: ReadonlyArray<{ id: string; type: 0 | 1; allow: string; deny: string }>
}

export interface GuildSnapshot {
  readonly guildId: string
  readonly ownerId: string
  readonly roles: ReadonlyArray<ActualRole>
  readonly channels: ReadonlyArray<ActualChannel>
}

export interface PlanInput {
  readonly blueprint: Blueprint
  readonly snapshot: GuildSnapshot
  readonly bindings: Bindings
  /** The bot's own effective guild permissions, for the "can only grant what you hold" rule. */
  readonly botPermissions: bigint
  readonly botHighestRolePosition: number
  /** Managed deletion is off unless explicitly enabled *and* backed by destructive scope. */
  readonly deleteManaged?: boolean
}

export const CHANNEL_TYPE: Record<BlueprintChannel['kind'], number> = {
  text: 0,
  voice: 2,
  category: 4,
  announcement: 5,
  stage: 13,
  forum: 15,
  media: 16,
}

/** Normalise for comparison: null and empty string both mean "unset" on Discord's side. */
const norm = (value: unknown): unknown => (value === null || value === '' ? undefined : value)

/**
 * Compare one field, treating an unspecified desired value as *unmanaged* rather than as a
 * desired empty value.
 *
 * This is the field-level form of "unmanaged resources are never changed". Without it, a blueprint
 * that names a channel but says nothing about its topic would plan an action to clear the topic on
 * every apply — silently destroying state the author never mentioned, and never converging.
 */
const changed = (field: string, from: unknown, to: unknown) => {
  if (to === undefined) return undefined
  return norm(from) === norm(to) ? undefined : { field, from: norm(from), to: norm(to) }
}

const defined = <T>(entries: ReadonlyArray<T | undefined>): ReadonlyArray<T> =>
  entries.filter((c): c is T => c !== undefined)

const roleChanges = (desired: BlueprintRole, actual: ActualRole) =>
  defined([
    changed('name', actual.name, desired.name),
    changed('color', actual.color, desired.color),
    changed('hoist', actual.hoist ?? false, desired.hoist),
    changed('mentionable', actual.mentionable ?? false, desired.mentionable),
    changed(
      'permissions',
      actual.permissions,
      desired.permissions === undefined
        ? undefined
        : namesToBits(desired.permissions as ReadonlyArray<PermissionName>).toString(),
    ),
  ])

const channelChanges = (
  desired: BlueprintChannel,
  actual: ActualChannel,
  parentId: string | undefined,
) => {
  const d = desired as Record<string, unknown>
  return defined([
    changed('name', actual.name, desired.name),
    changed('parent', actual.parentId, parentId),
    changed('topic', actual.topic, d.topic),
    changed('nsfw', actual.nsfw ?? false, d.nsfw),
    changed('rateLimitPerUser', actual.rateLimitPerUser ?? 0, d.rateLimitPerUser),
  ])
}

/**
 * Ordering is derived, never requested.
 *
 * Roles must exist before overwrites can reference them; categories before their children;
 * overwrites only once both role and channel IDs resolve; position updates batched last so
 * intermediate states do not thrash. An author who could specify order would get this wrong.
 */
const ACTION_ORDER: Record<ActionKind, number> = {
  createRole: 0,
  updateRole: 1,
  deleteRole: 2,
  createChannel: 3,
  updateChannel: 4,
  deleteChannel: 5,
  setOverwrites: 6,
  reorderRoles: 7,
  reorderChannels: 8,
}

interface PlanContext {
  readonly input: PlanInput
  readonly actions: PlannedAction[]
  readonly blockers: PlanBlocker[]
  readonly warnings: string[]
  readonly resolveRole: (key: string) => ActualRole | undefined
  readonly resolveChannel: (key: string) => ActualChannel | undefined
}

/** Discord refuses to let a bot grant permissions it does not itself hold. */
const ungrantablePermissions = (
  desired: ReadonlyArray<string>,
  botPermissions: bigint,
): ReadonlyArray<string> =>
  desired.filter((p) => (namesToBits([p as PermissionName]) & botPermissions) === 0n)

const planRoles = (ctx: PlanContext): void => {
  const { input } = ctx
  for (const desired of input.blueprint.roles ?? []) {
    if (desired.permissions !== undefined) {
      const ungrantable = ungrantablePermissions(desired.permissions, input.botPermissions)
      if (ungrantable.length > 0) {
        ctx.blockers.push({
          key: desired.key,
          reason: `Role "${desired.name}" requests permissions the bot does not hold, and Discord does not let a bot grant those: ${ungrantable.join(', ')}.`,
        })
        continue
      }
    }

    const actual = ctx.resolveRole(desired.key)
    if (actual === undefined) {
      ctx.actions.push({
        kind: 'createRole',
        key: desired.key,
        summary: `Create role "${desired.name}"`,
        destructive: false,
      })
      continue
    }

    const hierarchy = canManageRole(input.botHighestRolePosition, actual, input.snapshot.guildId)
    if (!hierarchy.allowed) {
      ctx.blockers.push({
        key: desired.key,
        reason: hierarchy.reason ?? 'The bot cannot manage this role.',
      })
      continue
    }

    const changes = roleChanges(desired, actual)
    if (changes.length > 0) {
      ctx.actions.push({
        kind: 'updateRole',
        key: desired.key,
        targetId: actual.id,
        summary: `Update role "${actual.name}"${actual.name === desired.name ? '' : ` (rename to "${desired.name}")`}`,
        changes,
        destructive: false,
      })
    }
  }
}

const planChannels = (ctx: PlanContext): void => {
  const desiredChannels = ctx.input.blueprint.channels ?? []

  for (const desired of desiredChannels) {
    const parentKey = (desired as { parent?: string }).parent
    if (
      parentKey !== undefined &&
      !desiredChannels.some((c) => c.key === parentKey && c.kind === 'category')
    ) {
      ctx.blockers.push({
        key: desired.key,
        reason: `Channel "${desired.name}" names parent "${parentKey}", which is not a category in this blueprint.`,
      })
      continue
    }

    // A parent created in this same plan has no ID yet; apply resolves it from the journal.
    const parentId = parentKey === undefined ? undefined : ctx.input.bindings.get(parentKey)
    const actual = ctx.resolveChannel(desired.key)

    if (actual === undefined) {
      ctx.actions.push({
        kind: 'createChannel',
        key: desired.key,
        summary: `Create ${desired.kind} channel "${desired.name}"`,
        destructive: false,
      })
    } else if (actual.type !== CHANNEL_TYPE[desired.kind]) {
      ctx.blockers.push({
        key: desired.key,
        reason: `Channel "${actual.name}" is Discord type ${actual.type}, but the blueprint declares ${desired.kind} (type ${CHANNEL_TYPE[desired.kind]}). Discord cannot convert between these; choose a different key or delete the channel manually.`,
      })
      continue
    } else {
      const changes = channelChanges(desired, actual, parentId)
      if (changes.length > 0) {
        ctx.actions.push({
          kind: 'updateChannel',
          key: desired.key,
          targetId: actual.id,
          summary: `Update ${desired.kind} channel "${actual.name}"`,
          changes,
          destructive: false,
        })
      }
    }

    const overwrites = (desired as { overwrites?: ReadonlyArray<unknown> }).overwrites
    if (overwrites !== undefined && overwrites.length > 0) {
      ctx.actions.push({
        kind: 'setOverwrites',
        key: desired.key,
        ...(actual === undefined ? {} : { targetId: actual.id }),
        summary: `Set ${overwrites.length} permission overwrite(s) on "${desired.name}"`,
        destructive: false,
      })
    }
  }
}

const planDeletions = (ctx: PlanContext): void => {
  for (const key of ctx.input.blueprint.absent ?? []) {
    const role = ctx.resolveRole(key)
    const channel = ctx.resolveChannel(key)
    if (role === undefined && channel === undefined) continue

    if (ctx.input.deleteManaged !== true) {
      ctx.warnings.push(
        `"${key}" is marked absent but deleteManaged is not enabled, so it will be left alone. Deletion is opt-in and requires destructive authorization.`,
      )
      continue
    }

    if (role !== undefined) {
      const hierarchy = canManageRole(
        ctx.input.botHighestRolePosition,
        role,
        ctx.input.snapshot.guildId,
      )
      if (hierarchy.allowed) {
        ctx.actions.push({
          kind: 'deleteRole',
          key,
          targetId: role.id,
          summary: `Delete role "${role.name}"`,
          destructive: true,
        })
      } else {
        ctx.blockers.push({ key, reason: hierarchy.reason ?? 'The bot cannot delete this role.' })
      }
    }
    if (channel !== undefined) {
      ctx.actions.push({
        kind: 'deleteChannel',
        key,
        targetId: channel.id,
        summary: `Delete channel "${channel.name}"`,
        destructive: true,
      })
    }
  }
}

/**
 * Compare *relative* sequence, not absolute Discord positions.
 *
 * Absolute positions drift as unmanaged objects are created and deleted around the managed ones,
 * so comparing them would plan a pointless reorder on almost every apply.
 */
const sequenceDiffers = (
  ordered: ReadonlyArray<{ key: string; order?: number | undefined }>,
  positionOf: (key: string) => number | undefined,
): boolean => {
  const desired = [...ordered].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).map((o) => o.key)
  const actual = desired
    .map((key) => ({ key, position: positionOf(key) }))
    .filter((o): o is { key: string; position: number } => o.position !== undefined)
    .sort((a, b) => a.position - b.position)
    .map((o) => o.key)

  return actual.length === desired.length && actual.join() !== desired.join()
}

const planOrdering = (ctx: PlanContext): void => {
  const roles = (ctx.input.blueprint.roles ?? []).filter((r) => r.order !== undefined)
  if (roles.length > 0 && sequenceDiffers(roles, (k) => ctx.resolveRole(k)?.position)) {
    ctx.actions.push({
      kind: 'reorderRoles',
      key: '(roles)',
      summary: `Reorder ${roles.length} roles`,
      destructive: false,
    })
  }

  const channels = (ctx.input.blueprint.channels ?? []).filter((c) => c.order !== undefined)
  if (channels.length > 0 && sequenceDiffers(channels, (k) => ctx.resolveChannel(k)?.position)) {
    ctx.actions.push({
      kind: 'reorderChannels',
      key: '(channels)',
      summary: `Reorder ${channels.length} channels`,
      destructive: false,
    })
  }
}

export const planBlueprint = (input: PlanInput): Plan => {
  const roleById = new Map(input.snapshot.roles.map((r) => [r.id, r]))
  const channelById = new Map(input.snapshot.channels.map((c) => [c.id, c]))

  // A bound key whose Discord object has since been deleted falls back to "create", not an error:
  // the guild is the source of truth for existence.
  const ctx: PlanContext = {
    input,
    actions: [],
    blockers: [],
    warnings: [],
    resolveRole: (key) => {
      const id = input.bindings.get(key)
      return id === undefined ? undefined : roleById.get(id)
    },
    resolveChannel: (key) => {
      const id = input.bindings.get(key)
      return id === undefined ? undefined : channelById.get(id)
    },
  }

  planRoles(ctx)
  planChannels(ctx)
  planDeletions(ctx)
  planOrdering(ctx)

  ctx.actions.sort((a, b) => ACTION_ORDER[a.kind] - ACTION_ORDER[b.kind])

  // Unmanaged resources are never touched. Saying so explicitly is part of the plan's contract: an
  // operator reading it should not have to infer that their other channels are safe.
  const managedIds = new Set([...input.bindings.values()])
  const unmanaged = input.snapshot.channels.filter((c) => !managedIds.has(c.id)).length
  if (unmanaged > 0) {
    ctx.warnings.push(
      `${unmanaged} channel(s) in this guild are not managed by this blueprint and will not be changed or deleted.`,
    )
  }

  return {
    actions: ctx.actions,
    blockers: ctx.blockers,
    warnings: ctx.warnings,
    converged: ctx.actions.length === 0 && ctx.blockers.length === 0,
  }
}
