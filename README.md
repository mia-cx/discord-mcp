# discord-mcp

`discord-mcp` is a self-hosted Discord control plane and sandboxed TypeScript automation runtime
exposed through the Model Context Protocol (MCP). It gives an MCP client a typed, permission-aware
way to operate Discord, while keeping bot tokens, OAuth tokens, route secrets, the database, and the
Docker socket out of model-visible inputs and untrusted workflow containers.

The supported deployment is intentionally simple: one durable control-plane server, one sandbox
supervisor, SQLite, and short-lived builder or runner containers on a rootless Docker daemon. It is
designed for a powerful single installation, not for horizontal scaling or serverless deployment.

## What it does

- Exposes 127 MCP tools, including a curated Discord operator surface and risk-separated access to
  all 242 operations in a pinned Discord HTTP API v10 catalog.
- Sends and edits legacy messages, Components V2 layouts, modals, attachments, webhooks, and
  interaction responses through semantic schemas with safe mention defaults.
- Stores immutable, typed message-template revisions with variable validation and rendering.
- Captures Discord guild state and plans or applies declarative server blueprints for guild settings,
  roles, channels, permission overwrites, welcome screens, onboarding, and AutoMod.
- Maintains a lazy or eager Discord Gateway connection with durable events, cursors, bounded waits,
  presence updates, voice-state updates, and workflow triggers.
- Verifies Discord interactions from their exact raw request body, acknowledges them within the
  deadline, and routes commands, components, modals, and autocomplete to the owning workflow.
- Builds arbitrary TypeScript workflows with npm dependencies, publishes immutable artifacts, and
  executes them in non-root, read-only, networkless containers.
- Brokers narrowly approved Discord, HTTP, KV, logging, clock, and execution-context capabilities to
  workflows without giving a runner an underlying Discord or control-plane credential.
- Supports authenticated workflow HTTP routes, schedules, manual invocation, Gateway events, and
  Discord interaction triggers.
- Persists state in SQLite, encrypts OAuth and named-secret material, records audit history, exports
  Prometheus metrics, and provides PAT, OIDC, trusted-proxy, stdio, and Streamable HTTP access.

## Choose how you want to run it

| Mode | Best for | Trust model |
| --- | --- | --- |
| Local stdio | One trusted local MCP client, development, and evaluation | The stdio client receives the built-in local-administrator principal with every scope. |
| Docker Compose over HTTP | Persistent self-hosting, multiple scoped MCP clients, interactions, OAuth, routes, and workflows | Clients authenticate with PAT, OIDC, or a mapped trusted-proxy identity. Workflows run behind the sandbox supervisor. |

Node.js 24 and Corepack are required for source development. A Compose deployment additionally
requires a rootless Docker daemon with cgroup v2 memory and PID enforcement. The supervisor refuses
to serve when those resource controls are unavailable.

## Five-minute local start

```sh
corepack pnpm install --frozen-lockfile
mkdir -p data
DISCORD_TOKEN=your_bot_token \
DATABASE_PATH="$PWD/data/discord-mcp.sqlite" \
MCP_TRANSPORT=stdio \
corepack pnpm dev
```

Configure your MCP client to launch that command. Do not wrap it with a program that writes banners
or diagnostics to stdout: stdout is reserved for JSON-RPC, and logs go to stderr.

The stdio transport is deliberately trusted. Use HTTP with scoped principals when the MCP client
should not be an administrator.

## Docker Compose start

1. Create a Discord application and bot.
2. Install and select a rootless Docker context.
3. Copy `.env.example` to `.env` and fill in the required credentials and host values.
4. Create absolute data and runtime directories accessible to UID/GID 65532.
5. Build or pull the four images.

```sh
cp .env.example .env
mkdir -p data run
sudo chown -R 65532:65532 data run
docker context use rootless
docker compose --profile images build
docker compose config
docker compose up -d server supervisor
```

At minimum, `.env` needs:

```dotenv
DISCORD_TOKEN=...
DISCORD_MCP_SUPERVISOR_CREDENTIAL=at-least-32-random-characters
ROOTLESS_DOCKER_SOCKET=/run/user/1000/docker.sock
ROOTLESS_DOCKER_GID=1000
```

For a public HTTP deployment, also set an HTTPS `PUBLIC_BASE_URL`, the exact
`ALLOWED_HOSTS`, and the CIDRs of your TLS reverse proxy. The server refuses an unsafe public bind.
The included Compose file publishes only to `127.0.0.1` by default.

Read [Setup](docs/setup.md) before starting a persistent installation and
[Deployment](docs/deployment.md) before exposing it through a reverse proxy.

## Connect an HTTP MCP client

The HTTP endpoint is `/mcp`. Create a principal and a personal access token:

```sh
corepack pnpm cli -- principal create operator \
  mcp:read,mcp:write,template:read,template:write,server:plan,workflow:read
corepack pnpm cli -- auth token create PRINCIPAL_ID desktop-client
```

The PAT is shown once. Send it as:

```http
Authorization: Bearer dcmcp_...
```

HTTP can also validate external OIDC JWTs or accept a pre-mapped identity from a trusted reverse
proxy. Authentication establishes who the caller is; scopes determine which local tools they may
invoke; Discord permissions still determine what the bot or OAuth profile may do in a guild.

See [Authentication and authorization](docs/authentication.md) for the scope model and
[Discord OAuth profiles](docs/oauth.md) for user-context Discord access.

## How to use the tool surface

Every tool name begins with `discord_`. Tool definitions include an object-root input schema, an
object-root output schema, local scope requirements, Discord permission guidance, and MCP behavior
annotations.

Prefer a curated tool such as `discord_message_send`, `discord_channel_create`, or
`discord_member_timeout` when one matches the task. Curated tools provide tighter schemas, local
permission and hierarchy checks, and clearer diagnostics.

For an operation without a curated tool:

1. Search the pinned catalog with `discord_api_search`.
2. Inspect the operation with `discord_api_describe`.
3. For destructive or bot-administration operations, obtain a short-lived, single-use token from
   `discord_api_preview`.
4. Call the dispatcher matching the operation risk:
   `discord_api_read`, `discord_api_write`, `discord_api_destructive`, or `discord_api_admin`.

Catalog dispatch accepts operation IDs and structured parameters, not arbitrary URLs,
`Authorization` headers, or local filesystem paths.

The available toolsets are:

| Toolset | Contents |
| --- | --- |
| `operator` | Curated Discord operations, presentations, blobs, snapshots, permission explanations, and blueprint planning. |
| `automation` | Message-template tools, workflow lifecycle tools, and durable event tails. |
| `admin` | OAuth profile management, audit and metrics tools, application management, and blueprint apply. |
| `api` | Catalog search, describe, preview, and the four risk-separated dispatchers. |

`DISCORD_MCP_TOOLSETS` defaults to `operator,automation,api`; add `admin` deliberately. Toolsets only
control discovery. Per-principal scopes and Discord permissions still apply.

See the [MCP tool guide](docs/tool-guide.md) for the complete 127-tool inventory and selection
workflow.

## Messages, templates, and blueprints

Message tools accept semantic presentations:

- `legacy` for content, embeds, attachments, and action rows;
- `components_v2` for text displays, sections, containers, media galleries, files, separators,
  thumbnails, buttons, and selects;
- `template` for a published immutable template plus typed variables.

Allowed mentions default to none. Broad `@everyone` or `@here` behavior requires both explicit
presentation data and the local or workflow `mentions:broad` authority.

Templates use a draft → validate → publish → render lifecycle. Published revisions never change.
Blueprints use a similar stored-revision lifecycle, followed by a live
snapshot → plan → preview → apply sequence. Apply captures Discord again and rejects a plan when the
guild changed after preview. Managed deletions separately require `mcp:destructive`, and partial
execution is journaled for safe resumption.

Read [Messages and Components](docs/messages.md), [Message templates](docs/templates.md), and
[Server blueprints](docs/blueprints.md).

## Workflows

A workflow is TypeScript source plus exact dependencies. It default-exports `Workflow.make(...)`
from `@discord-mcp/workflow-sdk`. The lifecycle is:

```text
create or update draft
        ↓
validate and sandbox-build
        ↓
publish immutable revision
        ↓
approve revision-specific grant
        ↓
enable
```

Requested grants in source are a declaration, not authority. An administrator must approve a
concrete grant that covers the revision's requests. Empty allowlists mean no access.

Workflows execute ordinary published TypeScript handlers. They do not start an LLM, continue an MCP
client conversation, or schedule autonomous “agent turns.” An external agent may use the MCP tools,
but model orchestration remains the MCP client's responsibility.

Supported triggers are:

- Gateway events;
- guild or global slash commands;
- user and message context commands;
- components, modals, and autocomplete;
- authenticated namespaced HTTP routes;
- five-field cron schedules;
- explicit manual invocation.

Runtime containers have no direct network. Workflow code uses brokered `Discord`, `WorkflowKv`,
`Http`, `Log`, `Execution`, and `Clock` capabilities. Every broker call rechecks the enabled revision,
approved operation and targets, OAuth-profile access, action budget, and causal depth.

Read [Workflow lifecycle](docs/workflows.md), [Workflow authoring](docs/workflow-authoring.md), and
[Sandbox and capability security](docs/sandbox.md).

## Discord Gateway and interactions

`DISCORD_MCP_GATEWAY_MODE` may be `off`, `lazy`, or `eager`; the default is `lazy`.
`DISCORD_MCP_GATEWAY_INTENTS` defaults to `Guilds`. Privileged intents must be enabled in both the
environment and the Discord Developer Portal.

The interaction endpoint is `/discord/interactions` and is enabled by `DISCORD_PUBLIC_KEY`.
Signatures are checked against the exact raw body before JSON parsing. PING is answered immediately.
Slow workflow callbacks are deterministically deferred and later complete by editing the original
response. Opaque component handles bind an action to its owning workflow revision rather than
trusting model-authored custom IDs.

Read [Gateway and interactions](docs/gateway-interactions.md) and
[Discord permissions and intents](docs/discord-permissions.md).

## Security model in one minute

The control-plane server owns Discord credentials, encrypted secrets, and SQLite. It does not own a
Docker socket. The sandbox supervisor owns a runner-only rootless Docker socket but receives no
Discord token, OAuth token, client secret, encryption key, database, or MCP credential.

Workflow runners are:

- UID/GID 65532;
- read-only apart from bounded tmpfs and private Unix sockets;
- capability-free with `no-new-privileges`;
- limited to one CPU, 256 MiB memory, and 128 processes;
- started with `--network none`;
- mounted only to the exact published artifact and broker sockets.

The revision capability is delivered in a mode-0600 one-use bootstrap file that the trusted runner
unlinks before importing workflow code. It is not an environment variable. Published artifact
digests are rechecked before every start.

These controls isolate workflow code from control-plane secrets. They do not make a container
stronger than its host kernel or protect against a host administrator. For hostile native
dependencies, dedicate a separate VM or microVM and rootless daemon to the supervisor.

Read the full [Security model](docs/security.md).

## Persistence, operations, and recovery

SQLite runs in WAL mode and stores principals, PAT metadata, OAuth profiles, drafts and published
revisions, workflow queues and executions, event cursors, audit entries, bindings, and journals.
Blob bytes and workflow artifacts live in configured data directories.

Back up the following as one recovery set:

1. SQLite using its online backup mechanism, or the database plus WAL state while stopped;
2. blob and workflow artifact directories;
3. `DISCORD_MCP_MASTER_KEY`, stored separately;
4. deployment configuration without plaintext credentials.

Health endpoints are `/health/live` and `/health/ready`. Prometheus metrics are available from
`GET /metrics` with `audit:read`, and the same counters and gauges are available to MCP through
`discord_metrics_snapshot`. Structured logs go to stderr and recursively redact credentials,
message content, and body fields.

Read [Operator guide](docs/operator-guide.md), [Observability](docs/observability.md),
[Backups](docs/backups.md), [Recovery](docs/recovery.md), and
[Troubleshooting](docs/troubleshooting.md).

## Images and releases

The repository builds four images:

- `ghcr.io/OWNER/REPOSITORY` — control-plane server;
- `ghcr.io/OWNER/REPOSITORY-supervisor` — sandbox supervisor;
- `ghcr.io/OWNER/REPOSITORY-workflow-builder` — untrusted source builder;
- `ghcr.io/OWNER/REPOSITORY-workflow-runner` — untrusted workflow runner.

GitHub Actions first runs the verification job, then builds every image on native amd64 and arm64
runners. `main` and `v*` pushes publish multi-architecture manifests with SBOM and provenance
attestations. Tags are `sha-<commit>`, `edge` on the default branch, SemVer and `latest` on a version
tag.

## Development and verification

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm check
corepack pnpm typecheck
corepack pnpm test
corepack pnpm test:integration
```

The release gate is:

```sh
corepack pnpm release:check
```

It validates formatting, types, the pinned catalog, unit and integration tests, stdio purity,
Compose, the hostile sandbox, production builds, all MCP schemas and evaluation scenarios,
installable package tarballs, and the dependency audit.

With Docker and network access, run the stronger image gate:

```sh
corepack pnpm release:audit
```

The live Discord suite is opt-in and must target a disposable guild:

```sh
DISCORD_MCP_E2E=true \
DISCORD_TOKEN=... \
DISCORD_MCP_TEST_GUILD_ID=... \
DISCORD_MCP_TEST_CHANNEL_ID=... \
corepack pnpm test:e2e
```

Read [Testing](docs/testing.md) and [Live acceptance](docs/live-acceptance.md).

## Documentation

Start at the [documentation index](docs/README.md). It organizes the guides by reader goal and
links to architecture, setup, configuration, tools, every major feature, operations, security,
testing, and recovery.

`PLAN.md` is the implementation contract and historical acceptance plan; it is not required reading
for normal operation. The exact verified MCP v2 beta remains pinned until a compatible stable v2
release exists. UI/login, Social SDK, voice-media transport, horizontal replicas, and
Cloudflare/serverless deployment are not part of this product.

## License

The repository currently does not declare a top-level project license. The separately packaged
workflow SDK and presentation package include their own license files. Do not assume broader reuse
rights until a project license is added.
