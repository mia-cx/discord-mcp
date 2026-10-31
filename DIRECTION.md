# Direction

Provide a stateless Discord API relay over MCP. HTTP callers must log in with Discord OAuth.
Project code uses the MCX License v1.0; third-party materials retain their original licenses.
Every request supplies a relay OAuth bearer credential and a separate `X-Discord-Bot-Token` header.
Validate both grants with Discord and execute that request's tools as the supplied bot.
OAuth identifies a human; possession of the bot token determines bot access, not that human's guild permissions.
An optional user-ID allowlist gates both login and every authenticated request. The hosted
deployment's operator-managed list includes accepted developer-Team members and explicitly
approved additional accounts. Preserve those additions during Team resyncs; keep user IDs
outside Git and no server-side bot token for lookups.

Today's relay keeps no bot credentials, authentication results, sessions, or Discord-response
cache; the platform below changes that. Login grants
travel in encrypted, audience-bound relay tokens. Spent authorization-code hashes expire after
one minute; the next code exchange or process restart removes expired hashes. Use one process;
an in-flight login fails on restart. Existing logins survive.
Access lasts at most seven days. Refresh tokens are encrypted envelopes around Discord's own
refresh token, bound to the subject and client ID. Discord rotates that token on every refresh,
revokes the previous access token, and rejects reuse, so Discord is the replay guard and the relay
keeps no refresh state. A refresh chain outlives its 30-day client registration; an unused refresh
envelope expires after 30 days. Never issue a refresh token that Discord's rotation does not guard.
One login serves one machine: its bridges share `login.json` and serialise refreshes with a lock
file. Every other machine signs in separately, since one holder's refresh revokes every copy.

The relay needs no database, local accounts, PATs, stored OAuth profiles, Gateway, workflow engine, or
sandbox supervisor. The earlier control-plane libraries remain in the workspace as legacy code;
the server executable no longer starts them. `PLAN.md` describes that historical design.

## Heading: Textile, a bot platform for agents

The project is being renamed Textile. It is growing from a stateless relay into a platform where
agents run their bots: online presence, automations, voice, and one-off scripts. Textile hosts no
inference; it relays Discord to agents and runs agent-written code. v1 serves allowlisted friends.

- **Tiers.** A stateless, load-balanceable central tier checks OAuth and the allowlist, then
  routes by bot ID (decoded from the token). Trusted bot hosts each own a set of bots: the
  encrypted stored token, the REST rate limiter, Gateway shards, voice, and the capability broker.
  Untrusted runners execute workerd isolates and hold no secrets.
- **Bots.** An agent's first call stores the bot's token and brings it online; it goes offline
  after 24 hours without agent calls unless automations or voice keep it up. Each shard's resume
  state is stored so any bot host can resume it after failover. Shards spread across bot hosts.
- **Workflows.** TypeScript against discord.js, adapted where it cannot run in an isolate, with
  pinned npm dependencies bundled at publish. Triggers are Gateway events (interactions
  included), cron schedules, and inbound HTTP routes. Each workflow declares grants: catalog
  operations and reachable hosts, shown at enable time; destructive operations need an explicit
  grant. Egress goes through a broker proxy that blocks private ranges. Anyone holding relay
  OAuth and the bot's token manages its workflows; the acting human is recorded.
- **Voice.** A bidirectional voice WebSocket relays Discord voice, per speaker. Agents bring their
  own speech-to-speech or local models; Textile never runs them. Receiving voice always posts a
  notice whose buttons let anyone opt out of relay, from that bot in that server or from every
  Textile bot; without the notice, a session only sends audio.
- **Storage.** Postgres on CloudNativePG, accessed through Drizzle.
- **Environments.** The olympus k3s homelab is dev and staging. Production runs on a managed
  Kubernetes provider, not yet chosen, so Textile uses only portable Kubernetes features.

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
Discord's docs. `spec:check` fails on a missing entry. `@mia-cx/discord-catalog` is the
standalone, Workers-safe npm package for the catalog, schemas, table, and permission resolver.
The internal `@discord-mcp/discord-api/catalog` entry re-exports it, so a relay acting for a person can
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
