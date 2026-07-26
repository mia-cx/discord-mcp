import { Snowflake } from '@discord-mcp/core'
import { Schema } from 'effect'

/**
 * A declarative description of a guild's structure.
 *
 * The central decision is **logical keys with persisted bindings, not name matching**. Names in
 * Discord are neither unique nor stable: matching by name creates duplicates the moment someone
 * renames a channel, and picks the wrong object when two share a name. Each blueprint object
 * carries a key, and a bindings table maps key → snowflake, so a rename preserves identity.
 */

const bounded =
  <S extends Schema.Top & { readonly Type: { readonly length: number } }>(
    min: number,
    max: number,
  ) =>
  (self: S): S['Rebuild'] =>
    Schema.check<S>(Schema.isMinLength(min), Schema.isMaxLength(max))(self)

/** Stable identity for a blueprint object, chosen by the author and never shown to Discord. */
export const LogicalKey = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-z0-9][a-z0-9_-]{0,63}$/, { title: 'logical key' })),
).annotate({
  description:
    'Stable identity for this object across applies. Renaming the Discord object keeps the key, which is how a rename avoids creating a duplicate.',
  examples: ['moderators', 'general', 'announcements'],
})

/** Named permission flags. Raw bitfields never appear in a blueprint. */
const PermissionNameSchema = Schema.String.pipe(bounded(1, 64)).annotate({
  description: 'A Discord permission name such as "ManageRoles" or "SendMessages".',
})

export const PermissionOverwrite = Schema.Struct({
  /** A blueprint role key, a known Discord role or member ID, or `@everyone`. */
  target: Schema.Union([
    Schema.Struct({ type: Schema.Literal('roleKey'), key: LogicalKey }),
    Schema.Struct({ type: Schema.Literal('roleId'), id: Snowflake }),
    Schema.Struct({ type: Schema.Literal('memberId'), id: Snowflake }),
    Schema.Struct({ type: Schema.Literal('everyone') }),
  ]),
  allow: Schema.optionalKey(Schema.Array(PermissionNameSchema)),
  deny: Schema.optionalKey(Schema.Array(PermissionNameSchema)),
})
export type PermissionOverwrite = typeof PermissionOverwrite.Type

export const BlueprintRole = Schema.Struct({
  key: LogicalKey,
  name: Schema.String.pipe(bounded(1, 100)),
  color: Schema.optionalKey(
    Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 0xff_ff_ff }))),
  ),
  hoist: Schema.optionalKey(Schema.Boolean),
  mentionable: Schema.optionalKey(Schema.Boolean),
  permissions: Schema.optionalKey(Schema.Array(PermissionNameSchema)),
  /** Relative order among blueprint roles; absolute Discord positions are derived at apply time. */
  order: Schema.optionalKey(Schema.Int),
})
export type BlueprintRole = typeof BlueprintRole.Type

const channelCommon = {
  key: LogicalKey,
  name: Schema.String.pipe(bounded(1, 100)),
  /** Logical key of the parent category, if any. */
  parent: Schema.optionalKey(LogicalKey),
  order: Schema.optionalKey(Schema.Int),
  overwrites: Schema.optionalKey(Schema.Array(PermissionOverwrite)),
}

/**
 * A discriminated union per channel kind, so forum-only, voice-only, and category-only fields
 * cannot be mixed. Discord answers 400 for those combinations; making them unrepresentable is
 * better than explaining them.
 */
export const BlueprintChannel = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('category'),
    key: LogicalKey,
    name: Schema.String.pipe(bounded(1, 100)),
    order: Schema.optionalKey(Schema.Int),
    overwrites: Schema.optionalKey(Schema.Array(PermissionOverwrite)),
  }),
  Schema.Struct({
    kind: Schema.Literal('text'),
    ...channelCommon,
    topic: Schema.optionalKey(Schema.String.pipe(bounded(1, 1024))),
    nsfw: Schema.optionalKey(Schema.Boolean),
    rateLimitPerUser: Schema.optionalKey(
      Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 21_600 }))),
    ),
  }),
  Schema.Struct({
    kind: Schema.Literal('announcement'),
    ...channelCommon,
    topic: Schema.optionalKey(Schema.String.pipe(bounded(1, 1024))),
  }),
  Schema.Struct({
    kind: Schema.Literal('voice'),
    ...channelCommon,
    bitrate: Schema.optionalKey(Schema.Int),
    userLimit: Schema.optionalKey(
      Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 99 }))),
    ),
  }),
  Schema.Struct({
    kind: Schema.Literal('stage'),
    ...channelCommon,
    bitrate: Schema.optionalKey(Schema.Int),
  }),
  Schema.Struct({
    kind: Schema.Literal('forum'),
    ...channelCommon,
    topic: Schema.optionalKey(Schema.String.pipe(bounded(1, 1024))),
    tags: Schema.optionalKey(
      Schema.Array(
        Schema.Struct({
          name: Schema.String.pipe(bounded(1, 20)),
          moderated: Schema.optionalKey(Schema.Boolean),
        }),
      ).pipe(Schema.check(Schema.isMaxLength(20))),
    ),
    defaultSortOrder: Schema.optionalKey(Schema.Literals(['latestActivity', 'creationDate'])),
    defaultLayout: Schema.optionalKey(Schema.Literals(['list', 'gallery'])),
  }),
  Schema.Struct({
    kind: Schema.Literal('media'),
    ...channelCommon,
    topic: Schema.optionalKey(Schema.String.pipe(bounded(1, 1024))),
  }),
])
export type BlueprintChannel = typeof BlueprintChannel.Type

export const Blueprint = Schema.Struct({
  roles: Schema.optionalKey(Schema.Array(BlueprintRole)),
  channels: Schema.optionalKey(Schema.Array(BlueprintChannel)),
  /**
   * Objects this blueprint previously managed and now wants removed.
   *
   * Absent from `roles`/`channels` is *not* a deletion signal: an unmanaged resource must survive
   * every default apply, and a resource dropped from the blueprint by accident must not vanish.
   */
  absent: Schema.optionalKey(Schema.Array(LogicalKey)),
})
export type Blueprint = typeof Blueprint.Type

/** Persisted key → snowflake mapping. Without it a rename would look like a create. */
export type Bindings = ReadonlyMap<string, string>
