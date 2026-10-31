# discord-mcp

A Discord HTTP API relay over MCP. Log in with Discord OAuth and supply your own
bot token. Every tool call acts as that bot under Discord's bot permissions.

## Connect

Ask your relay operator for its MCP URL and access. This repository does not
publish a hosted endpoint.

Follow [Agent setup and OAuth login](./docs/connecting.md) for Claude Code, Codex,
Devin, Cursor, and other stdio MCP clients. One browser login and private bot-token
file can serve all agents under the same OS account. The helpers need Node.js 24+
but no dependency installation. They are not published to npm.

### Authentication

Supply both credentials on **every HTTP MCP request**, including initialization and tool discovery:

```http
Authorization: Bearer YOUR_RELAY_OAUTH_ACCESS_TOKEN
X-Discord-Bot-Token: YOUR_DISCORD_BOT_TOKEN
```

Read `access_token` from the helper's credential file for the bearer header.
Do not append the bot token to it. The custom header has the same transport
protection as bearer auth over HTTPS. Redact both headers in clients and proxies.
Neither credential belongs in a URL, tool argument, or ordinary signed JWT.

The relay checks the OAuth grant with Discord's `GET /oauth2/@me` on every request.
It checks the bot with `GET /users/@me`, uses that token for the request,
and releases the request's client. Raw Discord OAuth tokens and user-account
tokens are not accepted as MCP bearer credentials.

OAuth requests only `identify`. Operators can restrict access with
`DISCORD_OAUTH_ALLOWED_USER_IDS`; unlisted accounts cannot finish login or use
previously issued credentials. Without that restriction, any Discord human may sign in.
Login does not prove bot ownership or restrict a bot to that human's guild permissions.
Possession of a valid bot token grants that bot's existing authority.

No local accounts, PATs, stored OAuth profiles, database, Gateway connection,
background jobs, or stored bot credentials are required. The client holds an
encrypted, audience-bound relay credential enclosing its Discord login grant.
Authentication results and Discord responses are not cached. Responses use
`Cache-Control: no-store`. Revoking Discord authorization blocks the next request.

Access credentials expire with the Discord grant, capped at seven days. The
token response also carries a `refresh_token`: an encrypted envelope around
Discord's refresh token, bound to the human and the client ID. Refreshing at
`/token` rotates both credentials and revokes the previous access credential.
Discord rejects a reused refresh token, which the relay reports as `invalid_grant`:
sign in again. Refresh works after the client's 30-day registration expires and
lapses after 30 days unused. The allowlist is checked at sign-in and on every
request, not at refresh, so a refresh never spends a rotated Discord token.

Refresh revokes every copy of the previous login, so each machine needs its own
sign-in. The stdio bridge refreshes a day before expiry and after a rejected
access credential, and bridges sharing one login file take turns through a lock.
Only spent login-code hashes remain in memory for one minute; run one server
process. Restarting cancels unfinished logins but preserves issued credentials.
The process also counts Discord's 401, 403, and 429 responses for ten minutes.
Cloudflare bans an IP after 10,000 of them, so the relay stops calling Discord
after 25 for one bot and operation family, or 1,000 in total.

The executable serves MCP revision `2026-07-28` without an initialization handshake
or sessions. Older MCP clients can use the SDK's stateless compatibility path.
Both paths require OAuth and bot credentials on every HTTP request.

## Tools

| Tool | Purpose |
| --- | --- |
| `discord_api_search` | Find bot-authenticated operations and their Discord permission requirements. |
| `discord_api_describe` | Read an operation's parameters, request body schema, and permission requirements. |
| `discord_api_read` | Execute read operations. |
| `discord_api_write` | Execute create/update operations. |
| `discord_api_destructive` | Execute deletes and other destructive operations. |
| `discord_api_admin` | Change bot/application settings and commands. |
| `discord_guild_get` | Read a guild with a compact, typed result. |
| `discord_permissions_explain` | Diagnose effective guild/channel permissions. |

The catalog covers the vendored specification's 242 operations. The relay exposes
bot-authenticated, non-credential operations. OAuth-only endpoints and operations
requiring separate credentials are unavailable. Use search and describe to find
the supported operation and its input schema.

Arguments are validated locally before execution. Destructive and admin calls act
directly under the supplied bot's Discord permissions; there are no server-side
grants or preview-token sessions. This relay does not receive voice audio or run
agent conversations.

Calls currently accept JSON payloads. Multipart file upload is not implemented.
Discord rate limits and API errors are returned to the caller; the HTTP relay
disables automatic retries and rate-limit waits.

## Permission metadata

Search and describe return each operation's `permissions`: the Discord permission
names it needs, whether Discord evaluates them for the guild or a channel, and the
path parameter or lookup that identifies it. Entries also record alternatives such
as message authorship, requirements that depend on the request, and role-hierarchy
rules. `none` means Discord requires no permission; `unknown` means Discord does not
document the route.

This relay reports the metadata but does not enforce it: Discord still checks every
call against the bot. A relay acting for a person can import the table with the
catalog and the effective-permission resolver, then re-check each call against that
person's permissions:

```ts
import { computeEffectivePermissions, requiredPermissions } from '@mia-cx/discord-catalog'
```

[`@mia-cx/discord-catalog`](./packages/discord-catalog) runs in Node and in Cloudflare
Workers without `nodejs_compat`; `pnpm package:verify` proves it from the packed
tarball. Read the evaluation rules
in [`required-permissions.ts`](./packages/discord-catalog/src/required-permissions.ts):
a consumer that skips a condition it cannot verify stays stricter than the rule.

The table and resolver are not a complete authorization engine for a person. The
consumer must also enforce timeouts, private-thread membership, and the `only` and
`when` conditions, and filter guild-wide responses, which return what the bot can
see. Rendering permissions such as `EmbedLinks` are not listed, so content renders
with the bot's permissions.

Discord's OpenAPI specification has no permission data, so the table is written by
hand from [Discord's developer documentation](https://docs.discord.com/developers).
Each entry cites its sources, and `permissionSources` records the documentation
commit last checked. `pnpm spec:check` fails until every cataloged operation has
a well-formed entry.

## Run from source

Requires Node.js 24+ and the pnpm version pinned in `package.json`.

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm build
corepack pnpm start
```

HTTP defaults to `127.0.0.1:3000`. It requires the OAuth settings below,
not a `DISCORD_TOKEN`: callers supply their own bot tokens.

For a local stdio client, supply its bot token in the child process environment:

```sh
MCP_TRANSPORT=stdio DISCORD_TOKEN=YOUR_DISCORD_BOT_TOKEN node apps/server/dist/bin.js
```

Local stdio does not require OAuth. It keeps the caller's token for the process
lifetime and uses the same tools, without a database or background processes.
Stdout is reserved for JSON-RPC; logs go to stderr.

## Deploy

Configure one Discord application for the hosted relay, not one per caller:

1. Create or reuse an application in the [Discord Developer Portal](https://discord.com/developers/applications).
2. Add `https://YOUR_HOST/auth/discord/callback` under OAuth2 redirects.
   Use `http://127.0.0.1:3000/auth/discord/callback` for local development.
3. Set `DISCORD_OAUTH_CLIENT_ID`, `DISCORD_OAUTH_CLIENT_SECRET`, and a stable
   `OAUTH_ENCRYPTION_KEY` generated with `openssl rand -base64 32`.

`docker/compose.yaml` runs one HTTP relay without data volumes or a supervisor.
Set these OAuth values, `PUBLIC_BASE_URL`, and `ALLOWED_HOSTS` using
[docker/.env.example](./docker/.env.example), then run Compose from `docker/`.
Keep the environment file private. Rotating the encryption key invalidates all logins.

| Setting | Default / purpose |
| --- | --- |
| `MCP_TRANSPORT` | `http`; also accepts `stdio`. |
| `MCP_HTTP_HOST` | `127.0.0.1` from source, `0.0.0.0` inside the image. |
| `MCP_HTTP_PORT` | `3000`. |
| `PUBLIC_BASE_URL` | Public HTTPS URL; required for non-loopback binds. |
| `DISCORD_OAUTH_CLIENT_ID` | Required for HTTP. The relay's Discord application ID. |
| `DISCORD_OAUTH_CLIENT_SECRET` | Required for HTTP. The application's OAuth client secret. |
| `DISCORD_OAUTH_ALLOWED_USER_IDS` | Optional comma-separated Discord user IDs. Unset or `*` allows any human; an empty value denies everyone. |
| `OAUTH_ENCRYPTION_KEY` | Required for HTTP. Stable random 32-byte base64 key for AES-256-GCM credentials. |
| `ALLOWED_HOSTS` | Comma-separated hostnames; required for non-loopback binds. |
| `ALLOWED_ORIGINS` | Optional additional browser origins. The request origin and configured public origin are accepted. |
| `DISCORD_MCP_REST_TIMEOUT_MS` | `15000`, applied to Discord requests. |
| `DISCORD_TOKEN` | Stdio only. Ignored by the HTTP relay. |

`/health/live` and `/health/ready` return HTTP 200 when the process is serving.
They do not check Discord. `/mcp` returns 401 for missing, invalid, expired, or
revoked OAuth credentials. An unlisted human receives 403 `access_denied`;
invalid bot credentials receive 403 `invalid_bot_token`. Neither triggers another login.
Discord authentication rate limits return 429.

OAuth discovery lives at `/.well-known/oauth-protected-resource/mcp` and
`/.well-known/oauth-authorization-server`. The issuer supports dynamic public-client
registration at `/register`, authorization at `/authorize`, and code and refresh
exchange at `/token`. Both OAuth legs require S256 PKCE. The issuer validates exact redirects,
resource, issuer, browser state, and one-time codes. Registrations expire after
30 days. Client ID metadata documents are not implemented.

For agent-operated clients, use the [curl example](./docs/operating.md#curl).
For a developer-Team-derived access list, follow
[the explicit membership sync procedure](./docs/operating.md#developer-team-allowlist).

Public routing lives in `mia-cx/yggdrasil-spec`. Consult
[DIRECTION.md](./DIRECTION.md) for the live deployment and migration state.

## Development

```sh
corepack pnpm check        # Formatting, TypeScript build, and ordinary tests
corepack pnpm spec:check   # Catalog coverage, classification, permissions, and determinism
```

Integration tests cover browser/CLI login, credential bindings, code and refresh replay,
concurrent bridge refreshes,
OAuth revocation and expiry, concurrent bot isolation, reads, writes, and rate limits.

## Earlier implementation

The repository began on 25 July 2026. MCP removed protocol sessions and the
initialization handshake in its [28 July 2026 revision](https://modelcontextprotocol.io/specification/2026-07-28/changelog).
Stateless HTTP was already possible before that revision.

[PLAN.md](./PLAN.md) describes the earlier stateful control-plane design.
Its libraries and tests remain in the workspace, but the server executable no
longer starts that application. Workflows, persistent templates/blueprints,
PAT/OIDC administration, and the sandbox supervisor are outside the relay.

## License

Copyright © 2026 Mia and the discord-mcp contributors.
Licensed under the [MCX License v1.0](./LICENSE).
Third-party code and specifications retain their original licenses.
