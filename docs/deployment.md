# Deployment and Traefik

The supported architecture is permanently Docker-hosted: one control-plane server, one sandbox
supervisor, and isolated per-revision builder/runner containers. Horizontal control-plane scaling and
Cloudflare/serverless deployment are intentionally unsupported because workflows must be able to
install arbitrary npm packages and publish custom code without rebuilding the control plane.

The server container listens on port 3000. Compose publishes
`${HOST_BIND_ADDRESS:-127.0.0.1}:${HOST_PORT:-3000}` and also supplies Traefik labels for the
`websecure` entrypoint. A sample file-provider configuration is in
[traefik.example.yaml](traefik.example.yaml).

Set an HTTPS `PUBLIC_BASE_URL`, exact `ALLOWED_HOSTS`, and the CIDRs of proxies that are allowed to
supply forwarding data. Keep `TRUST_PROXY_IDENTITY=false` unless both
`TRUST_PROXY_IDENTITY_HEADER` and `TRUST_PROXY_GROUPS_HEADER` are set by the trusted proxy, the
forwarded identity is mapped to a stored principal, and forwarding traffic can arrive only from those
CIDRs. Their defaults are `x-forwarded-user` and `x-forwarded-groups`; requests missing either
configured header are rejected. CORS controls browser exposure, not authentication.

The sandbox supervisor must talk to a rootless Docker daemon. It is the only process with the socket;
the MCP server never mounts it. Compose bind-mounts `$PWD/data` and `$PWD/run` into the server and
supervisor and again at their absolute host paths so mounts derived by the supervisor resolve in the
host daemon namespace. Do not move or symlink these directories while runners exist.

Build:

```sh
docker context use rootless
docker compose --profile images build
docker compose config
docker compose up -d server supervisor
```

## Published GHCR images

GitHub Actions builds every image on pull requests without publishing it. A push to `main` publishes
an immutable `sha-<commit>` tag and the moving `edge` tag. A `v*` tag additionally publishes SemVer
tags and `latest`. Images include BuildKit provenance and an SBOM:

- `ghcr.io/OWNER/REPOSITORY`
- `ghcr.io/OWNER/REPOSITORY-supervisor`
- `ghcr.io/OWNER/REPOSITORY-workflow-builder`
- `ghcr.io/OWNER/REPOSITORY-workflow-runner`

The workflow authenticates with the repository-scoped `GITHUB_TOKEN`; no registry PAT is required.
New packages follow the repository/package visibility configured in GitHub. To deploy a release,
override the four Compose image names (or edit them in an override file), and set the two runtime
image variables to the exact published runner tags:

```sh
export RELEASE=1.0.0
export GHCR_BASE=ghcr.io/OWNER/REPOSITORY
export DISCORD_MCP_BUILDER_IMAGE="${GHCR_BASE}-workflow-builder:${RELEASE}"
export DISCORD_MCP_RUNNER_IMAGE="${GHCR_BASE}-workflow-runner:${RELEASE}"
docker pull "${GHCR_BASE}:${RELEASE}"
docker pull "${GHCR_BASE}-supervisor:${RELEASE}"
docker pull "$DISCORD_MCP_BUILDER_IMAGE"
docker pull "$DISCORD_MCP_RUNNER_IMAGE"
```

Runtime containers are non-root, read-only, capability-free, `no-new-privileges`, PID/memory/CPU
bounded, and have `--network none`. Control-plane secrets are never passed to them. The one-use
revision bootstrap is unlinked before workflow code loads, and only the private runner and capability
Unix sockets remain. Published artifact digests are rechecked by the supervisor immediately before
every runner start.

Two Traefik patterns are supported: route directly to the server container on port 3000 through a
shared network, or route to the loopback-published host port. Do not expose the published port on a
non-loopback address without TLS termination and the startup safety settings above.
