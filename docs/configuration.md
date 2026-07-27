# Configuration reference

Configuration is read from environment variables. Compose loads `.env` and supplies container paths
for the server and supervisor. Values shown as “required” may be required only for the corresponding
feature.

## Core server

| Variable | Default | Purpose |
| --- | --- | --- |
| `DISCORD_TOKEN` | none | Required Discord bot token. Startup fails when empty. |
| `MCP_TRANSPORT` | `stdio` | `stdio` or `http`. Compose forces `http`. |
| `DATABASE_PATH` | `data/discord-mcp.sqlite` | SQLite path. `DISCORD_MCP_DATABASE` is a compatibility fallback. |
| `DISCORD_MCP_BLOB_DIR` | `data/blobs` | Directory for content-addressed blob bytes. |
| `DISCORD_MCP_ARTIFACT_DIR` | `data/artifacts` | Workflow artifact root visible to server and supervisor. |
| `DISCORD_MCP_MAX_RESPONSE_BYTES` | `25000` | Maximum inline MCP result size before returning a preview and pagination/resource continuation guidance. |
| `DISCORD_MCP_BLOB_QUOTA_BYTES` | `262144000` | Blob quota for each principal. |
| `DISCORD_MCP_MAX_BLOB_BYTES` | `26214400` | HTTP and CLI maximum accepted blob size; the server store enforces a 25 MiB object limit. |
| `DISCORD_MCP_TOOLSETS` | `operator,automation,api` | Comma-separated discovery surface: `operator`, `automation`, `admin`, `api`. |

Unknown toolset names fail startup. Enabling a toolset does not grant authority; the request
principal still needs the tool's local scope.

## HTTP listener and public URL

| Variable | Default | Purpose |
| --- | --- | --- |
| `MCP_HTTP_HOST` | `127.0.0.1` | Bind address. Compose uses `0.0.0.0` inside the container. |
| `MCP_HTTP_PORT` | `3000` | Listener port. |
| `PUBLIC_BASE_URL` | none | Public HTTPS origin, with no path, credentials, query, or fragment. |
| `ALLOWED_HOSTS` | empty | Comma-separated exact hostnames accepted from `Host` and forwarded-host checks. |
| `TRUSTED_PROXY_CIDRS` | empty | Comma-separated CIDRs allowed to supply forwarding or proxy identity headers. |
| `TRUST_PROXY_IDENTITY` | `false` | Enable trusted-proxy identity authentication. |
| `TRUST_PROXY_IDENTITY_HEADER` | `x-forwarded-user` | Lowercase header containing the mapped external identity. |
| `TRUST_PROXY_GROUPS_HEADER` | `x-forwarded-groups` | Lowercase header that must be present with proxy identity. |

A non-loopback bind requires:

- `PUBLIC_BASE_URL` using HTTPS;
- non-empty `ALLOWED_HOSTS`;
- the public URL hostname in `ALLOWED_HOSTS`.

Enabling proxy identity additionally requires `TRUSTED_PROXY_CIDRS`. Forwarding headers received
from any other peer are rejected. CORS and allowed origins on workflow routes are browser controls,
not authentication.

Compose host publication uses:

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST_BIND_ADDRESS` | `127.0.0.1` | Host address published by Compose. |
| `HOST_PORT` | `3000` | Host port published by Compose. |
| `DISCORD_MCP_HOST` | none | Hostname used by the included Traefik labels. |

## MCP authentication

Personal access tokens are stored in SQLite and need no environment configuration.

External OIDC is enabled only when all three values exist:

| Variable | Purpose |
| --- | --- |
| `OIDC_ISSUER` | Exact token issuer. |
| `OIDC_AUDIENCE` | Required audience for MCP access tokens. |
| `OIDC_JWKS_URI` | HTTPS JWK set used to validate token signatures. |

The server validates signature, issuer, audience, subject, expiry, and known scopes. It does not host
login, account, consent, or token endpoints.

## Encryption and Discord OAuth

| Variable | Required for | Purpose |
| --- | --- | --- |
| `DISCORD_MCP_MASTER_KEY` | OAuth profiles and named secrets | Exactly 32 random bytes encoded as base64; used by AES-256-GCM encryption. |
| `DISCORD_CLIENT_SECRET` | Discord OAuth profiles | Application client secret. |
| `PUBLIC_BASE_URL` | Discord OAuth profiles | Builds `/oauth/discord/callback`. |
| `DISCORD_APPLICATION_ID` | optional | Application snowflake; otherwise derived from Discord. |
| `DISCORD_MCP_PREVIEW_SECRET` | optional | Stable blueprint-preview key when no master key is configured. |

Discord OAuth profile support starts only when client secret, master key, and public base URL are all
configured. If neither master key nor preview secret exists, blueprint preview tokens use a
process-random key and therefore do not survive restart.

## Discord REST behavior

| Variable | Default | Purpose |
| --- | --- | --- |
| `DISCORD_MCP_REST_TIMEOUT_MS` | `15000` | Per-request deadline. |
| `DISCORD_MCP_REST_RETRIES` | `2` | Retry count for eligible transient failures. |
| `DISCORD_MCP_REST_GLOBAL_RPS` | `50` | Global outbound request budget. |
| `DISCORD_MCP_REST_MAX_RATELIMIT_WAIT_MS` | `30000` | Longest Discord rate-limit wait accepted by the transport. |
| `DISCORD_MCP_REST_DENY_THRESHOLD` | `25` | Invalid-response threshold per credential and operation family before RateGuard trips. |

Retries respect method and operation safety. RateGuard exists to stop credential, permission, or
schema failure storms before Discord applies an IP-level restriction. Diagnose the cause instead of
raising the threshold reflexively.

## Gateway and interactions

| Variable | Default | Purpose |
| --- | --- | --- |
| `DISCORD_MCP_GATEWAY_MODE` | `lazy` | `off`, `lazy`, or `eager`. |
| `DISCORD_MCP_GATEWAY_INTENTS` | `Guilds` | Comma-separated `GatewayIntentBits` names. |
| `DISCORD_MCP_GATEWAY_BUFFER_SIZE` | `10000` | Maximum durable recent-event buffer. |
| `DISCORD_MCP_GATEWAY_MAX_WAIT_MS` | `120000` | Maximum bounded Gateway wait. |
| `DISCORD_PUBLIC_KEY` | none | Enables and verifies `/discord/interactions`. |
| `DISCORD_MCP_DEVELOPMENT_GUILDS` | empty | Comma-separated guild IDs used for development command publication behavior. |

Privileged intents must also be enabled in the Discord Developer Portal. See
[Gateway and interactions](gateway-interactions.md).

## Workflow server-to-supervisor wiring

| Variable | Default | Purpose |
| --- | --- | --- |
| `DISCORD_MCP_SUPERVISOR_CREDENTIAL` | none | Shared server/supervisor service credential, at least 32 characters. Without it, workflow builds and runtime are unavailable. |
| `SUPERVISOR_SOCKET` | `/run/discord-mcp/supervisor.sock` | Server-side supervisor Unix socket. |
| `DISCORD_MCP_CAPABILITY_SOCKET` | `/run/discord-mcp/capability.sock` | Server broker socket mounted into runners. |
| `DISCORD_MCP_RUNNER_SOCKET_ROOT` | `/run/discord-mcp/runners` | Server-visible runner socket root. |

## Sandbox supervisor

| Variable | Default | Purpose |
| --- | --- | --- |
| `DISCORD_MCP_SUPERVISOR_CREDENTIAL` | none | Required service credential. |
| `DISCORD_MCP_SUPERVISOR_SOCKET` | `/run/discord-mcp/supervisor.sock` | Socket the supervisor listens on. |
| `DISCORD_MCP_ARTIFACT_DIR` | `/var/lib/discord-mcp/artifacts` | Daemon-visible artifact root. Compose supplies an absolute host path. |
| `DISCORD_MCP_BUILDER_IMAGE` | `discord-mcp/workflow-builder:local` | Exact builder image. Prefer an immutable release tag or digest. |
| `DISCORD_MCP_RUNNER_IMAGE` | `discord-mcp/workflow-runner:local` | Exact runner image. Prefer an immutable release tag or digest. |
| `DISCORD_MCP_CAPABILITY_SOCKET` | `/run/discord-mcp/capability.sock` | Host-visible broker socket source. |
| `DISCORD_MCP_RUNNER_SOCKET_ROOT` | `/run/discord-mcp/runners` | Supervisor-visible private runner directories. |
| `DISCORD_MCP_RUNNER_SOCKET_HOST_ROOT` | same as runner root | Path supplied to the host Docker daemon for runner mounts. |
| `DISCORD_MCP_RUNTIME_GID` | `65532` | Group used for shared runtime sockets. |
| `DISCORD_MCP_ALLOW_ROOTFUL_DOCKER` | `false` | Development-only override for the rootless-daemon check. |

Compose additionally uses:

| Variable | Purpose |
| --- | --- |
| `ROOTLESS_DOCKER_SOCKET` | Host rootless Docker socket mounted only into the supervisor. |
| `ROOTLESS_DOCKER_GID` | Group ID allowed to access that socket. |

The builder and runner receive internal variables derived by trusted code. Do not configure their
internal socket, module, or install-script variables on the control-plane server.

## Live test suite

| Variable | Purpose |
| --- | --- |
| `DISCORD_MCP_E2E` | Must be `true` to enable live tests. |
| `DISCORD_MCP_TEST_GUILD_ID` | Disposable guild target. |
| `DISCORD_MCP_TEST_CHANNEL_ID` | Disposable channel target. |
| `DISCORD_MCP_TEST_MEMBER_ID` | Optional destructive moderation target. |
| `DISCORD_MCP_TEST_FORBIDDEN_CHANNEL_ID` | Optional real 403 target. |
| `DISCORD_MCP_TEST_OAUTH_TOKEN` | Optional user bearer for `/users/@me`; never logged. |

Do not set live-test variables in ordinary CI or against a production guild.
