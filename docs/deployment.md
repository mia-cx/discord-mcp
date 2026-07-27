# Deployment

The supported production architecture is Docker-hosted: one control-plane server, one sandbox
supervisor, and isolated per-revision builder/runner containers. Horizontal control-plane scaling and
Cloudflare/serverless deployment are permanently unsupported. Workflows are designed to install npm
packages and publish custom code without rebuilding the control plane, which requires the container
sandbox architecture.

Start with [Setup](setup.md), then use this guide to harden and expose the service.

## Production topology

```text
MCP clients / Discord
          |
      HTTPS proxy
          |
   server container ─── SQLite + blobs + artifacts
          |
  private Unix sockets
          |
 supervisor container ─── dedicated rootless Docker daemon
                                |
                       builders and runners
```

Only the server receives bot/OAuth credentials and the master key. Only the supervisor receives the
Docker socket. The proxy should reach the server on port 3000 through a private Docker network or the
loopback-published host port.

## Host preparation

Use a Linux host with cgroup v2 and a dedicated rootless Docker daemon for UID 65532 or another
unprivileged runtime account. Resolve the daemon socket and group:

```sh
docker context inspect rootless
stat -c '%g' /run/user/1000/docker.sock
```

Create persistent paths from the directory containing `compose.yaml`:

```sh
mkdir -p data run
sudo chown -R 65532:65532 data run
chmod 700 data run
```

These are bind-mounted both at their container locations and at the same absolute host paths. The
duplication is intentional: the rootless daemon resolves workflow artifact and Unix-socket mounts in
the host namespace. Do not move, rename, or replace them with symlinks while runners exist.

## Secret and environment preparation

Copy `.env.example` to `.env`, then set at minimum:

```dotenv
DISCORD_TOKEN=...
DISCORD_MCP_MASTER_KEY=...
DISCORD_MCP_SUPERVISOR_CREDENTIAL=...
ROOTLESS_DOCKER_SOCKET=/run/user/1000/docker.sock
ROOTLESS_DOCKER_GID=1000
DISCORD_MCP_HOST=discord-mcp.example.com
PUBLIC_BASE_URL=https://discord-mcp.example.com
ALLOWED_HOSTS=discord-mcp.example.com
TRUSTED_PROXY_CIDRS=172.18.0.0/16
```

Generate independent values:

```sh
openssl rand -base64 32
openssl rand -hex 32
```

Use the base64 value for `DISCORD_MCP_MASTER_KEY` and the hex value for
`DISCORD_MCP_SUPERVISOR_CREDENTIAL`. Store `.env` with mode `0600` and in a secret manager or
encrypted backup, not in Git.

Read [Configuration reference](configuration.md) before changing resource limits, Gateway intents,
proxy identity, or public origin settings.

## Build and start

For local images:

```sh
docker context use rootless
docker compose --profile images build
docker compose config
docker compose up -d server supervisor
```

Inspect startup:

```sh
docker compose ps
docker compose logs --tail=200 server supervisor
curl --fail http://127.0.0.1:3000/health/ready
```

The supervisor preflights rootless mode and real cgroup memory/PID enforcement before accepting
work. Do not use `DISCORD_MCP_ALLOW_ROOTFUL_DOCKER=true` in production.

## Reverse proxy and TLS

The Compose labels describe a Traefik router named `discord-mcp` on the `websecure` entrypoint. Two
patterns are supported:

1. Attach Traefik and the server to a shared private network and route to container port 3000.
2. Route Traefik on the host to `${HOST_BIND_ADDRESS}:${HOST_PORT}`, leaving the bind address at
   `127.0.0.1`.

A file-provider starting point is [traefik.example.yaml](traefik.example.yaml). Adapt its certificate
resolver, network, and host names to your deployment.

Required public-safety behavior:

- terminate TLS before requests reach the server;
- set `PUBLIC_BASE_URL` to the external HTTPS origin;
- list exact hostnames in `ALLOWED_HOSTS`;
- list only proxy source ranges in `TRUSTED_PROXY_CIDRS`;
- prevent direct network access to port 3000;
- preserve exact request bodies for `/discord/interactions` and HMAC workflow routes;
- allow request bodies up to configured limits, but not unbounded buffering;
- pass `X-Forwarded-Proto: https`, an allowed forwarded host, and a correct forwarding chain.

Do not enable trusted proxy identity until its headers are stripped from incoming traffic and set by
the proxy itself. See [Authentication and authorization](authentication.md).

## Published GHCR images

GitHub Actions builds all four images on pull requests without publishing. A push to `main` publishes
an immutable `sha-<commit>` tag plus `edge`. A `v*` tag also publishes SemVer tags and `latest`:

- `ghcr.io/OWNER/REPOSITORY`
- `ghcr.io/OWNER/REPOSITORY-supervisor`
- `ghcr.io/OWNER/REPOSITORY-workflow-builder`
- `ghcr.io/OWNER/REPOSITORY-workflow-runner`

Images are multi-architecture for `linux/amd64` and `linux/arm64` and include BuildKit provenance and
an SBOM. The workflow publishes with the repository-scoped `GITHUB_TOKEN`; package visibility follows
GitHub repository/package settings.

Pin all four components to the same immutable release or commit tag. In particular, the supervisor
must be told the exact builder and runner tags it should launch:

```sh
export RELEASE_TAG=sha-0123456789abcdef
export GHCR_BASE=ghcr.io/OWNER/REPOSITORY

export DISCORD_MCP_BUILDER_IMAGE="${GHCR_BASE}-workflow-builder:${RELEASE_TAG}"
export DISCORD_MCP_RUNNER_IMAGE="${GHCR_BASE}-workflow-runner:${RELEASE_TAG}"

docker pull "${GHCR_BASE}:${RELEASE_TAG}"
docker pull "${GHCR_BASE}-supervisor:${RELEASE_TAG}"
docker pull "$DISCORD_MCP_BUILDER_IMAGE"
docker pull "$DISCORD_MCP_RUNNER_IMAGE"
```

Use a Compose override to replace the server and supervisor `image` values. Avoid moving tags such as
`edge` and `latest` for a controlled deployment.

## Upgrade procedure

1. Read release notes and back up SQLite, blobs, artifacts, and the master key.
2. Pull all four images for one immutable release.
3. Keep the existing `data` and `run` paths and environment.
4. Stop public traffic or put the proxy in maintenance mode.
5. Recreate the server and supervisor.
6. Watch migrations and supervisor preflight in logs.
7. Check readiness, authenticated MCP, metrics, Gateway status, and one disposable workflow.
8. Restore public traffic.

Database migrations are forward-applied at startup. Do not downgrade against a migrated database
without restoring a backup made by the older version.

## Network and firewall policy

The server needs outbound HTTPS to Discord, configured OIDC JWKS, and OAuth token endpoints. The
supervisor needs only its rootless Docker socket and local filesystem/socket paths. Builder network
access is needed for dependency installation; runners always use `--network none`, and brokered
`Http.fetch` originates from the control plane after grant validation.

At the host firewall:

- expose only the HTTPS proxy;
- keep the MCP port loopback/private;
- do not expose rootless Docker or Unix sockets;
- restrict administrative SSH and backup access;
- consider a separate VM/microVM for the runner daemon.

## Persistent data

The deployment is stateful:

- `data/discord-mcp.sqlite` contains principals, grants, metadata, queues, executions, and audit;
- `data/blobs` contains content-addressed uploads;
- `data/artifacts` contains immutable workflow build artifacts;
- `run` contains private transient Unix sockets.

Back up `data`; do not back up live socket files in `run`. The master key must be backed up separately.
See [Backups](backups.md) and [Recovery](recovery.md).

## Single-replica rule

Exactly one active server may own the database, Gateway session, interactions, route registry, and
workflow scheduling. Never start a restored copy, staging clone, or second Compose project against
the same Discord application and production state while the original is active.
