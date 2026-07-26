import { createHash } from 'node:crypto'
import { DiscordRest, permissionNames, toBigInt } from '@discord-mcp/discord-api'
import { Effect, Schema } from 'effect'
import type { ActualChannel, ActualRole, GuildSnapshot } from './plan.ts'

/**
 * Read a guild's current structure, normalized.
 *
 * Normalization is what makes the diff stable. Discord returns absolute positions that shift as
 * unmanaged objects come and go, nulls and empty strings interchangeably, and fields in whatever
 * order it likes — so a digest over the raw response would change constantly and every apply would
 * be refused as stale.
 */

const GuildPayload = Schema.Struct({
  id: Schema.String,
  owner_id: Schema.String,
  name: Schema.String,
})

const RolesPayload = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    permissions: Schema.String,
    position: Schema.Int,
    color: Schema.optionalKey(Schema.Int),
    hoist: Schema.optionalKey(Schema.Boolean),
    mentionable: Schema.optionalKey(Schema.Boolean),
    managed: Schema.optionalKey(Schema.Boolean),
  }),
)

const ChannelsPayload = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    type: Schema.Int,
    position: Schema.optionalKey(Schema.Int),
    parent_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
    topic: Schema.optionalKey(Schema.NullOr(Schema.String)),
    nsfw: Schema.optionalKey(Schema.Boolean),
    rate_limit_per_user: Schema.optionalKey(Schema.Int),
    permission_overwrites: Schema.optionalKey(
      Schema.Array(
        Schema.Struct({
          id: Schema.String,
          type: Schema.Int,
          allow: Schema.String,
          deny: Schema.String,
        }),
      ),
    ),
  }),
)

export interface SnapshotResult {
  readonly snapshot: GuildSnapshot
  /**
   * Digest over the normalized snapshot.
   *
   * A preview token binds this, so an apply planned against one state cannot execute against
   * another — the case where someone reorganises the guild between plan and apply.
   */
  readonly digest: string
  readonly guildName: string
  readonly botHighestRolePosition: number
  readonly botPermissions: bigint
}

/** Sorted keys and omitted defaults, so equivalent guilds digest identically. */
const canonical = (snapshot: GuildSnapshot): string =>
  JSON.stringify({
    guildId: snapshot.guildId,
    ownerId: snapshot.ownerId,
    roles: [...snapshot.roles]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((r) => [
        r.id,
        r.name,
        r.permissions,
        r.position,
        r.color ?? 0,
        r.hoist ?? false,
        r.mentionable ?? false,
      ]),
    channels: [...snapshot.channels]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((c) => [
        c.id,
        c.name,
        c.type,
        c.position,
        c.parentId ?? null,
        c.topic ?? null,
        c.nsfw ?? false,
        c.rateLimitPerUser ?? 0,
        [...(c.overwrites ?? [])]
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((o) => [o.id, o.type, o.allow, o.deny]),
      ]),
  })

export const snapshotDigest = (snapshot: GuildSnapshot): string =>
  createHash('sha256').update(canonical(snapshot)).digest('hex')

export const readGuildSnapshot = (guildId: string) =>
  Effect.gen(function* () {
    const rest = yield* DiscordRest

    const guild = yield* Schema.decodeUnknownEffect(GuildPayload)(
      yield* rest.request({ method: 'GET', route: `/guilds/${guildId}`, operationFamily: 'guild' }),
    )
    const rawRoles = yield* Schema.decodeUnknownEffect(RolesPayload)(
      yield* rest.request({
        method: 'GET',
        route: `/guilds/${guildId}/roles`,
        operationFamily: 'role',
      }),
    )
    const rawChannels = yield* Schema.decodeUnknownEffect(ChannelsPayload)(
      yield* rest.request({
        method: 'GET',
        route: `/guilds/${guildId}/channels`,
        operationFamily: 'channel',
      }),
    )
    const botMember = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ roles: Schema.Array(Schema.String) }),
    )(
      yield* rest.request({
        method: 'GET',
        route: `/guilds/${guildId}/members/@me`,
        operationFamily: 'member',
      }),
    )

    const roles: ReadonlyArray<ActualRole> = rawRoles.map((r) => ({
      id: r.id,
      name: r.name,
      permissions: r.permissions,
      position: r.position,
      ...(r.color === undefined ? {} : { color: r.color }),
      ...(r.hoist === undefined ? {} : { hoist: r.hoist }),
      ...(r.mentionable === undefined ? {} : { mentionable: r.mentionable }),
      ...(r.managed === undefined ? {} : { managed: r.managed }),
    }))

    const channels: ReadonlyArray<ActualChannel> = rawChannels.map((c) => ({
      id: c.id,
      name: c.name,
      type: c.type,
      position: c.position ?? 0,
      ...(c.parent_id === undefined ? {} : { parentId: c.parent_id }),
      ...(c.topic === undefined ? {} : { topic: c.topic }),
      ...(c.nsfw === undefined ? {} : { nsfw: c.nsfw }),
      ...(c.rate_limit_per_user === undefined ? {} : { rateLimitPerUser: c.rate_limit_per_user }),
      ...(c.permission_overwrites === undefined
        ? {}
        : {
            overwrites: c.permission_overwrites.map((o) => ({
              id: o.id,
              type: o.type === 1 ? (1 as const) : (0 as const),
              allow: o.allow,
              deny: o.deny,
            })),
          }),
    }))

    const snapshot: GuildSnapshot = { guildId: guild.id, ownerId: guild.owner_id, roles, channels }

    // The bot's own ceiling: it can manage roles strictly below its highest, and grant only
    // permissions it holds. Both are needed for the plan's blockers.
    const botRoles = roles.filter((r) => botMember.roles.includes(r.id))
    const everyone = roles.find((r) => r.id === guildId)
    const botPermissions = [...botRoles, ...(everyone === undefined ? [] : [everyone])].reduce(
      (acc, r) => acc | toBigInt(r.permissions),
      0n,
    )

    return {
      snapshot,
      digest: snapshotDigest(snapshot),
      guildName: guild.name,
      botHighestRolePosition: botRoles.reduce((max, r) => Math.max(max, r.position), 0),
      botPermissions,
    } satisfies SnapshotResult
  })

/** A bounded structural view for planning, with named permission flags rather than bitfields. */
export const describeSnapshot = (result: SnapshotResult) => ({
  guildId: result.snapshot.guildId,
  guildName: result.guildName,
  snapshotDigest: result.digest,
  bot: {
    highestRolePosition: result.botHighestRolePosition,
    permissions: permissionNames(result.botPermissions),
  },
  roles: result.snapshot.roles
    .slice()
    .sort((a, b) => b.position - a.position)
    .map((r) => ({
      id: r.id,
      name: r.name,
      position: r.position,
      managed: r.managed ?? false,
      permissions: permissionNames(r.permissions),
    })),
  channels: result.snapshot.channels
    .slice()
    .sort((a, b) => a.position - b.position)
    .map((c) => ({
      id: c.id,
      name: c.name,
      type: c.type,
      position: c.position,
      parentId: c.parentId ?? null,
      overwrites: (c.overwrites ?? []).map((o) => ({
        targetId: o.id,
        targetKind: o.type === 1 ? 'member' : 'role',
        allow: permissionNames(o.allow),
        deny: permissionNames(o.deny),
      })),
    })),
})
