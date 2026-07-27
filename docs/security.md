# Security model

`discord-mcp` mediates high-impact Discord administration and executes operator-supplied workflow
code. Its security model combines identity scopes, Discord permission checks, one-use previews,
immutable resources, encrypted secrets, durable audit, and a capability-based container sandbox.

This guide states the trust boundaries and assumptions. [Sandbox and capability security](sandbox.md)
describes the builder/runner mechanics in more depth.

## Protected assets

The control plane protects:

- the Discord bot token;
- Discord OAuth access and refresh tokens;
- the Discord application/client secret and interaction public-key configuration;
- MCP PATs and OIDC/proxy identities;
- `DISCORD_MCP_MASTER_KEY`;
- the supervisor credential;
- workflow route and webhook named secrets;
- SQLite, blobs, workflow artifacts, and audit history;
- the rootless Docker socket;
- guild administration authority.

No workflow functionality requires giving untrusted code one of these assets directly.

## Trust model

Trusted:

- the host kernel and administrator;
- the control-plane server image and configuration;
- the sandbox supervisor image and its dedicated daemon;
- the TLS reverse proxy and explicitly trusted proxy network;
- the operator approving scopes, previews, blueprints, dependencies, and workflow grants.

Untrusted:

- MCP request arguments;
- remote HTTP request bodies and forwarding headers;
- Discord event and interaction payloads until verified;
- workflow source and installed workflow dependencies;
- message/template variables;
- arbitrary Discord API catalog responses.

Workflow builder and runner containers are containment mechanisms for untrusted code, not trusted
application components.

## Layered authorization

An action can pass through several independent checks:

1. The transport authenticates an MCP principal.
2. The tool requires a local scope.
3. Resource ownership or an administrator rule limits which stored object is visible.
4. Risky Discord calls require a one-use preview bound to normalized arguments and targets.
5. Workflow calls require an enabled, revision-specific grant and action budget.
6. Presentation policy validates mentions, components, attachments, and response shape.
7. Discord enforces guild permissions, channel overwrites, role hierarchy, and credential type.

A broad Discord bot permission does not add an MCP scope. An MCP administrator scope does not bypass
Discord. A workflow's requested grants do not authorize it.

## Credential separation

The server alone receives Discord bot/OAuth credentials, the master key, database, and control-plane
environment. It never mounts a Docker socket.

The supervisor alone receives the runner-only rootless Docker socket and supervisor credential. It
does not receive the Discord token, OAuth/client secret, master key, database, or server environment.

Builders receive only revision source/dependency inputs and output storage. Runners receive only a
read-only artifact, private Unix sockets, and a one-use revision identity. The revision credential is
written to a mode-`0600` bootstrap file and deleted before workflow imports execute; it is not a
Docker environment variable.

The broker checks that revision credential on every call and never returns an underlying Discord
credential.

## Remote input constraints

- Remote MCP tools never accept a local filesystem path.
- Discord API dispatch selects a vendored operation ID, not an arbitrary URL or Authorization header.
- HTTP request bodies are byte-capped before use.
- Exact Discord interaction bodies are verified with Ed25519 and a bounded timestamp.
- Workflow HMAC routes sign the exact raw body, expire after five minutes, and reject replays.
- Host, forwarded protocol, and forwarding chain are validated before protected routing; workflow
  routes also enforce their configured Origin policy.
- Trusted proxy identity is rejected unless the immediate peer is in an explicit CIDR.

The server passes each authenticated principal through the request-scoped MCP authentication carrier;
it does not store caller identity in a mutable process-global slot.

## Risk previews

Destructive and bot-administrator operations require `discord_api_preview` or the matching semantic
tool preview. The token is:

- bound to the principal;
- bound to the operation, auth profile, normalized arguments, and resolved targets;
- valid for 60 seconds;
- single-use.

Blueprint previews also bind the immutable blueprint revision, current snapshot digest, ordered action
list, and current Discord state. Apply takes a fresh snapshot and refuses stale plans.

Preview tokens make intent explicit and prevent argument substitution. They do not make an approved
destructive action reversible.

## Presentation and mention policy

Message and modal schemas reject unknown/invalid combinations before Discord. Broad mentions are
denied unless the principal has `mentions:broad` or the workflow grant explicitly allows them.
Components use opaque ownership handles so a workflow or template cannot claim another owner's
interaction.

Audit and structured-log redaction treats tokens, secrets, authorization, credentials, message
content, bodies, and base64-like fields as sensitive. Blob/attachment bytes are never returned
through MCP.

## Encryption at rest

Discord OAuth tokens and named secrets are encrypted with AES-256-GCM under the 32-byte
`DISCORD_MCP_MASTER_KEY`. The key must be stored separately from SQLite. PATs are stored only as
Argon2id hashes and cannot be recovered.

Encryption at rest does not protect secrets if both the running server and master key are
compromised. Rotate upstream credentials after a process-memory or database-plus-key compromise.

## Sandbox posture

Runtime containers are non-root, read-only, capability-free, `no-new-privileges`, PID/memory/CPU
bounded, deadline-bound, and have no network. Names, images, mounts, and limits are supervisor-derived.
Artifact digests are rechecked before start. The supervisor refuses a daemon that cannot prove
rootless mode and cgroup v2 memory/PID enforcement.

The hostile sandbox suite attacks the real build-and-run path. It checks secret absence, filesystem
and network isolation, non-root execution, process limits, lifecycle-script denial, and a real memory
exhaustion kill.

## Deployment assumptions

Security guarantees assume:

- exactly one active control-plane replica;
- TLS termination at a trusted proxy;
- exact allowed hosts and correct trusted-proxy CIDRs;
- no direct access around the proxy for identity-header deployments;
- protected host filesystem, database, `.env`, backup, and Unix-socket permissions;
- a dedicated rootless runner daemon;
- reviewed images and dependency lockfile;
- no operator-added mounts or environment variables that weaken runner isolation.

Horizontal replicas and Cloudflare/serverless deployment are permanently outside the architecture.
Rootful Docker is supported only as an explicit development override.

## Explicit non-goals

The sandbox cannot defend against a malicious host administrator, compromised kernel/runtime,
container escape, or compromised trusted image. A Docker socket controls every container on its
daemon.

For a stronger boundary, place the supervisor and runner-only daemon on a separate VM or microVM.
This is especially important for hostile native dependencies or mutually untrusted tenants.

Social SDK integration and voice media transport are not v1 security guarantees.

## Dependency and release security

The workspace pins the exact verified MCP beta cohort and overrides its transitive
`@hono/node-server` dependency to fixed `2.0.10`. Do not replace that cohort with a guessed stable
version. Upgrade the MCP packages atomically only after the intended release exists and passes the
full suite.

Release gates include:

- frozen dependency installation;
- deterministic vendored Discord catalog generation;
- offline integration, stdio purity, hostile sandbox, Inspector, and package-install smoke tests;
- `pnpm audit --audit-level moderate`;
- Trivy scans of all four built images that fail on fixable HIGH or CRITICAL findings;
- generated image provenance and SBOMs in GHCR.

## Incident triggers

Treat these as security incidents:

- any Discord/MCP/master/supervisor credential visible to workflow code;
- a runner with direct network, Docker socket, database, or unexpected host mount access;
- interaction signatures succeeding after body modification;
- trusted identity headers accepted from an untrusted peer;
- unexplained destructive previews or audit principal mismatches;
- artifact digest mismatch;
- evidence of database plus master-key exfiltration;
- a second active control plane using production state.

Preserve immutable source/artifact digests and redacted audit/log evidence, then follow
[Recovery](recovery.md).
