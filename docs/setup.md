# Setup

## Discord application

Create an application and bot in the Discord Developer Portal. Copy the bot token into
`DISCORD_TOKEN`; never commit it. Set the interactions endpoint to
`https://your-host/discord/interactions` and copy the application public key to
`DISCORD_PUBLIC_KEY`. `DISCORD_APPLICATION_ID` is optional: the server derives and caches it from
`GET /applications/@me` when commands or OAuth first need it.

Use the OAuth2 URL generator to install the bot with the `bot` and `applications.commands` scopes.
Start with the permissions described in [discord-permissions.md](discord-permissions.md), then grant
only what the target guild needs.

## Local stdio

```sh
corepack pnpm install --frozen-lockfile
DATABASE_PATH="$PWD/data/discord-mcp.sqlite" \
DISCORD_TOKEN=... MCP_TRANSPORT=stdio corepack pnpm dev
```

Stdio is a trusted local administrator. Stdout belongs exclusively to JSON-RPC; diagnostics and
structured logs go to stderr.

## HTTP

Create a principal and PAT:

```sh
corepack pnpm cli -- principal create operator mcp:read,mcp:write,template:read,server:plan
corepack pnpm cli -- auth token create PRINCIPAL_ID editor
```

The PAT is printed once. Send it as `Authorization: Bearer dcmcp_...` to `/mcp`. OIDC and trusted
proxy identity produce the same principal/scope model. Public binds fail startup unless
`PUBLIC_BASE_URL` is HTTPS and `ALLOWED_HOSTS` is non-empty.

Generate the master key and supervisor credential independently:

```sh
openssl rand -base64 32
openssl rand -base64 32
```

`DISCORD_MCP_MASTER_KEY` must decode to exactly 32 bytes. Back it up separately from SQLite.

## Tool discovery

Use a curated tool when one matches. Otherwise call `discord_api_search`, inspect the operation with
`discord_api_describe`, call `discord_api_preview` for destructive or bot-administration operations,
then use the risk-matching dispatcher with the returned 60-second single-use token.
