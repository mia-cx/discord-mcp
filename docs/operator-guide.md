# Operator guide

## Discord application setup

Create a bot application in the Discord Developer Portal. Store its bot token only as
`DISCORD_TOKEN`; never put it in workflow source or an MCP argument. Set `DISCORD_PUBLIC_KEY` to
enable `/discord/interactions`. `DISCORD_APPLICATION_ID` is optional—the server derives and caches it
from `/applications/@me` when OAuth or command publication first needs it.

Invite the bot with the `bot` and `applications.commands` scopes. Grant only the guild permissions
your automation uses. Typical server setup needs View Channels, Manage Channels, Manage Roles, and
View Audit Log; message automation needs Send Messages, Embed Links, Attach Files, Read Message
History, Manage Messages, and Create Public/Private Threads as appropriate. Role reconciliation
cannot manage a role at or above the bot's highest role and cannot grant permissions the bot lacks.
`discord_permissions_explain` gives a local, ordered explanation after a 403.

Gateway intents are a comma-separated list of `GatewayIntentBits` names in
`DISCORD_MCP_GATEWAY_INTENTS`. `Guilds` is the safe baseline. Enable the corresponding privileged
switch in the Developer Portal before adding `GuildMembers`, `GuildPresences`, or `MessageContent`.
MESSAGE_CONTENT also affects message fields returned by REST; the curated message-list tool reports
the likely redaction signature.

## Local stdio

```sh
MCP_TRANSPORT=stdio DISCORD_TOKEN=... corepack pnpm dev
```

Stdio is a trusted local-administrator transport. Configure the MCP client to start this command and
do not wrap it with anything that writes banners to stdout.

## HTTP and authentication

Non-loopback HTTP requires an HTTPS `PUBLIC_BASE_URL`, `ALLOWED_HOSTS`, and explicit trusted proxy
CIDRs. The server refuses unsafe public startup. `/mcp` accepts:

- `dcmcp_` personal access tokens created by `discord-mcp auth token create`;
- OIDC JWTs validated for issuer, audience, signature, time, and scopes;
- mapped proxy identities only from `TRUSTED_PROXY_CIDRS`.

Create a principal and PAT:

```sh
corepack pnpm cli -- principal create operator mcp:read,mcp:write,server:plan
corepack pnpm cli -- auth token create PRINCIPAL_ID editor
```

The token is displayed once. Health endpoints disclose only `{ "ok": true }`. Metrics require
`audit:read`. The protected-resource metadata lives at
`/.well-known/oauth-protected-resource/mcp`.

## Discord OAuth profiles

Set `DISCORD_CLIENT_SECRET`, `DISCORD_MCP_MASTER_KEY`, and `PUBLIC_BASE_URL`. Call
`discord_oauth_profile_authorize`, open the returned Discord authorization URL, and let Discord return
to `/oauth/discord/callback`. State and PKCE expire after ten minutes. Access and refresh tokens are
AES-256-GCM encrypted and never returned by profile list/get tools.

The master key is 32 random bytes encoded as base64:

```sh
openssl rand -base64 32
```

Back it up separately from SQLite. Losing it makes OAuth profiles and encrypted route/webhook secrets
unrecoverable.

## Compose and Traefik

Create `data` and `run`, owned by UID/GID 65532 (or set `DISCORD_MCP_RUNTIME_GID` consistently):

```sh
mkdir -p data run
sudo chown -R 65532:65532 data run
docker compose --profile images build
docker compose up -d server supervisor
```

`ROOTLESS_DOCKER_SOCKET` must point at a rootless daemon. The supervisor refuses rootful Docker unless
`DISCORD_MCP_ALLOW_ROOTFUL_DOCKER=true`, which is for isolated development only. Compose bind-mounts
`$PWD/data` and `$PWD/run` at both control-plane paths and daemon-visible absolute paths so sandbox
artifact and Unix-socket mounts resolve correctly.

The labels in `compose.yaml` support a shared external Traefik network; alternatively route to the
published host port. Adapt [traefik.example.yaml](./traefik.example.yaml), terminate TLS at Traefik,
and set exact hosts and proxy CIDRs. Host, forwarded protocol, proxy source, and principal mapping are
all validated; CORS is not authentication.

## Blobs, secrets, and maintenance

Only the local CLI may read an explicit local path:

```sh
corepack pnpm cli -- blob put PRINCIPAL_ID ./announcement.pdf application/pdf
printf %s "$WEBHOOK_SECRET" | corepack pnpm cli -- secret set PRINCIPAL_ID deploy-hook
```

Remote clients stream a blob to `POST /blobs` with bearer authentication,
`Content-Type`, and `X-Discord-Mcp-Filename`. MCP returns metadata, never blob bytes. Unreferenced blobs
expire after seven days; blobs retained by published templates remain referenced.

SQLite runs in WAL mode. Back up the database with SQLite's online backup command (or stop the server
and copy the database plus `-wal`/`-shm` consistently), the `data/blobs` and `data/artifacts`
directories, and the master key kept in a separate secret store. Test restores periodically.

## Incident recovery

1. Stop public traffic and the server; leave the database untouched.
2. For credential exposure, rotate `DISCORD_TOKEN`, revoke affected PAT/OAuth profiles, and replace
   named secrets. Audit entries contain metadata but redact credentials and message/blob bodies.
3. If RateGuard trips, do not retry. Check the Discord credential or run
   `discord_permissions_explain`; the default threshold is 25 invalid responses per family/profile in
   ten minutes.
4. For a partial blueprint, inspect its execution resource and call apply again with
   `resumeExecutionId` after taking a fresh matching plan/preview. Completed actions are not repeated.
5. For a failed workflow, disable it, inspect execution logs/diagnostics, publish a corrected revision
   or roll back to an existing published and granted artifact, then re-enable.
6. Restore SQLite, blobs, artifacts, and the same master key together. Run
   `discord-mcp migrate` and `diagnostics` before admitting traffic.
