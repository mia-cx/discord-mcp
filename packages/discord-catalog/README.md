# @mia-cx/discord-catalog

Every Discord HTTP API operation, the permissions Discord requires for each one, and
a resolver for a member's effective permissions. Runs in Node and in Cloudflare
Workers without `nodejs_compat`.

```sh
pnpm add @mia-cx/discord-catalog effect
```

## Check a person's permissions

`requiredPermissions` returns what Discord checks before it performs an operation.
`computeEffectivePermissions` applies Discord's role and overwrite order to one member.

```ts
import {
  computeEffectivePermissions,
  explainMissing,
  requiredPermissions,
} from '@mia-cx/discord-catalog'

const rule = requiredPermissions('delete_guild_member')
// { requires: 'any-of', anyOf: [{ permissions: ['KickMembers'], scope: { level: 'guild', … } }],
//   hierarchy: [{ rule: 'member-below', target: 'user_id' }], sources: [...] }

const effective = computeEffectivePermissions({
  guildId,
  guildOwnerId: guild.owner_id,
  memberId: member.user.id,
  memberRoleIds: member.roles,
  roles: guild.roles,
  overwrites: channel.permission_overwrites, // omit for guild-scoped checks
})

if (!effective.permissions.includes('KickMembers')) {
  console.log(explainMissing(effective, 'KickMembers'))
}
```

`operationPermissions` is the whole table, keyed by operation ID. `namesToBits`,
`permissionNames`, `has`, and `canManageRole` cover bitfield arithmetic and role
hierarchy.

The table states which permissions each operation needs. It is not a complete
authorization engine: the caller still enforces timeouts, private-thread membership,
each grant's `only` and `when` conditions, and the `hierarchy` rules. The
`OperationPermissions` type documents how to evaluate each field.

## Look up and search operations

The catalog is an [Effect](https://effect.website) service.

```ts
import { OperationCatalog } from '@mia-cx/discord-catalog'
import { Effect } from 'effect'

const program = Effect.gen(function* () {
  const catalog = yield* OperationCatalog
  const op = yield* catalog.get('create_message') // fails with OperationNotFoundError
  const { hits } = catalog.search({ query: 'kick a member', limit: 5 })
  const body = yield* catalog.bodySchema('create_message') // JSON Schema with a scoped $defs
  return { op, hits, body }
})

await Effect.runPromise(program.pipe(Effect.provide(OperationCatalog.layer)))
```

The request-body schemas load on first use of `schemas` or `bodySchema`.

## Source

Operations and schemas are generated from
[discord/discord-api-spec](https://github.com/discord/discord-api-spec) at the commit in
`OperationCatalog.source`. Permission requirements are written by hand from Discord's
developer documentation; `permissionSources` records the revision last checked.

## License

[MCX License v1.0](./LICENSE). Discord's API specification retains its own license.
