# Direction

Provide a stateless Discord API relay over MCP. HTTP callers must log in with Discord OAuth.
Every request supplies a relay OAuth bearer credential and a separate `X-Discord-Bot-Token` header.
Validate both grants with Discord and execute that request's tools as the supplied bot.
OAuth identifies a human; possession of the bot token determines bot access, not that human's guild permissions.
An optional user-ID allowlist gates both login and every authenticated request. The hosted
deployment's operator-managed list includes accepted developer-Team members and explicitly
approved additional accounts. Preserve those additions during Team resyncs; keep user IDs
outside Git and no server-side bot token for lookups.

Keep no bot credentials, authentication results, sessions, or Discord-response cache. Login grants
travel in encrypted, audience-bound relay tokens. Spent authorization-code hashes expire after
one minute; the next code exchange or process restart removes expired hashes. Use one process;
an in-flight login fails on restart. Existing logins survive.
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
`scripts/client.mjs` connects local agents over stdio to the hosted HTTP relay, sharing private
client-side login and bot files without putting credentials in each agent's configuration.
Read `README.md` for tools, configuration, and current limitations.

Every cataloged operation carries hand-maintained Discord permission metadata: permission
names, guild or channel scope, alternatives, conditions, and role-hierarchy rules, cited from
Discord's docs. `spec:check` fails on a missing entry. `@discord-mcp/discord-api/catalog` exports
it with the catalog and the effective-permission resolver, so a relay acting for a person can
filter and re-check calls against that person's permissions. This relay reports it in search and
describe but does not enforce it; Discord still decides each call against the bot.
Public setup instructions use operator-supplied URLs. Keep deployment hostnames out of this
repository's docs and helper defaults; the login helper requires an explicit relay URL.

## Deployment boundary

The public OAuth relay runs in native k3s. Namespace `discord-mcp` has a
single-replica, read-only Deployment pinned to a tested OAuth relay image and a
`discord-mcp-relay` Service. The generated encryption key lives in `discord-mcp-crypto`.
The existing Discord application's ID and secret are saved in `discord-mcp-oauth`.
The Discord redirect is the private configured public origin plus `/auth/discord/callback`.

Traefik routes the configured public origin to `discord-mcp-relay`.
The old Athena `t3code/implement-plan` PAT/OIDC stack and its data remain intact but are not
on the public route. Restoring that backend requires an explicit recovery decision.

Mia manages the deployment's DNS. Operator configuration supplies its public origin.
Routing manifests, Athena relay units, and recovery instructions live in
`mia-cx/yggdrasil-spec` under `argocd/discord-mcp/` and `hosts/athena-hephaestus/`.
Consult those files when deploying the stateless relay or recovering its backend registration.
