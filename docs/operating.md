# Operating the stateless relay

Run the HTTP server without a bot token or database. Each MCP client supplies
`Authorization: Bearer <Discord bot token>` on every request to `/mcp`.

The relay validates the token with Discord and uses it for that request only.
It rejects user tokens. Discord bot permissions determine which operations succeed.

## Source

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm build
corepack pnpm start
```

This binds `127.0.0.1:3000`. Health checks are unauthenticated; MCP requests require
the caller's token. Local stdio accepts `MCP_TRANSPORT=stdio` and `DISCORD_TOKEN`.

## Containers

Set `PUBLIC_BASE_URL` and `ALLOWED_HOSTS` using `docker/.env.example`, then run
`docker compose --env-file .env up -d` from `docker/`. The image contains the relay;
it uses no state volumes or supervisor. Put TLS termination in front of it.

Public routing and Athena's loopback-to-LAN forwarding units are maintained in
`mia-cx/yggdrasil-spec`. Check `DIRECTION.md` before replacing the old deployment:
the live control plane has its own data and a different implementation.

## Failures

HTTP 401 means the supplied token is missing, invalid, or not a bot credential.
HTTP 429 during authentication means Discord rate-limited validation; honor
`Retry-After`. HTTP 502 means Discord validation or request processing failed.

Discord permission failures appear in MCP tool results. Use
`discord_permissions_explain` to inspect the bot's effective permissions.

Credentials, validation results, and Discord responses are not cached. A reset bot
token stops working on its next request. Avoid logging client authorization headers
in your reverse proxy.

The relay has no database to back up, migrations to run, or stored credentials to
recover. Preserve any data from the retired control plane independently.
