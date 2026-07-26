import { defineTool, McpRequestContext } from '@discord-mcp/core'
import { Effect, Schema } from 'effect'
import { DiscordOAuth } from './discord-oauth.ts'

/**
 * Discord OAuth2 profile management.
 *
 * Every tool here reports profile *metadata* only. Token material never crosses the MCP boundary
 * in any direction — an agent names a profile and the server uses it.
 */

const ProfileName = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-z0-9][a-z0-9_-]{0,63}$/, { title: 'profile name' })),
)

const AuthorizeInput = Schema.Struct({
  name: ProfileName.annotate({
    description: 'A name you will pass as authProfile later, e.g. "release-manager".',
  }),
  scopes: Schema.Array(Schema.String)
    .pipe(Schema.check(Schema.isMinLength(1)))
    .annotate({
      description:
        'Discord OAuth2 scopes, e.g. ["identify","guilds.members.read"]. Request the least that works: the user sees this list on the consent screen.',
    }),
})

export const oauthProfileAuthorize = defineTool<typeof AuthorizeInput.Type, unknown, DiscordOAuth>({
  name: 'discord_oauth_profile_authorize',
  title: 'Start authorizing a Discord OAuth2 profile',
  description: [
    'Begin an authorization-code flow with PKCE and return a URL for the user to visit.',
    '',
    'A profile lets this server act on behalf of a Discord *user*, which is the only way to reach',
    'the five operations a bot token cannot — get_my_guild_member, the role-connection operations,',
    'and get_current_user_application_entitlements.',
    '',
    'Give the user the URL and wait; the profile does not exist until they approve it. The',
    'authorization expires in ten minutes. Requires oauth:manage.',
  ].join('\n'),
  toolset: 'admin',
  risk: 'write',
  scopes: ['oauth:manage'],
  annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
  input: AuthorizeInput,
  handler: (args) =>
    Effect.gen(function* () {
      const oauth = yield* DiscordOAuth
      const { principal } = yield* McpRequestContext

      const started = yield* oauth.authorize({
        profileName: args.name,
        scopes: args.scopes,
        principalId: principal.id,
      })

      return {
        profileName: args.name,
        authorizationUrl: started.url,
        expiresAt: new Date(started.expiresAt).toISOString(),
        instructions:
          'Give this URL to the user. Nothing is stored until they approve it, and the link stops working after ten minutes. Do not open it yourself — the flow binds to whoever authorizes.',
      }
    }),
})

const ListInput = Schema.Struct({})

export const oauthProfileList = defineTool<typeof ListInput.Type, unknown, DiscordOAuth>({
  name: 'discord_oauth_profile_list',
  title: 'List Discord OAuth2 profiles',
  description: [
    'List configured profiles with their scopes, owner, and expiry.',
    '',
    'Token material is never returned by this or any other tool.',
  ].join('\n'),
  toolset: 'admin',
  risk: 'read',
  scopes: ['oauth:manage'],
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: ListInput,
  handler: () =>
    Effect.gen(function* () {
      const oauth = yield* DiscordOAuth
      const profiles = yield* oauth.list()

      return {
        profiles: profiles.map((p) => ({
          name: p.name,
          scopes: p.scopes,
          owner: p.ownerPrincipalId,
          discordUserId: p.discordUserId,
          expiresAt: p.expiresAt === null ? null : new Date(p.expiresAt).toISOString(),
          revoked: p.revokedAt !== null,
          usable: p.revokedAt === null,
        })),
      }
    }),
})

const GetInput = Schema.Struct({ name: ProfileName })

export const oauthProfileGet = defineTool<typeof GetInput.Type, unknown, DiscordOAuth>({
  name: 'discord_oauth_profile_get',
  title: 'Describe one Discord OAuth2 profile',
  description: 'Metadata for one profile: scopes, owner, expiry, and whether it is usable.',
  toolset: 'admin',
  risk: 'read',
  scopes: ['oauth:manage'],
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: GetInput,
  handler: (args) =>
    Effect.gen(function* () {
      const oauth = yield* DiscordOAuth
      const profile = yield* oauth.get(args.name)

      return profile === undefined
        ? { found: false, name: args.name }
        : {
            found: true,
            name: profile.name,
            scopes: profile.scopes,
            owner: profile.ownerPrincipalId,
            discordUserId: profile.discordUserId,
            expiresAt:
              profile.expiresAt === null ? null : new Date(profile.expiresAt).toISOString(),
            usable: profile.revokedAt === null,
          }
    }),
})

const RevokeInput = Schema.Struct({ name: ProfileName })

export const oauthProfileRevoke = defineTool<typeof RevokeInput.Type, unknown, DiscordOAuth>({
  name: 'discord_oauth_profile_revoke',
  title: 'Revoke a Discord OAuth2 profile',
  description: [
    'Revoke a profile and delete its stored tokens.',
    '',
    'Irreversible: the user must authorize again to restore it. The stored access and refresh',
    'tokens are deleted rather than only flagged, so nothing remains that could be resurrected.',
  ].join('\n'),
  toolset: 'admin',
  risk: 'destructive',
  scopes: ['oauth:manage'],
  annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
  input: RevokeInput,
  handler: (args) =>
    Effect.gen(function* () {
      const oauth = yield* DiscordOAuth
      yield* oauth.revoke(args.name)
      return {
        name: args.name,
        revoked: true,
        note: 'Stored tokens were deleted. The user must authorize again to restore this profile.',
      }
    }),
})

export const oauthTools = [
  oauthProfileAuthorize,
  oauthProfileList,
  oauthProfileGet,
  oauthProfileRevoke,
]
