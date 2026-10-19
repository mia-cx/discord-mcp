# Direction

Provide a stateless Discord API relay over MCP. Every HTTP request supplies a Discord bot token.
Validate it with Discord and execute that request's tools as that bot. Keep no credential,
authentication, session, or Discord-response cache. Discord permissions determine authority.

The relay needs no database, local accounts, PATs, OAuth profiles, Gateway, workflow engine, or
sandbox supervisor. The earlier control-plane libraries remain in the workspace as legacy code;
the server executable no longer starts them. `PLAN.md` describes that historical design.

## Current implementation

The executable uses the stable MCP SDK and supports the sessionless `2026-07-28` revision plus
stateless compatibility for older clients. Local stdio uses the caller's environment token.
Read `README.md` for tools, configuration, and current limitations.

## Deployment boundary

The live Docker stack on Athena still runs the divergent `t3code/implement-plan` worktree.
It currently authenticates clients with application PATs or configured OIDC. Publishing this
relay to `main` does not upgrade that running stack or migrate its stored data.

`https://discord.mia.cx/mcp` reaches the live instance through public k3s Traefik. Mia manages DNS.
Routing manifests, Athena relay units, and recovery instructions live in
`mia-cx/yggdrasil-spec` under `argocd/discord-mcp/` and `hosts/athena-hephaestus/`.
Consult those files when deploying the stateless relay or recovering its backend registration.
