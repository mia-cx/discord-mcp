# discord-mcp

A stateless Discord HTTP API relay over MCP. Connect with a Discord bot token;
every tool call acts as that bot. Discord's permissions determine what it can do.

## Connect

Endpoint: `https://discord.mia.cx/mcp`

Supply the raw bot token as an HTTP bearer credential on **every request**:

```http
Authorization: Bearer YOUR_DISCORD_BOT_TOKEN
```

The relay checks the token with Discord's `GET /users/@me` on each request,
including discovery. User tokens are rejected. It uses the same token for that
request's Discord calls, then releases the request's client.

No accounts, PATs, OAuth profiles, database, Gateway connection, background jobs,
or stored bot credentials are required. Credentials, authentication results, and
Discord responses are not cached. HTTP responses use `Cache-Control: no-store`.

The executable serves MCP revision `2026-07-28` without an initialization handshake
or sessions. Older MCP clients can use the SDK's stateless compatibility path.
Both paths require the bot token on every HTTP request.

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

HTTP defaults to `127.0.0.1:3000`. It needs no `DISCORD_TOKEN` environment
variable: callers supply their own tokens.

For a local stdio client, supply its bot token in the child process environment:

```sh
MCP_TRANSPORT=stdio DISCORD_TOKEN=YOUR_DISCORD_BOT_TOKEN node apps/server/dist/bin.js
```

Stdio keeps that local caller's token for the process lifetime. It uses the same
tools, with no database or background processes. Stdout is reserved for JSON-RPC;
logs go to stderr.

## Deploy

`docker/compose.yaml` runs a single HTTP relay, without data volumes, credentials,
or a sandbox supervisor. Set `PUBLIC_BASE_URL` and `ALLOWED_HOSTS` using
[docker/.env.example](./docker/.env.example), then run Compose from `docker/`.

| Setting | Default / purpose |
| --- | --- |
| `MCP_TRANSPORT` | `http`; also accepts `stdio`. |
| `MCP_HTTP_HOST` | `127.0.0.1` from source, `0.0.0.0` inside the image. |
| `MCP_HTTP_PORT` | `3000`. |
| `PUBLIC_BASE_URL` | Public HTTPS URL; required for non-loopback binds. |
| `ALLOWED_HOSTS` | Comma-separated hostnames; required for non-loopback binds. |
| `ALLOWED_ORIGINS` | Optional additional browser origins. The request origin and configured public origin are accepted. |
| `DISCORD_MCP_REST_TIMEOUT_MS` | `15000`, applied to Discord requests. |
| `DISCORD_TOKEN` | Stdio only. Ignored by the HTTP relay. |

`/health/live` and `/health/ready` return HTTP 200 when the process is serving.
They do not check any bot credential. `/mcp` returns 401 for missing, invalid,
or non-bot credentials; Discord authentication rate limits return 429.

Public routing lives in `mia-cx/yggdrasil-spec`. Consult
[DIRECTION.md](./DIRECTION.md) for the live deployment and migration state.

## Development

```sh
corepack pnpm check        # Formatting, TypeScript build, and ordinary tests
corepack pnpm spec:check   # Catalog coverage, classification, and deterministic generation
```

The relay integration tests cover concurrent bot isolation, per-request
validation and token revocation, reads and writes, and upstream rate limits.

## Earlier implementation

The repository began on 25 July 2026. MCP removed protocol sessions and the
initialization handshake in its [28 July 2026 revision](https://modelcontextprotocol.io/specification/2026-07-28/changelog).
Stateless HTTP was already possible before that revision.

[PLAN.md](./PLAN.md) describes the earlier stateful control-plane design.
Its libraries and tests remain in the workspace, but the server executable no
longer starts that application. Workflows, persistent templates/blueprints,
PAT/OIDC administration, and the sandbox supervisor are outside the relay.
