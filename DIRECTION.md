# Direction

Provide a stateless Discord API relay over MCP. HTTP callers must log in with Discord OAuth.
Every request supplies a relay OAuth bearer credential and a separate `X-Discord-Bot-Token` header.
Validate both grants with Discord and execute that request's tools as the supplied bot.
OAuth identifies a human; possession of the bot token determines bot access, not that human's guild permissions.

Keep no bot credentials, authentication results, sessions, or Discord-response cache. Login grants
travel in encrypted, audience-bound relay tokens. Only spent authorization-code hashes remain
in memory for one minute. Use one process; an in-flight login fails on restart. Existing logins survive.
Public clients sign in again when their grant expires, at most seven days. Refresh tokens would
require durable replay protection; do not add an unrotated stateless refresh-token shortcut.

The relay needs no database, local accounts, PATs, stored OAuth profiles, Gateway, workflow engine, or
sandbox supervisor. The earlier control-plane libraries remain in the workspace as legacy code;
the server executable no longer starts them. `PLAN.md` describes that historical design.

## Current implementation

The executable uses the stable MCP SDK and supports the sessionless `2026-07-28` revision plus
stateless compatibility for older clients. Local stdio uses the caller's environment token.
HTTP supports OAuth discovery, dynamic client registration, browser-bound consent and S256 PKCE.
`pnpm login` is the dependency-free browser login helper. Operators configure one Discord OAuth app.
Read `README.md` for tools, configuration, and current limitations.

## Deployment boundary

The live Docker stack on Athena still runs the divergent `t3code/implement-plan` worktree.
It currently authenticates clients with application PATs or configured OIDC. Publishing this
relay to `main` does not upgrade that running stack or migrate its stored data.

`https://discord.mia.cx/mcp` reaches the live instance through public k3s Traefik. Mia manages DNS.
Routing manifests, Athena relay units, and recovery instructions live in
`mia-cx/yggdrasil-spec` under `argocd/discord-mcp/` and `hosts/athena-hephaestus/`.
Consult those files when deploying the stateless relay or recovering its backend registration.
