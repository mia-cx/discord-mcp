# Direction

Textile is a Discord bot platform for agents, served over MCP. Agents drive their own bots
through it: Discord API calls, online presence, automations, voice, and one-off scripts. Textile
hosts no inference; it relays Discord to agents and runs agent-written code. Project code uses
the MCX License v1.0; third-party materials retain their original licenses.

## Access

Every HTTP request supplies a relay OAuth bearer credential and a separate `X-Discord-Bot-Token`
header. Textile validates both with Discord and acts as the supplied bot. OAuth identifies a
human; possession of the bot token determines bot access, not that human's guild permissions.
Anyone holding relay OAuth and a bot's token manages that bot's workflows; the acting human is
recorded.

A user-ID allowlist gates login and every authenticated request. v1 serves allowlisted friends:
the platform features (stored tokens, workflows, scripts, voice) require a configured allowlist,
and an unset list never opens them to every Discord user. The hosted deployment's operator-managed
list includes accepted developer-Team members and explicitly approved additional accounts.
Preserve those additions during Team resyncs, and keep user IDs outside Git.

Login grants travel in encrypted, audience-bound relay tokens; no login state lives in memory, so
any central replica finishes any login. Access lasts at most seven days. Authorization codes and
refresh tokens both enclose Discord's own refresh token: redeeming either rotates it, and Discord
rejects reuse, so Discord is the replay guard. A refresh chain outlives its 30-day client
registration; an unused refresh envelope expires after 30 days. Never issue a credential that
Discord's rotation does not guard. One login serves one machine: its bridges share `login.json`
and serialise refreshes with a lock file, and every other machine signs in separately.

## Architecture

- **Central** (stateless, load-balanced) serves MCP, OAuth, `/voice`, and workflow HTTP routes. It
  checks OAuth and the allowlist, decodes the bot ID from the token, and routes to the bot host
  that owns the bot by rendezvous hashing over `BOT_HOSTS`. It holds no tokens.
- **Bot hosts** (trusted) own bots: the encrypted stored token, the bot's single REST rate
  limiter, voice, the capability broker, and workflow dispatch. Gateway shards spread across bot
  hosts under Postgres leases. Each shard's resume state is stored, so another host resumes it
  after failover, with missed events replayed.
- **Runners** execute agent code in self-hosted workerd: one workerd process per active bot, under
  a supervisor that enforces a wall-clock deadline and kills the process on overrun. workerd has
  no per-isolate limits of its own. `globalOutbound` points at the broker, so isolates reach
  nothing else and never hold a real token.
- **Storage** is Postgres through Drizzle: stored tokens, shard sessions and leases, workflows,
  KV, schedules, routes, run records, voice opt-outs, and the audit log.

## Bots, workflows, and voice

- **Bots.** An agent's first call stores the bot's token and brings it online. It goes offline
  after 24 hours without agent calls unless workflows or voice keep it up.
- **Scripts.** `discord_script_run` runs plain discord.js once in an isolate, so many Discord
  calls cost one tool call.
- **Workflows.** Published discord.js code with pinned npm dependencies, bundled at publish into
  immutable revisions. Triggers: Gateway events (interactions included), cron schedules (each tick
  at most once, by a per-bot advisory lock), and inbound HTTP routes (bounded, each handler
  authenticates its own callers). Workflows keep state in a per-workflow KV store, and agents read
  their runs and logs, with tokens redacted.
- **Grants.** Each workflow and script declares catalog operations and reachable hosts; destructive
  operations need an explicit grant. The broker matches each raw REST call to a catalog operation,
  checks the grant, and swaps in the real token. Egress reaches granted public hosts only: every
  resolved address and redirect target is checked, and private, loopback, and link-local ranges
  are refused.
- **Voice.** A bidirectional voice WebSocket relays Discord voice per speaker, with DAVE
  encryption, in Opus or PCM16. Agents bring their own speech-to-speech or local models. Receiving
  always posts a notice first, whose buttons let anyone opt out here or from every Textile bot;
  without the notice, a session only sends audio. Discord does not support bots receiving voice, so
  receive is best-effort. Textile never stores audio.

Every cataloged operation carries hand-maintained Discord permission metadata cited from
Discord's docs, and `spec:check` fails on a missing entry. `@mia-cx/discord-catalog` is the
standalone, Workers-safe npm package for the catalog, schemas, table, and permission resolver.
Textile reports permissions in search and describe but does not enforce them; Discord decides each
call against the bot.

Local stdio uses the caller's environment token. `pnpm login` is the browser login helper, and
`scripts/client.mjs` bridges local agents over stdio to the hosted relay. Public setup instructions
use operator-supplied URLs; keep deployment hostnames out of this repository's docs and helper
defaults. Read `README.md` for tools, configuration, and limitations.

## Environments and deployment

The olympus k3s homelab is dev and staging. Production runs on a managed Kubernetes provider, not
yet chosen, so Textile uses only portable Kubernetes features: Deployments, StatefulSets,
NetworkPolicy, CloudNativePG, and a gVisor RuntimeClass for runners where offered. Bot hosts need
outbound UDP for voice and HTTPS to the npm registry.

Today's public relay on olympus is the earlier stateless relay, still serving real users from
namespace `discord-mcp`: a single-replica Deployment pinned to a tested image, its encryption key
in `discord-mcp-crypto`, and the Discord application's ID and secret in `discord-mcp-oauth`.
Traefik routes the configured public origin to `discord-mcp-relay`; the Discord redirect is that
origin plus `/auth/discord/callback`. Textile staging will run separately in namespace `textile`
with its own CloudNativePG cluster. Mia manages DNS. Routing manifests and recovery instructions
live in `mia-cx/yggdrasil-spec` under `argocd/discord-mcp/` and `hosts/athena-hephaestus/`. The
old Athena PAT/OIDC stack remains intact but off the public route; restoring it needs an explicit
recovery decision. `PLAN.md` describes that historical design.

## Next

- Staging on olympus, then runner isolation (gVisor, NetworkPolicy, per-bot cgroup limits).
- Real-Discord smoke tests: voice send and receive, and a workflow.
- Renaming the repository, packages, and deployment to Textile.
- Before public sign-up: quotas, billing, abuse handling, a host-wide limit on webhook traffic,
  and session writes fenced per lease hold rather than per process.
