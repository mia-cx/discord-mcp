# Security model

The control-plane server alone owns Discord bot/OAuth credentials, the encryption master key, and
SQLite. The sandbox supervisor receives none of those values; it alone owns the runner-only rootless
Docker socket. Workflow source and installed workflow dependencies are untrusted.

Runtime containers use a non-root UID, read-only root and artifact mounts, ephemeral `/tmp`, no
network, no capabilities, `no-new-privileges`, PID/memory/CPU caps, and a forced deadline. They never
receive the bot token, OAuth/client secrets, master key, supervisor credential, database, Docker
socket, or the control-plane environment. Names, images, mounts, networks, and resource limits are
derived by the supervisor and cannot be supplied by workflow input.

Runner identity and its random revision-scoped capability credential are not Docker environment
variables. The supervisor writes them to a mode-`0600`, one-use bootstrap file; the trusted runner
reads and unlinks it before importing workflow code. This keeps them out of image configuration,
`docker inspect`, and `/proc/*/environ`. As defense in depth, the runner also removes every
`DISCORD_*` key from its JavaScript environment before workflow import. The revision credential is
intentionally the runner's only authority. The broker rechecks enabled revision, grants, target
guild/channel/profile, action budget, and causal
depth on each call. It never returns an underlying Discord credential. Mutating Discord results are
associated with the exact workflow execution; matching Gateway events inherit the root correlation
ID, execution causation ID, and incremented depth. Gateway dispatches are deduplicated by shard
sequence, never by reusable message/entity ID.

Build containers receive source, dependency metadata, and SDK files only. They receive no Discord/MCP
credential, database, production secret, Docker socket, or control-plane source. Dependency lifecycle
scripts are disabled unless separately granted. Artifacts are content-addressed and size checked.

Remote MCP input never accepts filesystem paths. Discord requests resolve catalog operation IDs, not
arbitrary URLs or authorization headers. Destructive and bot-admin calls require single-use,
60-second previews bound to principal, normalized arguments, operation, auth profile, and targets.
Blueprint previews also bind the immutable revision, exact actions, and current snapshot digest.

Logs and audit details recursively redact tokens, secrets, authorization headers, message content,
and blob/attachment bodies. Credential-bearing webhook route segments are redacted from Discord
errors. Rotate secrets if process memory or the SQLite/master-key pair is compromised.

Security guarantees assume the intentionally single active control-plane replica, a trusted
supervisor, a correctly configured rootless Docker daemon, trusted TLS termination, and protected
host access. A Docker socket controls every container on its daemon. For the strongest boundary, give
the supervisor a runner-only daemon on a separate VM or microVM so even a supervisor compromise
cannot inspect or replace the control-plane server.

This boundary prevents workflow code from discovering control-plane secrets because the secret bytes
never enter the runner's image, environment, mounts, or process memory. It is not a claim that a
container can defeat its host administrator, a compromised kernel/runtime, or a container escape.
That separate VM/microVM is also the recommended additional kernel boundary for hostile native
dependencies. Rootful Docker, Social SDK, and voice media are outside v1 guarantees.
Multiple active replicas and serverless/Cloudflare deployment are permanently out of scope; the
isolated Docker workflow runtime is the product architecture.

The workspace pins the MCP beta's transitive `@hono/node-server` dependency to the compatible fixed
`2.0.10` release through the pnpm workspace override. `pnpm audit --audit-level moderate` is a
release-blocking gate; v1 has no accepted moderate-or-higher dependency advisory.
