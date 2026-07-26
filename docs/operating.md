# Operating a Discord MCP control plane

This is the document to read before running this in a guild you care about. It covers setup, the
Discord configuration the server cannot do for you, authentication, backups, and what to do when
something goes wrong.

The only supported deployment is the Docker image set in `docker/`. There is no hosted or
serverless target, and the design assumes exactly one active control plane — see `GOAL.md`.

---

## 1. What you need before starting

A Discord application, from <https://discord.com/developers/applications>:

| Value | Where it is | Environment variable |
|---|---|---|
| Bot token | Bot → Reset Token | `DISCORD_TOKEN` |
| Application ID | General Information | `DISCORD_APPLICATION_ID` |
| Public key | General Information | `DISCORD_PUBLIC_KEY` |
| Client secret | OAuth2 → Client Secret | `DISCORD_CLIENT_SECRET` |

The bot token is shown once. If you lose it, reset it — and remember that resetting invalidates the
running server's token, so the Gateway will close with code 4004 until you update it.

Generate a master key with:

```sh
openssl rand -base64 32
```

**Back this up somewhere other than the host.** `DISCORD_MCP_MASTER_KEY` encrypts every stored
OAuth2 token and route secret. Losing it makes all of them permanently unrecoverable — there is no
recovery path, by design.

---

## 2. Discord permissions and intents

Two separate things, configured in two separate places, and both are easy to get wrong.

**Permissions** are per-guild and come from the invite URL. Grant the least that covers what you
intend to do; you can always re-invite with more. `discord_permissions_explain` computes exactly
what the bot has in a given channel and what a specific operation would need, which is faster than
reading the permission calculator.

**Intents** are per-application and set in the Developer Portal under Bot → Privileged Gateway
Intents. `DISCORD_MCP_GATEWAY_INTENTS` must list only intents you have actually enabled there —
Discord closes the connection with code **4014** for a privileged intent that is not enabled, and it
will not reconnect until you fix it. The three privileged intents are `GuildMembers`,
`MessageContent`, and `GuildPresences`.

The default (`Guilds,GuildMessages`) needs nothing privileged. If you want message text in workflow
triggers, you need `MessageContent`, which requires approval once your bot is in 100 guilds.

**Gateway mode.** `DISCORD_MCP_GATEWAY_MODE=lazy` (the default) opens no WebSocket until something
asks for events. REST-only operation therefore costs nothing. Use `eager` if you have workflows on
Gateway triggers that must not miss the first event after a restart.

---

## 3. Running it

Images are published to GHCR by CI on every version tag, for `linux/amd64` and `linux/arm64`:

| Image | What it is |
|---|---|
| `ghcr.io/mia-cx/discord-mcp/server` | The MCP control plane |
| `ghcr.io/mia-cx/discord-mcp/supervisor` | The sandbox supervisor |
| `ghcr.io/mia-cx/discord-mcp/workflow-runner` | Where a workflow's artifact runs |
| `ghcr.io/mia-cx/discord-mcp/workflow-build` | Where a workflow is built |

`latest` follows the newest version tag. `main` is the rolling build of the default branch — useful
for tracking development, not for anything you depend on. Pin `DISCORD_MCP_VERSION` to an exact
version for a deployment you want to stay put.

```sh
cd docker
cp .env.example .env   # then fill it in
docker compose up -d
```

To build locally instead, uncomment the `build:` blocks in `compose.yaml`.

The server binds to `127.0.0.1:3000` and is **not** safe to expose directly — it holds a bot token
and, on the HTTP transport, decides authorization from headers. Put a reverse proxy in front. The
server refuses to start in a configuration that is unsafe to expose: binding a non-loopback address
without `ALLOWED_HOSTS`, or enabling `TRUST_PROXY_IDENTITY` without `TRUSTED_PROXY_CIDRS`.

### Traefik

```yaml
labels:
  - traefik.enable=true
  - traefik.http.routers.discord-mcp.rule=Host(`bot.example.com`)
  - traefik.http.routers.discord-mcp.tls.certresolver=letsencrypt
  - traefik.http.services.discord-mcp.loadbalancer.server.port=3000
```

Then set on the server:

```sh
PUBLIC_BASE_URL=https://bot.example.com
ALLOWED_HOSTS=bot.example.com
TRUST_PROXY_IDENTITY=true
TRUSTED_PROXY_CIDRS=172.16.0.0/12   # the Docker network Traefik is on, not 0.0.0.0/0
```

`TRUSTED_PROXY_CIDRS` must be the proxy's actual address range. With `0.0.0.0/0` any client can
assert any identity by setting a header, which is worse than not trusting the proxy at all.

### Discord's interactions endpoint

Set it to `https://bot.example.com/discord/interactions` in the Developer Portal. Discord sends a
signed PING immediately and will not save the URL unless it verifies — so the server must be running
with `DISCORD_PUBLIC_KEY` set before you save.

---

## 4. Authentication

Three ways in, all producing the same principal and the same scope checks. The transport decides
*who*; it never decides *what they may do*.

**Stdio** runs as a local administrator principal, because the client is a process you started on
your own machine and it inherits your authority. No credential is involved.

**Personal access tokens** are the simplest remote path:

```sh
docker compose exec server node /app/apps/cli/dist/bin.js \
  principal create alice "Alice" mcp:read mcp:write
docker compose exec server node /app/apps/cli/dist/bin.js \
  auth token create alice "laptop" 90
```

The token is shown once. Revoking takes effect immediately, with no restart.

**External OIDC** requires all three of `OIDC_ISSUER`, `OIDC_AUDIENCE`, and `OIDC_JWKS_URI`. A
partial configuration is refused at startup rather than validating tokens against defaults nobody
chose. Note that a token can never widen a principal: scopes are intersected with what the principal
actually holds, so an identity provider you do not control cannot grant `mcp:destructive`.

### Toolsets

`DISCORD_MCP_TOOLSETS` defaults to `operator,automation,api`. The `admin` toolset — blueprint apply,
workflow granting, OAuth profile management — is opt-in, and should stay off unless you want an
agent able to reshape a guild.

---

## 5. Workflows

Off by default. Enabling them means running arbitrary code that an agent wrote:

```sh
DISCORD_MCP_WORKFLOWS_ENABLED=true
DISCORD_MCP_SUPERVISOR_CREDENTIAL=$(openssl rand -base64 32)   # same value on both services
DOCKER_HOST=unix:///run/user/1000/docker.sock                  # rootless
```

**Rootless Docker is assumed.** Under rootful Docker a container escape is a host root escape, and
none of the sandbox's restrictions compensate for that. If you are not running rootless, leave
workflows off.

The lifecycle is five deliberate steps:

1. `workflow_create` / `workflow_update_draft` — inert; grants nothing, runs nothing.
2. `workflow_validate` — builds in a sandbox with no credentials and returns the manifest.
3. `workflow_publish` — pins the artifact digest.
4. `workflow_grant` — decides capability. Needs `workflow:admin`.
5. `workflow_enable` — turns it on and registers its routes.

Read the manifest from `workflow_get` before granting. It states which triggers, routes, and
commands the code declares; the grant is what it is actually permitted to reach. **An empty target
list grants nothing, not everything** — an omitted `guildIds` reaches no guilds.

---

## 6. Backups

Two things, and losing either is unrecoverable in different ways.

**The master key.** Losing it makes every stored OAuth2 token and route secret unreadable. Keep it
in a password manager, not on the host.

**The database** (`/data/discord-mcp.sqlite` in the container). It holds principals, tokens, OAuth2
profiles, component bindings, templates, blueprints, and workflow revisions.

```sh
docker compose exec server sqlite3 /data/discord-mcp.sqlite \
  ".backup '/data/backup.sqlite'"
docker compose cp server:/data/backup.sqlite ./backup-$(date +%F).sqlite
```

Use `.backup` rather than copying the file: SQLite in WAL mode has state outside the main file, and
a plain copy of a live database can be inconsistent.

---

## 7. When something goes wrong

**Gateway closes with 4014.** A privileged intent in `DISCORD_MCP_GATEWAY_INTENTS` is not enabled in
the Developer Portal. The error names the exact portal page. It will not reconnect until fixed.

**Gateway closes with 4004.** The bot token is invalid or was reset.

**Everything returns 429, then stops working entirely.** Discord's API is behind Cloudflare, which
bans a source IP after 10,000 401/403/429 responses in ten minutes. The server's own `RateGuard`
trips at 25 rejections in ten minutes — three orders of magnitude earlier — specifically so you hit
that circuit breaker instead of the ban. If `RateGuardTrippedError` appears, something is in a retry
loop; diagnose it before restarting, because a restart resets the counter but not the cause.

**A tool says a permission is missing.** Call `discord_permissions_explain` with the guild, channel,
and operation. It computes the effective permission through every overwrite stage and names what is
missing. Re-inviting the bot with more permissions does not change existing channel overwrites.

**A workflow is misbehaving.** `workflow_disable` stops it immediately — including calls already in
flight, not just new dispatch. Handlers drain to their deadline and can do nothing further.

**The sandbox supervisor is unreachable.** Workflow tools fail with a `SandboxError` whose phase is
`engine` or `protocol`. Check the supervisor is running, that `DOCKER_HOST` points at a rootless
daemon it can reach, and that `DISCORD_MCP_SUPERVISOR_CREDENTIAL` matches on both services.

**A destructive tool refuses without a preview token.** That is deliberate. Call
`discord_api_preview` with the same arguments, show the user what it reports, then pass the token it
returns. Tokens last 60 seconds, are single-use, and are bound to the exact arguments — so the call
that executes is the one that was described.

---

## 8. Upgrading

Migrations are append-only and run automatically at startup, inside a transaction with their
`schema_migrations` row. Back up first anyway.

```sh
docker compose pull && docker compose up -d
```

There is no downgrade path. Restore the backup instead.
