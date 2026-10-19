# discord-mcp

A self-hosted MCP server for Discord administration and TypeScript automation. Connect an MCP client
in your editor or CLI to inspect guilds, send messages, manage roles, and run workflows.
The MCP client supplies the agent. This repository does not run an LLM or start model turns when
Discord events arrive.

The server supports local stdio and authenticated Streamable HTTP. It stores state in SQLite.
Optional workflows run in containers through a separate sandbox supervisor.

## Implementation status

The repository has substantial implementation beyond its original stdio prototype. It also has
unfinished integration work. [PLAN.md](./PLAN.md) describes the intended product;
[GOAL.md](./GOAL.md) records phase progress, but its all-done table overstates end-to-end completion.
The gaps below remain in the current code.

### Implemented

| Area | What exists |
| --- | --- |
| MCP transports | Stdio and Streamable HTTP at `/mcp`, tool discovery, request cancellation, and structured tool results. Resources expose catalog, workflow, execution, and audit data. |
| HTTP authentication | Personal access tokens, external OIDC JWT verification, trusted-proxy identities, and scope checks on tools. Stdio uses a local administrator principal. |
| Discord REST | A generated catalog covering the vendored specification's 242 operations. Search, describe, preview, and separate read/write/destructive/admin dispatchers. Credential-class operations are excluded from generic execution. |
| Operator tools | Guild, channel, role, and member inspection; role creation and assignment; timeouts, bans, kicks, and audit-log reads. Other operations use the catalog dispatchers. |
| Messages | Legacy and Components V2 validation, encoding, previews, send/edit/read, reactions, pins, and crossposting. Modal validation and opaque component bindings exist. Attachment delivery and interaction handling have gaps below. |
| Templates and blueprints | Versioned templates with typed variables and rendering. Guild snapshots, blueprint drafts and revisions, diff planning, preview-bound apply, persistent resource bindings, and an apply journal. |
| Gateway and events | Gateway connection management, intent configuration, recent-event queries, bounded waits, and a persistent event log through `events_tail`. |
| Storage and administration | SQLite migrations and repositories, encrypted named secrets, PAT administration, and a CLI for principals, tokens, secrets, migrations, and audit reads. |
| Workflow execution | TypeScript SDK, sandbox builds, published revisions, grants, enable/disable/rollback, manual invocation, execution records, queues, Gateway dispatch, and cron scheduling. Runtime registration has limitations below. |
| Workflow HTTP routes | Routes under `/workflows/{slug}/`, API-key, bearer, and HMAC authentication, replay checks, and request policy checks. |
| Sandbox | Separate build and runtime containers, rootless-daemon checks, resource limits, and a capability broker for Discord, HTTP, KV, and logs. Workflows are disabled by default. |
| Diagnostics and packaging | MCP metrics, queue-depth and audit tools; four Dockerfiles; CI checks and multi-architecture image build/publish jobs. |

Catalog coverage means an operation has metadata and schemas. It does not prove every operation can
execute with every authentication mode or payload type.

### Incomplete or not connected

| Area | Current limitation |
| --- | --- |
| Discord OAuth API calls | Authorization, PKCE, encrypted token storage, refresh, and revocation exist. The dispatcher resolves profile names, but the REST client still uses the bot token. OAuth-only operations are not connected to bearer-token execution. See [dispatch](./packages/discord-api/src/dispatch/dispatcher.ts) and [REST](./packages/discord-api/src/rest.ts). |
| Interaction-driven workflows | The signed endpoint verifies signatures, answers PING, deduplicates, resolves component handles, and returns deferred responses. The server discards its dispatch result. Workflow command registration, handler invocation, component inbox delivery, autocomplete, and automatic follow-ups are not connected. See [entrypoint](./apps/server/src/bin.ts) and [interaction router](./packages/discord-api/src/interactions/router.ts). |
| Attachment uploads | Presentation schemas describe attachments, but send/edit do not upload their bytes. CLI `blob put` records metadata without storing file contents. The shared presentation path for webhooks and interaction responses is also incomplete. See [message tools](./packages/discord-api/src/tools/message-tools.ts) and [CLI commands](./apps/cli/src/commands.ts). |
| Workflow lifecycle integration | Gateway and schedule dispatch load enabled workflows at startup. Enable, disable, and rollback do not refresh that cached set. Manual invocation always selects trigger index 0, so it assumes the manual handler is first. See [automation startup](./apps/server/src/automation.ts) and [lifecycle tools](./packages/workflow-runtime/src/tools.ts). |
| Retention and metrics export | A database cleanup function exists but has no production caller. Documented retention periods are not automatically enforced. Metrics are available through `metrics_snapshot`; there is no HTTP `/metrics` exporter. |
| Compose startup | The server image binds to `0.0.0.0`, which requires an HTTPS `PUBLIC_BASE_URL` and `ALLOWED_HOSTS`. The supplied Compose file does not forward `ALLOWED_HOSTS`, so its server environment needs an override. See [Compose](./docker/compose.yaml) and [exposure checks](./apps/server/src/public-exposure.ts). |

The project pins Effect `4.0.0-beta.101` and MCP `2.0.0-beta.5`. Moving to stable dependencies and
proving all release acceptance criteria remain separate work. Passing the ordinary test suite does
not establish complete live Discord, reverse-proxy, or sandbox acceptance.

### Deliberately out of scope

- A bundled chat agent, login UI, or identity provider.
- Automatic model turns in response to Discord events. Workflows execute TypeScript handlers.
- Voice audio playback, capture, codecs, or recording. Voice/stage REST operations remain in scope.
- Multiple active control-plane replicas or hosted/serverless deployment targets.
- The native Discord Social SDK bridge, which is deferred.

## Run locally

Use Node.js 24 or newer and the pnpm version pinned in `package.json`.

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm build
DISCORD_TOKEN=your_bot_token \
  DISCORD_MCP_GATEWAY_MODE=off \
  node apps/server/dist/bin.js
```

This starts the stdio server with Gateway connections disabled. Configure your MCP client to launch
that command from the repository root and supply the token through its environment settings.
Stdout carries JSON-RPC; logs go to stderr. The process waits for an MCP client rather than showing
an interactive prompt.

The database defaults to `./discord-mcp.sqlite`. Set a persistent `DISCORD_MCP_MASTER_KEY` before
storing encrypted secrets. Without one, the server generates a temporary key that changes on restart.

To use the MCP Inspector after building:

```sh
DISCORD_TOKEN=your_bot_token DISCORD_MCP_GATEWAY_MODE=off corepack pnpm mcp:inspect
```

### HTTP access

Create a principal and PAT using the same `DATABASE_PATH` as the server:

```sh
node apps/cli/dist/bin.js principal create operator "Operator" mcp:read mcp:write
node apps/cli/dist/bin.js auth token create operator desktop 90
DISCORD_TOKEN=your_bot_token \
  DISCORD_MCP_GATEWAY_MODE=off \
  MCP_TRANSPORT=http \
  node apps/server/dist/bin.js
```

Connect to `http://127.0.0.1:3000/mcp` with `Authorization: Bearer <issued-token>`.
The CLI displays the PAT once. This example grants read/write tools; destructive and administrative
operations require additional scopes.

External OIDC requires `OIDC_ISSUER`, `OIDC_AUDIENCE`, and `OIDC_JWKS_URI`. Verified tokens currently
map to the configured local principal named `oauth`, with scopes intersected. Trusted-proxy access
requires explicit proxy trust configuration and an existing identity mapping.

### Configuration

| Variable | Default or purpose |
| --- | --- |
| `DISCORD_TOKEN` | Required bot token. |
| `MCP_TRANSPORT` | `stdio` or `http`; defaults to `stdio` when running from source. |
| `DATABASE_PATH` | `./discord-mcp.sqlite` from source; `/data/discord-mcp.sqlite` in the server image. |
| `MCP_HTTP_HOST`, `MCP_HTTP_PORT` | `127.0.0.1` and `3000` from source. |
| `DISCORD_MCP_MASTER_KEY` | Base64-encoded 32-byte key for durable encrypted secrets. Generate once with `openssl rand -base64 32` and retain it with your backup configuration. |
| `DISCORD_MCP_TOOLSETS` | `operator,automation,api`. Add `admin` to discover administrative tools. Toolsets control discovery; scopes authorize calls. |
| `DISCORD_MCP_GATEWAY_MODE` | `lazy`; accepts `off`, `lazy`, or `eager`. The current automation startup asks for a connection whenever Gateway is enabled, including `lazy`. Use `off` for REST-only operation. |
| `DISCORD_MCP_GATEWAY_INTENTS` | `Guilds,GuildMessages`. Privileged intents must also be enabled for the Discord application. |
| `DISCORD_MCP_WORKFLOWS_ENABLED` | `false`. Enabling requires a configured supervisor socket and matching `DISCORD_MCP_SUPERVISOR_CREDENTIAL`. |
| `PUBLIC_BASE_URL`, `ALLOWED_HOSTS` | Required for a non-loopback HTTP bind; the public base URL must use HTTPS. |
| `DISCORD_PUBLIC_KEY` | Enables signature verification at `/discord/interactions`; handler dispatch remains incomplete. |

The [configuration loader](./apps/server/src/config.ts) contains the full set of settings.
[Operating notes](./docs/operating.md) cover authentication, Discord setup, and recovery; apply the
implementation limitations above when following them.

## Workflows and containers

A workflow is TypeScript source using `@discord-mcp/workflow-sdk`. The lifecycle tools create a draft,
build it in a sandbox, publish a revision, approve its grant, and enable it. A grant specifies what
that revision may access. Workflow containers use brokered calls for Discord, HTTP, KV, and logging.

The four images are `server`, `supervisor`, `workflow-build`, and `workflow-runner`. Their Dockerfiles
and the Compose template live in [docker/](./docker/). The supervisor requires a rootless Docker
daemon with working memory and PID limits. The server holds Discord credentials; the supervisor
owns the Docker connection.

[CI](./.github/workflows/ci.yml) is configured to build native amd64 and arm64 images and publish to
`ghcr.io/mia-cx/discord-mcp/<image>`. Branch builds use `main`; version tags produce release tags and
`latest`. The workflow configuration alone does not establish that a particular image tag was
successfully published.

## Development and verification

```sh
corepack pnpm check         # Biome, TypeScript build, and ordinary Vitest suites
corepack pnpm spec:check    # Vendored catalog coverage, classification, and regeneration checks
corepack pnpm spec:generate # Regenerate catalog files after changing the vendored specification
corepack pnpm spec:drift    # Report upstream changes without updating the vendor files
```

Ordinary tests cover schemas, dispatch, authentication, storage, templates, blueprints, workflow
services, HTTP handling, and the real stdio subprocess. Many integration tests substitute Discord
or the sandbox supervisor. Real-service suites are excluded from `pnpm check` and ordinary CI.

Run opt-in suites with `corepack pnpm test:e2e`. Each has its own prerequisites:

| Suite | Opt-in and prerequisites |
| --- | --- |
| [Discord test guild](./apps/server/test/test-guild.e2e.test.ts) | `DISCORD_MCP_E2E_TOKEN` and `DISCORD_MCP_E2E_GUILD`. Creates and deletes resources in that guild. |
| [Sandbox isolation](./apps/sandbox-supervisor/test/supervisor.e2e.test.ts) | `DISCORD_MCP_E2E_DOCKER=1` and a rootless Docker daemon. Starts containers and exercises filesystem, network, memory, and PID restrictions. |
| [Workflow lifecycle](./apps/sandbox-supervisor/test/lifecycle.e2e.test.ts) | `DISCORD_MCP_E2E_STACK=1` and a prepared Compose stack. Configure its project, env-file, and optional override through the `DISCORD_MCP_E2E_*` variables in the test. |

## Repository map

| Path | Contents |
| --- | --- |
| [apps/server/](./apps/server/) | MCP server, HTTP endpoints, configuration, and automation loops. |
| [apps/cli/](./apps/cli/) | Local credential and database administration. |
| [apps/sandbox-supervisor/](./apps/sandbox-supervisor/) | Docker build/run orchestration and its Unix-socket protocol. |
| [packages/](./packages/) | Core MCP utilities, Discord API/Gateway/presentations/blueprints, auth, persistence, workflow runtime, and SDK. |
| [vendor/discord/](./vendor/discord/) | Pinned OpenAPI specification, provenance, and classification overrides. |
| [docs/](./docs/) | Operating notes and the beta-foundation architecture decision. |
| [spike/](./spike/) | Original Effect/MCP compatibility probe. |
