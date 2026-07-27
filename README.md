# discord-mcp v1

A self-hosted Discord control plane and sandboxed TypeScript workflow runtime, driven through MCP.
Discord is the action target; bot, OAuth, webhook, and interaction credentials remain inside the
control plane.

v1 includes:

- 242 pinned Discord HTTP v10 operations through local search/describe/preview and risk-separated
  dispatchers, plus 100+ curated operator, automation, and administration tools
- semantic Components V2, legacy messages, modals, safe mentions, multipart attachments, blobs, and
  immutable typed templates
- declarative server blueprints with logical bindings, permission/hierarchy checks, state-bound
  previews, idempotent plan/apply, a durable action journal, and resumable partial execution
- lazy/eager Gateway lifecycle, normalized durable cursors, race-free waits, interactions with
  Ed25519 verification and deterministic deferral, and OAuth2 user profiles with PKCE
- immutable workflow revisions, separately approved default-deny grants, rootless-Docker builds and
  runners, a revision-scoped capability broker, schedules, interactions, Gateway triggers, manual
  invocation, and authenticated namespaced HTTP routes
- SQLite persistence, encrypted secrets, PAT/OIDC/trusted-proxy MCP authentication, audit history,
  retention, Prometheus metrics, stdio, and authenticated Streamable HTTP

No MCP input accepts a local filesystem path. The local CLI is the only component that can read an
explicit path for `blob put`.

## Quick start

Node 24 and Corepack are required.

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm release:check
cp .env.example .env
```

For trusted local stdio:

```sh
DISCORD_TOKEN=... MCP_TRANSPORT=stdio corepack pnpm dev
```

For Compose, prepare absolute host data/runtime directories owned by UID 65532, configure a rootless
Docker socket, then build all four images:

```sh
mkdir -p data run
sudo chown -R 65532:65532 data run
docker compose --profile images build
docker compose up -d server supervisor
```

See [setup](docs/setup.md), [Discord permissions and intents](docs/discord-permissions.md),
[deployment and Traefik](docs/deployment.md), [OAuth](docs/oauth.md),
[workflow authoring](docs/workflows.md), [backups](docs/backups.md), and
[incident recovery](docs/recovery.md).

GitHub Actions publishes the server, supervisor, workflow-builder, and workflow-runner images to
GHCR on `main` and version-tag pushes. See [deployment](docs/deployment.md#published-ghcr-images) for
the package names and tag policy.

The exact product contract, deferred items, and permanent exclusions are in [PLAN.md](PLAN.md).
Beta compatibility findings are recorded in
[ADR 0001](docs/architecture/0001-beta-foundations.md). As of 2026-07-27, npm still
publishes `@modelcontextprotocol/server@2.0.0-beta.5` as `latest`; v2 stable does not yet exist, so the
exact verified beta remains pinned.

## Verification

```sh
corepack pnpm check
corepack pnpm typecheck
corepack pnpm spec:check
corepack pnpm test
corepack pnpm test:integration
corepack pnpm test:stdio
corepack pnpm test:sandbox
corepack pnpm build
corepack pnpm mcp:inspect
corepack pnpm pack:smoke
corepack pnpm release:audit
```

`test:e2e` is deliberately opt-in. Set `DISCORD_MCP_E2E=true`,
`DISCORD_MCP_TEST_GUILD_ID`, and `DISCORD_MCP_TEST_CHANNEL_ID` only for a disposable test guild.
