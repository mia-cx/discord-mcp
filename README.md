# discord-mcp

A Discord HTTP API relay over MCP. Log in with Discord OAuth and supply your own
bot token. Every tool call acts as that bot under Discord's bot permissions.

## Connect

Target endpoint: `https://discord.mia.cx/mcp`. This README describes `main`.
The live instance still runs the earlier PAT-authenticated application until cutover.

Clients with MCP OAuth support discover the login flow automatically. Configure
the bot token as a separate header. For manually configured clients, run:

```sh
node scripts/login.mjs https://discord.mia.cx/mcp
```

The dependency-free helper opens your browser, completes login through a loopback
callback, and saves `~/.config/discord-mcp/login.json` with mode `0600`. It never
asks for or saves a bot token. Use `--no-open` to open the URL yourself,
`--output PATH` for another credential file, or `--replace` to sign in again.
`pnpm login` runs the same helper. It is not published to npm.

Supply both credentials on **every HTTP MCP request**, including discovery:

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

OAuth requests only `identify`. Any Discord human may sign in. Login does not
prove bot ownership or restrict a bot to that human's guild permissions.
Possession of a valid bot token grants that bot's existing authority.

No local accounts, PATs, stored OAuth profiles, database, Gateway connection,
background jobs, or stored bot credentials are required. The client holds an
encrypted, audience-bound relay credential enclosing its Discord login grant.
Authentication results and Discord responses are not cached. Responses use
`Cache-Control: no-store`. Revoking Discord authorization blocks the next request.

Login expires with the Discord grant, capped at seven days. Sign in again when
it expires. Refresh tokens are not issued: safe public-client refresh rotation
requires persistent replay protection. Only spent login-code hashes remain in
memory for one minute; run one server process. Restarting cancels unfinished
logins but preserves issued credentials.

The executable serves MCP revision `2026-07-28` without an initialization handshake
or sessions. Older MCP clients can use the SDK's stateless compatibility path.
Both paths require OAuth and bot credentials on every HTTP request.

## Tools

| Tool | Purpose |
| --- | --- |
| `discord_api_search` | Find bot-authenticated operations by words, method, or family. |
| `discord_api_describe` | Read an operation's parameters and request body schema. |
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
| `OAUTH_ENCRYPTION_KEY` | Required for HTTP. Stable random 32-byte base64 key for AES-256-GCM credentials. |
| `ALLOWED_HOSTS` | Comma-separated hostnames; required for non-loopback binds. |
| `ALLOWED_ORIGINS` | Optional additional browser origins. The request origin and configured public origin are accepted. |
| `DISCORD_MCP_REST_TIMEOUT_MS` | `15000`, applied to Discord requests. |
| `DISCORD_TOKEN` | Stdio only. Ignored by the HTTP relay. |

`/health/live` and `/health/ready` return HTTP 200 when the process is serving.
They do not check Discord. `/mcp` returns 401 for missing, invalid, expired, or
revoked OAuth credentials. Invalid bot credentials return 403 without triggering
another login. Discord authentication rate limits return 429.

OAuth discovery lives at `/.well-known/oauth-protected-resource/mcp` and
`/.well-known/oauth-authorization-server`. The issuer supports dynamic public-client
registration at `/register`, authorization at `/authorize`, and code exchange at
`/token`. Both OAuth legs require S256 PKCE. The issuer validates exact redirects,
resource, issuer, browser state, and one-time codes. Registrations expire after
30 days. Client ID metadata documents are not implemented.

For agent-operated clients, use the [curl example](./docs/operating.md#curl).

Public routing lives in `mia-cx/yggdrasil-spec`. Consult
[DIRECTION.md](./DIRECTION.md) for the live deployment and migration state.

## Development

```sh
corepack pnpm check        # Formatting, TypeScript build, and ordinary tests
corepack pnpm spec:check   # Catalog coverage, classification, and deterministic generation
```

Integration tests cover browser/CLI login, credential bindings, code replay,
OAuth revocation and expiry, concurrent bot isolation, reads, writes, and rate limits.

## Earlier implementation

The repository began on 25 July 2026. MCP removed protocol sessions and the
initialization handshake in its [28 July 2026 revision](https://modelcontextprotocol.io/specification/2026-07-28/changelog).
Stateless HTTP was already possible before that revision.

[PLAN.md](./PLAN.md) describes the earlier stateful control-plane design.
Its libraries and tests remain in the workspace, but the server executable no
longer starts that application. Workflows, persistent templates/blueprints,
PAT/OIDC administration, and the sandbox supervisor are outside the relay.
