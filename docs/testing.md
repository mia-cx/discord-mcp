# Testing and release gates

`corepack pnpm release:check` runs formatting/linting, TypeScript project references, deterministic
catalog checks, unit and offline integration suites, stdio purity, Compose validation without needing
a local `.env`, hostile sandbox probes, a production build, full MCP tool inspection,
install-from-tarball package smoke tests, and a dependency audit that fails on moderate or higher
findings. MCP inspection also validates the twelve natural-language evaluation scenarios in
`tests/evals/scenarios.json` against the registered tool inventory; the cases record required and
forbidden agent behavior for model-evaluation runners.

The hostile sandbox probe performs a real cgroup memory-exhaustion kill in addition to checking
non-root execution, read-only mounts/root, no direct network or host ports, PID limits, absence of
host/database/Docker-socket access, credential absence, and default-denied dependency lifecycle
scripts.

`corepack pnpm release:audit` adds fresh builds of all four container images and a Trivy scan that
fails on any fixable HIGH or CRITICAL finding. It requires Docker and network access for base-image
and vulnerability-database refreshes. The scanner discovers the active local Unix Docker context, so
rootless Docker sockets are supported; the Trivy image itself is pinned by version and digest.

`spec:drift` is read-only and reports upstream operation additions, removals, and schema changes; it
never changes the pin. Network access is required.

`test:e2e` skips unless `DISCORD_MCP_E2E=true`. Use only a disposable guild and configure the
designated guild/channel IDs. The opt-in harness validates live bot/application access; legacy and
Components V2 message lifecycles; typed template rendering; reactions; multipart files; and temporary
role/category/text/forum/voice creation, ordering, overwrites, and cleanup. Optional destructive and
negative cases require explicit targets:

- `DISCORD_MCP_TEST_MEMBER_ID` enables timeout/clear and ban/unban against that disposable member.
- `DISCORD_MCP_TEST_FORBIDDEN_CHANNEL_ID` verifies a genuine permission-denied response.
- `DISCORD_MCP_TEST_OAUTH_TOKEN` verifies an OAuth bearer against `/users/@me`; it is never logged.

See `docs/live-acceptance.md` for the complete release checklist, including the Discord-client and
public-Traefik checks that cannot be safely driven by an automated bot test.

Container validation:

```sh
docker build -f docker/server.Dockerfile -t discord-mcp/server:local .
docker build -f docker/supervisor.Dockerfile -t discord-mcp/supervisor:local .
docker build -f docker/workflow-builder.Dockerfile -t discord-mcp/workflow-builder:local .
docker build -f docker/workflow-runner.Dockerfile -t discord-mcp/workflow-runner:local .
docker compose config
```

The release must not claim MCP v2 stable until the package exists. Verify npm dist-tags and update all
MCP packages atomically behind the full suite.
