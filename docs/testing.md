# Testing and release gates

The test strategy covers pure domain logic, protocol boundaries, persistence/restart behavior, real
container containment, package installation, image vulnerabilities, and opt-in live Discord
acceptance. A passing unit suite alone is not a release.

## Prerequisites

- Node.js 24 or newer;
- Corepack with the pinned pnpm 11.13.1;
- Docker for Compose, sandbox, image, and full release checks;
- a rootless cgroup v2 Docker daemon for the supported sandbox posture;
- network access for dependency audit, image builds/scans, spec drift, and live Discord tests.

Install:

```sh
corepack enable
corepack pnpm install --frozen-lockfile
```

## Fast local checks

```sh
corepack pnpm check
corepack pnpm typecheck
corepack pnpm test
```

- `check` runs Biome formatting/lint rules.
- `typecheck` builds TypeScript project references without emitting.
- `test` typechecks and runs the Vitest unit suite.

Run one test while developing:

```sh
corepack pnpm vitest run packages/discord-presentations/src/presentation.test.ts
```

## Offline integration checks

```sh
corepack pnpm test:integration
corepack pnpm test:stdio
corepack pnpm compose:check
corepack pnpm mcp:inspect
corepack pnpm pack:smoke
```

These cover boundaries that direct unit construction can miss:

- real MCP client/server calls and request-scoped identity;
- durable workflow tails and ownership through the protocol;
- stdout purity for stdio transport;
- Compose expansion without requiring a developer `.env`;
- the registered tool inventory and structured output schemas;
- twelve natural-language evaluation scenarios in `tests/evals/scenarios.json`;
- installation and execution from generated package tarballs.

`mcp:inspect` builds first. The Inspector gate confirms every expected tool is registered with the
intended schema and metadata.

## Discord catalog checks

```sh
corepack pnpm spec:check
corepack pnpm spec:drift
```

`spec:check` regenerates the 242-operation catalog in memory and fails when checked-in generated
output differs from the vendored pin.

`spec:drift` fetches upstream Discord OpenAPI state and reports additions, removals, and schema
changes. It is read-only: it never silently replaces the pin. Vendoring or regenerating a new pin is
a deliberate maintainer action followed by catalog review and the full release gate.

## Hostile sandbox check

```sh
corepack pnpm test:sandbox
```

This builds local workflow builder/runner images and sends a hostile fixture through the real
pipeline. It verifies:

- non-root builder and runner;
- read-only source, artifact, and root mounts;
- no direct runner network or host ports;
- no database, Docker socket, host paths, or control-plane credentials;
- PID and filesystem restrictions;
- dependency lifecycle scripts denied by default;
- a real cgroup memory-exhaustion kill.

Run it against the rootless daemon configuration intended for deployment. A skip or rootful
substitution does not establish the production guarantee.

## Production build

```sh
corepack pnpm build

docker build -f docker/server.Dockerfile -t discord-mcp/server:local .
docker build -f docker/supervisor.Dockerfile -t discord-mcp/supervisor:local .
docker build -f docker/workflow-builder.Dockerfile -t discord-mcp/workflow-builder:local .
docker build -f docker/workflow-runner.Dockerfile -t discord-mcp/workflow-runner:local .
docker compose config
```

The four images are separate deliverables. Server success does not prove the supervisor or sandbox
images build.

## One-command release gate

```sh
corepack pnpm release:check
```

It runs, in order:

1. Biome check;
2. TypeScript project references;
3. deterministic catalog check;
4. unit tests;
5. offline integration tests;
6. stdio purity;
7. Compose validation;
8. hostile sandbox;
9. production build;
10. MCP Inspector/evaluation inventory;
11. tarball installation smoke test;
12. dependency audit failing at moderate or higher.

Use this before tagging or merging a release candidate.

## Image vulnerability gate

```sh
corepack pnpm release:audit
```

This runs `release:check`, builds all four images fresh, and scans each with pinned Trivy 0.72.0. It
fails on any fixable HIGH or CRITICAL finding. The scanner discovers the active local Unix Docker
context, including rootless sockets, and refreshes base images/vulnerability data from the network.

An unfixed finding must be resolved by updating/rebuilding the relevant image or by an explicit,
reviewed policy decision outside the default gate. Do not hide it by scanning only the server image.

## Live Discord suite

`test:e2e` is opt-in and skips unless `DISCORD_MCP_E2E=true`:

```sh
DISCORD_MCP_E2E=true \
DISCORD_TOKEN=... \
DISCORD_MCP_TEST_GUILD_ID=... \
DISCORD_MCP_TEST_CHANNEL_ID=... \
corepack pnpm test:e2e
```

Use only a disposable guild. The harness verifies application access; legacy and Components V2
message lifecycles; typed template rendering; reactions; multipart files; and temporary
role/category/text/forum/voice creation, ordering, overwrites, and cleanup.

Optional destructive/negative targets:

- `DISCORD_MCP_TEST_MEMBER_ID` enables timeout/clear and ban/unban against a designated disposable
  member.
- `DISCORD_MCP_TEST_FORBIDDEN_CHANNEL_ID` expects a real permission-denied response.
- `DISCORD_MCP_TEST_OAUTH_TOKEN` verifies a user bearer against `/users/@me` without logging it.

The automated bot cannot safely impersonate a normal Discord client, complete browser OAuth, or prove
public proxy behavior. Use [Live acceptance](live-acceptance.md) for those checks.

## CI and GHCR

GitHub Actions runs frozen install and verification on pull requests. It builds native `amd64` and
`arm64` images without publishing PR artifacts. On `main` and `v*` tags it publishes the server,
supervisor, builder, and runner to GHCR with immutable commit tags, provenance, and SBOMs.

Release tags should be created only from a commit that passed `release:check`, image audit, and the
required live acceptance record.

## MCP dependency upgrade rule

The repository uses an exact MCP v2 beta cohort. Do not claim or repin to MCP v2 stable until the
packages actually exist in the npm registry. Verify dist-tags, update
`@modelcontextprotocol/server`, `client`, and `node` atomically, retain the compatible transitive
override if still needed, and run the complete release audit.

## Failure triage

When a gate fails, rerun the narrow command first and fix the earliest boundary:

- generated catalog drift: inspect the pin/generator before editing output;
- stdio pollution: remove all non-protocol stdout writes;
- Inspector failure: check tool registration, schema, toolset gates, and output shape;
- sandbox failure: treat credential/network/mount escape as a release blocker;
- package smoke failure: check package files/exports, not only workspace resolution;
- image finding: identify the owning base or package and rebuild all affected architectures;
- live cleanup failure: preserve IDs and manually clean the disposable guild before rerunning.

Record exact commands, image/commit digests, and whether live tests were skipped. Never report a
skipped credentialed gate as passed.
