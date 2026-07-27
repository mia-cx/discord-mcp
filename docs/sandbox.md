# Sandbox and capability security

The workflow subsystem is designed around a hard rule: untrusted workflow code must not receive the
Discord bot token, OAuth tokens, application secrets, MCP credentials, master key, SQLite database,
control-plane environment, or a Docker socket.

The control plane, supervisor, builder, and runner are separate processes with different authority.
See [Architecture](architecture.md) for the full data flow and [Security model](security.md) for the
broader threat model.

## Trust boundaries

| Component | Trusted with | Deliberately denied |
| --- | --- | --- |
| Control-plane server | Discord credentials, MCP identities, master key, database, capability policy | Docker daemon socket |
| Sandbox supervisor | Runner-only rootless Docker socket, artifact and runtime directories, supervisor credential | Discord credentials, master key, database, server environment |
| Builder container | One revision's source, dependency metadata, SDK files, writable output | Runtime credential, Discord/MCP secrets, database, Docker socket, server source |
| Runner container | Read-only built artifact, private capability socket, one-use revision identity | Network, Docker socket, host filesystem, control-plane credentials and data |

The Docker socket is root-equivalent for its daemon. Give the supervisor a dedicated rootless daemon;
do not share a general-purpose developer or production daemon.

## Build isolation

The supervisor writes a revision's inputs to a supervisor-owned host directory before starting the
builder. It mounts source read-only and a separate output directory read-write. The builder runs as
UID 65532 with:

- all Linux capabilities dropped;
- `no-new-privileges`;
- 512 MiB of memory, one CPU, and 128 processes;
- only the revision inputs and output path mounted;
- dependency lifecycle scripts disabled unless an administrator explicitly enables them for the
  validation;
- a five-minute deadline.

After the build, the control plane records a content digest and enforces the 20 MiB artifact limit.
Publishing freezes the source, dependency declaration, lockfile, manifest, and artifact digest.

Build dependencies are untrusted too. A malicious install script can attack the builder, so lifecycle
scripts stay off by default. If a package genuinely needs them, review the exact package and lockfile;
the validator requires `workflow:admin` to enable scripts. Record the same decision in the revision
grant and treat it as an expansion of the threat surface.

## Runner isolation

Each enabled revision runs in a dedicated container as UID 65532 with:

- a read-only root filesystem;
- the artifact mounted read-only;
- a 32 MiB `noexec,nosuid` tmpfs at `/tmp`;
- `--network none`;
- all Linux capabilities dropped;
- `no-new-privileges`;
- 256 MiB of memory, one CPU, and 128 processes;
- a forced execution deadline;
- only private runner and capability Unix sockets mounted.

The supervisor derives container names, image names, mounts, networking, and resource limits.
Workflow input cannot supply Docker arguments or host paths. The supervisor recalculates the
published artifact digest immediately before every runner start and refuses a mismatch.

## Credential handoff

A runner needs an identity so the broker can distinguish one enabled revision from another. That
identity and its random revision credential are not environment variables. The supervisor writes
them to a mode-`0600` bootstrap file. Trusted runner startup code reads and unlinks the file before it
imports the workflow module.

Consequences:

- `docker inspect` does not reveal the credential;
- `/proc/self/environ` does not reveal it;
- workflow imports do not run until the bootstrap path is gone;
- the credential is scoped to one workflow and revision, not to Discord directly.

As defense in depth, startup also deletes every `DISCORD_*` variable from the JavaScript process
environment before loading workflow code.

## Capability broker

The runner can request actions only through its private capability socket. On every request the
control plane verifies:

- the runner credential and owning workflow revision;
- that the same revision is still enabled;
- the approved Discord operation IDs and OAuth profile IDs;
- guild, channel, and other target restrictions;
- broad-mention permission;
- action budget and execution deadline;
- correlation, causation, and maximum causal depth;
- HTTPS hostname grants for outbound HTTP;
- workflow ownership for KV, logs, components, and interactions.

The broker returns operation results, never an underlying Discord credential. Disabling a workflow
causes new capability calls to fail immediately, even while an existing handler is draining.

## Supervisor startup preflight

The supervisor refuses to serve until the daemon proves that it is rootless and that cgroup v2
memory and PID enforcement work. Some daemon configurations accept limit flags without enforcing
them; the preflight exists to catch that silent failure.

`DISCORD_MCP_ALLOW_ROOTFUL_DOCKER=true` bypasses the rootless requirement for isolated development.
It weakens the supported security posture and should not be used for production.

## What the sandbox does and does not guarantee

It prevents ordinary workflow code from discovering control-plane secrets because those bytes never
enter the runner image, environment, mounts, or memory. It also constrains persistence, process
creation, network access, and resource exhaustion.

It does not protect against:

- a compromised host administrator;
- a Docker or kernel escape;
- a compromised supervisor or runner base image;
- a malicious native dependency exploiting the container runtime;
- an operator deliberately mounting secrets into a runner;
- traffic permitted by an overly broad capability grant.

For hostile multi-tenant code, put the runner-only daemon and supervisor on a separate VM or microVM.
The Compose topology is a strong application boundary, not a replacement for a separate kernel trust
boundary.

## Verifying the boundary

Run the hostile workflow suite against the same daemon configuration used in production:

```sh
corepack pnpm test:sandbox
```

The fixture enters through the real build-and-run pipeline and attempts to read secret-like
environment variables and host files, open a network connection, write outside allowed paths, create
excess processes, and exhaust memory. The test expects containment and a real cgroup OOM kill.

Also inspect a running revision:

```sh
docker inspect RUNNER_CONTAINER
docker exec RUNNER_CONTAINER sh -c 'id && mount && env'
```

Do not paste the resulting environment into an issue or chat without reviewing it. The expected
result is a non-root identity, read-only root/artifact mounts, no network, no Docker socket, and no
Discord or control-plane credential.
