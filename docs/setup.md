# Setup

This guide takes a new installation from a Discord application to a working local or Compose
deployment. Use a disposable guild for initial validation.

## 1. Create the Discord application

In the Discord Developer Portal:

1. Create an application.
2. Open **Bot**, create the bot user, and copy its token.
3. Keep the default `Guilds` Gateway intent for the first start.
4. Under **OAuth2 → URL Generator**, select `bot` and `applications.commands`.
5. Select only the guild permissions needed by the features you plan to use.
6. Install the application into the test guild.

Set:

```dotenv
DISCORD_TOKEN=the-bot-token
```

The token is mandatory. Never put it in workflow source, an MCP argument, a committed `.env`, or a
support log.

For Discord interactions, copy the application public key:

```dotenv
DISCORD_PUBLIC_KEY=hex-encoded-ed25519-public-key
```

After the HTTP deployment is reachable, set the Developer Portal interactions URL to:

```text
https://your-host.example/discord/interactions
```

`DISCORD_APPLICATION_ID` is optional. When absent, the server derives and caches it from Discord
before OAuth or application-command operations need it.

See [Discord permissions and intents](discord-permissions.md) before enabling privileged intents or
granting broad guild permissions.

## 2. Install source dependencies

Source development and local stdio require Node.js 24:

```sh
node --version
corepack enable
corepack pnpm install --frozen-lockfile
```

Verify the fast local gates:

```sh
corepack pnpm check
corepack pnpm typecheck
corepack pnpm test
```

## 3. Choose a transport

### Trusted local stdio

Stdio is the smallest useful installation:

```sh
mkdir -p data
DISCORD_TOKEN=... \
DATABASE_PATH="$PWD/data/discord-mcp.sqlite" \
MCP_TRANSPORT=stdio \
corepack pnpm dev
```

Configure the MCP client to start the same command and environment. The client is treated as the
built-in local administrator. Stdout contains only JSON-RPC; logs and diagnostics use stderr.

Stdio supports the persistent control-plane features. Sandboxed workflow builds and execution also
require the supervisor, its Unix socket, and its service credential.

### Authenticated HTTP

HTTP exposes:

- `/mcp` — Streamable HTTP MCP;
- `/health/live` and `/health/ready` — minimal health checks;
- `/metrics` — Prometheus text, protected by `audit:read`;
- `/discord/interactions` — Discord interaction callbacks when a public key is configured;
- `/oauth/discord/callback` — Discord OAuth profile callback;
- `/blobs` and `/blobs/{id}/metadata` — authenticated remote blob upload and metadata;
- `/workflows/{slug}/...` — registered workflow routes;
- `/.well-known/oauth-protected-resource/mcp` — MCP resource-server metadata.

For loopback development:

```sh
DISCORD_TOKEN=... \
MCP_TRANSPORT=http \
MCP_HTTP_HOST=127.0.0.1 \
MCP_HTTP_PORT=3000 \
corepack pnpm dev
```

Create a scoped principal and PAT:

```sh
corepack pnpm cli -- principal create local-client mcp:read,mcp:write
corepack pnpm cli -- auth token create PRINCIPAL_ID local-development
```

The PAT is displayed once. Use it as a Bearer token for `/mcp`.

## 4. Prepare encryption and supervisor credentials

Generate the 32-byte base64 encryption key:

```sh
openssl rand -base64 32
```

Set the result as `DISCORD_MCP_MASTER_KEY`. It encrypts Discord OAuth tokens and named secrets and
also gives blueprint preview tokens a stable key across restarts. Store it separately from the
database backup.

Generate a different supervisor service credential:

```sh
openssl rand -hex 32
```

Set it as `DISCORD_MCP_SUPERVISOR_CREDENTIAL` in both the server and supervisor environments. This is
not a workflow credential and must never enter a runner.

## 5. Prepare rootless Docker

Install rootless Docker for the account that owns the deployment and confirm:

```sh
docker context use rootless
docker info --format '{{json .SecurityOptions}}'
docker info --format '{{.CgroupVersion}} {{.MemoryLimit}} {{.PidsLimit}}'
```

The supervisor requires rootless mode, cgroup v2, memory limits, and PID limits. It refuses startup
when the daemon cannot enforce them. `DISCORD_MCP_ALLOW_ROOTFUL_DOCKER=true` bypasses only the
rootless check and is intended for isolated development; it does not bypass the cgroup checks.

Find the socket and its group:

```sh
docker context inspect rootless
stat -c '%g %n' /run/user/$(id -u)/docker.sock
```

Set `ROOTLESS_DOCKER_SOCKET` and `ROOTLESS_DOCKER_GID` in `.env`.

## 6. Start Compose

```sh
cp .env.example .env
mkdir -p data run
sudo chown -R 65532:65532 data run
docker compose --profile images build
docker compose config
docker compose up -d server supervisor
```

The absolute path of `data` and `run` matters. The supervisor passes bind mounts to the host daemon,
so Compose mounts both directories at their container paths and at the same absolute host paths.
Do not move or replace them with symlinks while runners exist.

Check startup:

```sh
docker compose ps
docker compose logs server supervisor
curl --fail http://127.0.0.1:3000/health/ready
```

The default host publication is loopback-only. Configure TLS and the public HTTP safety settings
before exposing it elsewhere; see [Deployment](deployment.md).

## 7. Create the first operator

Choose the least set of scopes the client needs:

```sh
corepack pnpm cli -- principal create operator \
  mcp:read,mcp:write,template:read,template:write,server:plan,workflow:read,workflow:write
corepack pnpm cli -- auth token create PRINCIPAL_ID operator-client
```

Add `server:apply`, `workflow:admin`, `oauth:manage`, `audit:read`, `mcp:destructive`, or
`bot:admin` only to dedicated administrative principals.

## 8. Validate the installation

Through the MCP client:

1. list tools;
2. call `discord_guild_list`;
3. call `discord_guild_inspect` for the disposable guild;
4. call `discord_gateway_status`;
5. send a harmless test message through `discord_message_send`;
6. inspect `/metrics` or `discord_metrics_snapshot` from an `audit:read` principal.

If a Discord operation returns 403, stop retrying and call `discord_permissions_explain`.

For a production acceptance run, follow [Live acceptance](live-acceptance.md).

## Next steps

- [Configuration reference](configuration.md)
- [Authentication and authorization](authentication.md)
- [MCP tool guide](tool-guide.md)
- [Workflow lifecycle](workflows.md)
- [Backups](backups.md)
