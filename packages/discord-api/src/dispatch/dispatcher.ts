import {
  type AuthMode,
  McpRequestContext,
  type RiskClass,
  ValidationError,
} from '@discord-mcp/core'
import type { OperationEntry } from '@mia-cx/discord-catalog'
import { OperationCatalog } from '@mia-cx/discord-catalog'
import { Context, Effect, Layer } from 'effect'
import { DiscordRest } from '../rest.ts'
import { hashArguments, PreviewTokens } from './preview.ts'
import {
  assertAuthProfileCanExecute,
  buildRoute,
  type DispatchArgs,
  validateAuditLogReason,
  validateBody,
  validatePathParams,
  validateQueryParams,
} from './validate.ts'

/**
 * Resolve a named auth profile to the mode it can execute under.
 *
 * `bot` is the built-in. Any other name is a Discord OAuth2 profile, which is what makes the five
 * bot-incompatible operations reachable at all. Resolution is injected rather than imported so
 * `discord-api` does not depend on `auth` — the dependency would run the wrong way.
 */
export interface AuthProfileResolver {
  readonly resolve: (
    name: string,
  ) => Effect.Effect<{ readonly name: string; readonly kind: AuthMode }, ValidationError>
}

export class AuthProfiles extends Context.Service<AuthProfiles, AuthProfileResolver>()(
  'discord-api/AuthProfiles',
) {
  /** Bot only. What a deployment without OAuth2 profiles configured gets. */
  static readonly botOnly = Layer.succeed(AuthProfiles)({
    resolve: (name) =>
      name === 'bot'
        ? Effect.succeed({ name, kind: 'bot' as const })
        : Effect.fail(
            new ValidationError({
              message: `Unknown auth profile "${name}".`,
              issues: [
                'authProfile: only "bot" is configured. Create a Discord OAuth2 profile with discord_oauth_profile_authorize, then pass its name here.',
              ],
            }),
          ),
  })
}

export const resolveAuthProfile = (name: string) =>
  Effect.flatMap(AuthProfiles, (profiles) => profiles.resolve(name))

/** IDs the call will affect, so a preview token binds to targets and not just to arguments. */
export const resolveTargets = (
  op: OperationEntry,
  path: Record<string, string>,
): ReadonlyArray<string> =>
  op.pathParams
    .filter((p) => p.endsWith('_id'))
    .map((p) => path[p])
    .filter((v): v is string => v !== undefined)
    .sort()

export interface DispatchOptions {
  /** The risk classes this dispatcher is allowed to execute. */
  readonly allowed: ReadonlyArray<RiskClass>
  /** When true, a valid preview token bound to this exact call is required. */
  readonly requirePreviewToken: boolean
}

/**
 * Resolve, validate, and execute a cataloged operation.
 *
 * Everything before `rest.request` is local. An operation that fails validation costs Discord
 * nothing and tells the caller precisely what to change.
 */
export const dispatch = (
  args: DispatchArgs & { previewToken?: string },
  options: DispatchOptions,
) =>
  Effect.gen(function* () {
    const catalog = yield* OperationCatalog
    const op = yield* catalog.get(args.operationId)

    // Risk separation is structural: a destructive operation is unreachable through the read tool
    // regardless of arguments, because this dispatcher never accepts its class.
    if (!options.allowed.includes(op.risk)) {
      return yield* Effect.fail(
        new ValidationError({
          message: `Operation "${op.operationId}" is classified ${op.risk} and cannot be run by this tool.`,
          issues: [
            op.risk === 'credential'
              ? 'operationId: credential operations are never exposed as tools. Use the dedicated OAuth, interaction, or secret-management flows.'
              : `operationId: use discord_api_${op.risk === 'bot_admin' ? 'admin' : op.risk} instead.`,
          ],
        }),
      )
    }

    const profile = yield* resolveAuthProfile(args.authProfile)
    yield* assertAuthProfileCanExecute(op, profile.kind)

    const path = yield* validatePathParams(op, args.path)
    const query = yield* validateQueryParams(op, args.query)
    yield* validateAuditLogReason(op, args.auditLogReason)

    const bodySchema = yield* catalog.bodySchema(op.operationId)
    yield* validateBody(op, args.body, bodySchema)

    if (options.requirePreviewToken) {
      // Optional, because a workflow handler dispatches with no MCP request behind it. Requiring
      // the service outright would put a per-request dependency in the signature of a call the
      // capability broker also makes.
      const request = yield* Effect.serviceOption(McpRequestContext)
      const tokens = yield* PreviewTokens

      if (request._tag === 'None') {
        return yield* Effect.fail(
          new ValidationError({
            message: `${op.operationId} is ${op.risk} and requires a preview, but this call has no principal to bind one to.`,
            issues: [
              'previewToken: a preview token is bound to the principal that requested it, so it can only be redeemed inside an MCP request.',
            ],
          }),
        )
      }
      const { principal } = request.value

      if (args.previewToken === undefined) {
        return yield* Effect.fail(
          new ValidationError({
            message: `${op.operationId} is ${op.risk} and requires a preview first.`,
            issues: [
              'previewToken: call discord_api_preview with these exact arguments, show the user what it reports, then pass the token it returns.',
            ],
          }),
        )
      }

      yield* tokens.redeem(args.previewToken, {
        principalId: principal.id,
        operationId: op.operationId,
        authProfile: profile.name,
        argumentHash: hashArguments({ path: args.path, query: args.query, body: args.body }),
        targets: resolveTargets(op, path),
      })
    }

    const rest = yield* DiscordRest
    const data = yield* rest.request({
      method: op.method,
      route: buildRoute(op, path),
      operationFamily: op.family,
      ...(query.size > 0 ? { query } : {}),
      ...(args.body === undefined ? {} : { body: args.body }),
      ...(args.auditLogReason === undefined ? {} : { auditLogReason: args.auditLogReason }),
    })

    return { operationId: op.operationId, authProfile: profile.name, data }
  })

/** What `discord_api_preview` reports: the exact call, its consequences, and a bound token. */
export const preview = (args: DispatchArgs) =>
  Effect.gen(function* () {
    const catalog = yield* OperationCatalog
    const op = yield* catalog.get(args.operationId)
    const { principal } = yield* McpRequestContext
    const tokens = yield* PreviewTokens

    const profile = yield* resolveAuthProfile(args.authProfile)
    yield* assertAuthProfileCanExecute(op, profile.kind)

    // The preview runs the same validation the execution will, so a token is never issued for a
    // call that would then fail on its arguments.
    const path = yield* validatePathParams(op, args.path)
    const query = yield* validateQueryParams(op, args.query)
    yield* validateAuditLogReason(op, args.auditLogReason)
    const bodySchema = yield* catalog.bodySchema(op.operationId)
    yield* validateBody(op, args.body, bodySchema)

    const targets = resolveTargets(op, path)
    const { token, expiresAt } = yield* tokens.issue({
      principalId: principal.id,
      operationId: op.operationId,
      authProfile: profile.name,
      argumentHash: hashArguments({ path: args.path, query: args.query, body: args.body }),
      targets,
    })

    return {
      operationId: op.operationId,
      method: op.method,
      resolvedPath: buildRoute(op, path),
      query: Object.fromEntries(query),
      risk: op.risk,
      targets,
      authProfile: profile.name,
      auditLogReason: args.auditLogReason ?? null,
      reversible: op.risk !== 'destructive',
      previewToken: token,
      expiresAt: new Date(expiresAt).toISOString(),
      warning:
        op.risk === 'destructive'
          ? 'This is destructive and Discord provides no undo. Show the user exactly what will be affected and get their agreement before executing.'
          : 'Confirm the resolved target with the user before executing.',
    }
  })
