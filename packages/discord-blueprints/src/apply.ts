import { DiscordRest, namesToBits, type PermissionName } from '@discord-mcp/discord-api'
import { BlueprintRepository } from '@discord-mcp/persistence'
import { Effect } from 'effect'
import { CHANNEL_TYPE, type PlannedAction } from './plan.ts'
import type { Blueprint, BlueprintChannel, BlueprintRole, PermissionOverwrite } from './schema.ts'

/**
 * Apply, with an execution journal.
 *
 * Discord has no transactions. A create that succeeds and a following overwrite that fails leaves
 * the guild half-built, and there is no rollback that would be safe to attempt automatically. So
 * every action is journalled before it runs and marked as it completes: a partial failure is a
 * resumable record rather than an unknown state, and the operator gets a report of exactly what
 * was done.
 *
 * Bindings are written the moment an object is created, before the next action runs. If the
 * process dies immediately afterwards, the resume path finds the object already bound rather than
 * creating a duplicate.
 */

export interface ApplyOutcome {
  readonly executionId: string
  readonly status: 'completed' | 'failed' | 'partial'
  readonly completed: ReadonlyArray<{
    readonly sequence: number
    readonly summary: string
    readonly discordId?: string
  }>
  readonly failed?: { readonly sequence: number; readonly summary: string; readonly error: string }
  readonly pending: ReadonlyArray<{ readonly sequence: number; readonly summary: string }>
  readonly resumeHint?: string
}

export interface ApplyInput {
  readonly blueprintId: string
  readonly revision: number
  readonly guildId: string
  readonly blueprint: Blueprint
  readonly actions: ReadonlyArray<PlannedAction>
  readonly snapshotDigest: string
  readonly principalId: string
  readonly auditLogReason: string
}

const roleBody = (role: BlueprintRole) => ({
  name: role.name,
  ...(role.color === undefined ? {} : { color: role.color }),
  ...(role.hoist === undefined ? {} : { hoist: role.hoist }),
  ...(role.mentionable === undefined ? {} : { mentionable: role.mentionable }),
  ...(role.permissions === undefined
    ? {}
    : { permissions: namesToBits(role.permissions as ReadonlyArray<PermissionName>).toString() }),
})

const channelBody = (channel: BlueprintChannel, parentId: string | undefined) => {
  const c = channel as Record<string, unknown>
  return {
    name: channel.name,
    type: CHANNEL_TYPE[channel.kind],
    ...(parentId === undefined ? {} : { parent_id: parentId }),
    ...(c.topic === undefined ? {} : { topic: c.topic }),
    ...(c.nsfw === undefined ? {} : { nsfw: c.nsfw }),
    ...(c.rateLimitPerUser === undefined ? {} : { rate_limit_per_user: c.rateLimitPerUser }),
    ...(c.bitrate === undefined ? {} : { bitrate: c.bitrate }),
    ...(c.userLimit === undefined ? {} : { user_limit: c.userLimit }),
  }
}

/** Resolve an overwrite target to a Discord ID and Discord's numeric target kind. */
const resolveOverwrite = (
  overwrite: PermissionOverwrite,
  guildId: string,
  bindings: ReadonlyMap<string, string>,
): { id: string; type: 0 | 1; allow: string; deny: string } | undefined => {
  const target = overwrite.target
  const id =
    target.type === 'everyone'
      ? guildId
      : target.type === 'roleKey'
        ? bindings.get(target.key)
        : target.id

  if (id === undefined) return undefined

  return {
    id,
    type: target.type === 'memberId' ? 1 : 0,
    allow: namesToBits((overwrite.allow ?? []) as ReadonlyArray<PermissionName>).toString(),
    deny: namesToBits((overwrite.deny ?? []) as ReadonlyArray<PermissionName>).toString(),
  }
}

export const applyBlueprint = (input: ApplyInput) =>
  Effect.gen(function* () {
    const rest = yield* DiscordRest
    const repo = yield* BlueprintRepository

    const executionId = yield* repo.startExecution({
      blueprintId: input.blueprintId,
      revision: input.revision,
      guildId: input.guildId,
      snapshotDigest: input.snapshotDigest,
      startedBy: input.principalId,
      actions: input.actions.map((a) => ({
        kind: a.kind,
        logicalKey: a.key,
        summary: a.summary,
        payload: { changes: a.changes ?? [], targetId: a.targetId ?? null },
      })),
    })

    // Bindings are read once and updated in memory as objects are created, so a later action can
    // reference a role created earlier in this same run.
    const bindings = new Map(yield* repo.bindings(input.blueprintId, input.guildId))
    const roles = new Map((input.blueprint.roles ?? []).map((r) => [r.key, r]))
    const channels = new Map((input.blueprint.channels ?? []).map((c) => [c.key, c]))

    const completed: Array<{ sequence: number; summary: string; discordId?: string }> = []
    let failure: ApplyOutcome['failed']

    for (const [sequence, action] of input.actions.entries()) {
      if (failure !== undefined) break

      const result = yield* Effect.result(
        runAction(action, { rest, repo, bindings, roles, channels, input }),
      )

      if (result._tag === 'Failure') {
        const message =
          typeof result.failure === 'object' &&
          result.failure !== null &&
          'message' in result.failure
            ? String((result.failure as { message: unknown }).message)
            : String(result.failure)

        yield* repo.completeAction(executionId, sequence, { status: 'failed', error: message })
        failure = { sequence, summary: action.summary, error: message }
        break
      }

      yield* repo.completeAction(executionId, sequence, {
        status: 'completed',
        ...(result.success === undefined ? {} : { discordId: result.success }),
      })
      completed.push({
        sequence,
        summary: action.summary,
        ...(result.success === undefined ? {} : { discordId: result.success }),
      })
    }

    const pending = input.actions
      .map((a, sequence) => ({ sequence, summary: a.summary }))
      .filter((a) => a.sequence > (failure?.sequence ?? input.actions.length - 1))

    const status = failure === undefined ? 'completed' : completed.length > 0 ? 'partial' : 'failed'
    yield* repo.finishExecution(executionId, status)

    return {
      executionId,
      status,
      completed,
      ...(failure === undefined ? {} : { failed: failure }),
      pending,
      ...(status === 'completed'
        ? {}
        : {
            resumeHint: `${completed.length} action(s) succeeded and were bound, ${pending.length} were not attempted. Fix the cause of the failure and re-plan: already-completed work is bound, so the new plan will not repeat it.`,
          }),
    } satisfies ApplyOutcome
  })

interface ActionContext {
  readonly rest: DiscordRest['Service']
  readonly repo: BlueprintRepository['Service']
  readonly bindings: Map<string, string>
  readonly roles: ReadonlyMap<string, BlueprintRole>
  readonly channels: ReadonlyMap<string, BlueprintChannel>
  readonly input: ApplyInput
}

/** Role mutations. Creates bind immediately so a resumed apply cannot duplicate them. */
const runRoleAction = (
  action: PlannedAction,
  ctx: ActionContext,
): Effect.Effect<string | undefined, unknown> =>
  Effect.gen(function* () {
    const { rest, repo, bindings, input } = ctx
    const role = ctx.roles.get(action.key)

    if (action.kind === 'createRole') {
      if (role === undefined) return undefined
      const created = (yield* rest.request({
        method: 'POST',
        route: `/guilds/${input.guildId}/roles`,
        operationFamily: 'role',
        body: roleBody(role),
        auditLogReason: input.auditLogReason,
      })) as { id: string }

      // Bound before the next action runs. A crash immediately after this resumes without
      // creating a second role with the same name.
      bindings.set(action.key, created.id)
      yield* repo.bind(input.blueprintId, input.guildId, {
        logicalKey: action.key,
        discordId: created.id,
        objectKind: 'role',
      })
      return created.id
    }

    if (action.kind === 'updateRole') {
      if (role === undefined || action.targetId === undefined) return undefined
      yield* rest.request({
        method: 'PATCH',
        route: `/guilds/${input.guildId}/roles/${action.targetId}`,
        operationFamily: 'role',
        body: roleBody(role),
        auditLogReason: input.auditLogReason,
      })
      return action.targetId
    }

    if (action.targetId === undefined) return undefined
    yield* rest.request({
      method: 'DELETE',
      route: `/guilds/${input.guildId}/roles/${action.targetId}`,
      operationFamily: 'role',
      auditLogReason: input.auditLogReason,
    })
    yield* repo.unbind(input.blueprintId, input.guildId, action.key)
    bindings.delete(action.key)
    return undefined
  })

/** Channel mutations, including overwrites, which run only once both IDs resolve. */
const runChannelAction = (
  action: PlannedAction,
  ctx: ActionContext,
): Effect.Effect<string | undefined, unknown> =>
  Effect.gen(function* () {
    const { rest, repo, bindings, input } = ctx
    const channel = ctx.channels.get(action.key)
    const parentKey = (channel as { parent?: string } | undefined)?.parent
    const parentId = parentKey === undefined ? undefined : bindings.get(parentKey)

    if (action.kind === 'createChannel') {
      if (channel === undefined) return undefined
      const created = (yield* rest.request({
        method: 'POST',
        route: `/guilds/${input.guildId}/channels`,
        operationFamily: 'channel',
        body: channelBody(channel, parentId),
        auditLogReason: input.auditLogReason,
      })) as { id: string }

      bindings.set(action.key, created.id)
      yield* repo.bind(input.blueprintId, input.guildId, {
        logicalKey: action.key,
        discordId: created.id,
        objectKind: 'channel',
      })
      return created.id
    }

    if (action.kind === 'updateChannel') {
      if (channel === undefined || action.targetId === undefined) return undefined
      yield* rest.request({
        method: 'PATCH',
        route: `/channels/${action.targetId}`,
        operationFamily: 'channel',
        body: channelBody(channel, parentId),
        auditLogReason: input.auditLogReason,
      })
      return action.targetId
    }

    if (action.kind === 'deleteChannel') {
      if (action.targetId === undefined) return undefined
      yield* rest.request({
        method: 'DELETE',
        route: `/channels/${action.targetId}`,
        operationFamily: 'channel',
        auditLogReason: input.auditLogReason,
      })
      yield* repo.unbind(input.blueprintId, input.guildId, action.key)
      bindings.delete(action.key)
      return undefined
    }

    // setOverwrites. Runs after creates, so every role key it references is already bound.
    const channelId = bindings.get(action.key)
    if (channel === undefined || channelId === undefined) return undefined

    const overwrites = (
      (channel as { overwrites?: ReadonlyArray<PermissionOverwrite> }).overwrites ?? []
    )
      .map((o) => resolveOverwrite(o, input.guildId, bindings))
      .filter((o): o is NonNullable<typeof o> => o !== undefined)

    yield* rest.request({
      method: 'PATCH',
      route: `/channels/${channelId}`,
      operationFamily: 'channel',
      body: { permission_overwrites: overwrites },
      auditLogReason: input.auditLogReason,
    })
    return channelId
  })

/**
 * Positions, batched last.
 *
 * Discord recalculates every sibling's position on each change, so applying these incrementally
 * would thrash and leave intermediate orderings visible to anyone watching the guild.
 */
const runReorderAction = (
  action: PlannedAction,
  ctx: ActionContext,
): Effect.Effect<undefined, unknown> =>
  Effect.gen(function* () {
    const { rest, bindings, input } = ctx
    const isRoles = action.kind === 'reorderRoles'

    const source = isRoles ? [...ctx.roles.values()] : [...ctx.channels.values()]
    const ordered = source
      .filter((o) => o.order !== undefined)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .map((o, index) => ({ id: bindings.get(o.key), position: isRoles ? index + 1 : index }))
      .filter((o): o is { id: string; position: number } => o.id !== undefined)

    yield* rest.request({
      method: 'PATCH',
      route: isRoles ? `/guilds/${input.guildId}/roles` : `/guilds/${input.guildId}/channels`,
      operationFamily: isRoles ? 'role' : 'channel',
      body: ordered,
      auditLogReason: input.auditLogReason,
    })
    return undefined
  })

/** Returns the Discord ID when the action created something. */
const runAction = (
  action: PlannedAction,
  ctx: ActionContext,
): Effect.Effect<string | undefined, unknown> => {
  switch (action.kind) {
    case 'createRole':
    case 'updateRole':
    case 'deleteRole':
      return runRoleAction(action, ctx)
    case 'createChannel':
    case 'updateChannel':
    case 'deleteChannel':
    case 'setOverwrites':
      return runChannelAction(action, ctx)
    case 'reorderRoles':
    case 'reorderChannels':
      return runReorderAction(action, ctx)
  }
}
