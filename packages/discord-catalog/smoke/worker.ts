/**
 * A Cloudflare Worker that exercises every public entry point of the packed package.
 *
 * `scripts/verify-package.ts` installs the tarball beside it, bundles it with Wrangler with
 * `nodejs_compat` off, and runs it in workerd. A Node builtin anywhere in the import graph fails
 * the bundle; anything else fails one of `run.mjs`'s assertions.
 */
import {
  AuthMode,
  canManageRole,
  computeEffectivePermissions,
  explainMissing,
  has,
  namesToBits,
  OperationCatalog,
  OperationNotFoundError,
  operationPermissions,
  type PermissionName,
  RiskClass,
  requiredPermissions,
} from '@mia-cx/discord-catalog'
import { Effect, Schema } from 'effect'

const GUILD = '100000000000000000'
const MEMBER = '200000000000000000'
const MODS = '300000000000000000'

const sendMessages: PermissionName = 'SendMessages'
const everyone = {
  id: GUILD,
  name: '@everyone',
  permissions: namesToBits(['ViewChannel', sendMessages]).toString(),
  position: 0,
}
const mods = {
  id: MODS,
  name: 'Mods',
  permissions: namesToBits(['ManageMessages']).toString(),
  position: 2,
}

const permissions = computeEffectivePermissions({
  guildId: GUILD,
  guildOwnerId: '999999999999999999',
  memberId: MEMBER,
  memberRoleIds: [MODS],
  roles: [everyone, mods],
  overwrites: [{ id: GUILD, type: 0, allow: '0', deny: namesToBits([sendMessages]).toString() }],
})

const catalogFacts = Effect.gen(function* () {
  const catalog = yield* OperationCatalog
  const createMessage = yield* catalog.get('create_message')
  const body = yield* catalog.bodySchema('create_message')
  const defs = Object.keys(body?.$defs ?? {})
  const refs = [...JSON.stringify(body).matchAll(/"#\/\$defs\/([^"]+)"/g)].map((m) => m[1])
  const missing = yield* Effect.flip(catalog.get('get_the_thing'))
  const { details } = yield* catalog.schemas

  return {
    operations: catalog.all.length,
    createMessage: `${createMessage.method} ${createMessage.path}`,
    kick: catalog
      .search({ query: 'kick a member from the server', limit: 5 })
      .hits.map((h) => h.operation.operationId),
    bodyRef: body?.$ref,
    bodyDefs: defs.length,
    bodyRefsResolve: refs.every((ref) => ref !== undefined && defs.includes(ref)),
    hasDetails: Object.hasOwn(details, 'create_interaction_response'),
    missing: missing instanceof OperationNotFoundError ? missing._tag : 'wrong error',
    apiVersion: catalog.source.apiVersion,
  }
}).pipe(Effect.provide(OperationCatalog.layer))

export default {
  async fetch(): Promise<Response> {
    return Response.json({
      ...(await Effect.runPromise(catalogFacts)),
      canSend: has(BigInt(permissions.bits), sendMessages),
      canManageMessages: has(BigInt(permissions.bits), 'ManageMessages'),
      whyNotSend: explainMissing(permissions, sendMessages),
      canManageEveryone: canManageRole(5, everyone, GUILD).allowed,
      canManageMods: canManageRole(5, mods, GUILD).allowed,
      kickRequires: requiredPermissions('delete_guild_member'),
      permissionEntries: Object.keys(operationPermissions).length,
      authMode: Schema.decodeUnknownSync(AuthMode)('bot'),
      riskClass: Schema.decodeUnknownSync(RiskClass)('destructive'),
    })
  },
}
