# Architecture

## The product boundary

`discord-mcp` has two jobs:

1. expose Discord and control-plane operations as typed MCP tools;
2. execute user-authored TypeScript automation without putting control-plane secrets in the
   workflow process.

Those jobs intentionally live in separate processes. The server owns application state and
credentials. The supervisor owns the Docker socket. A runner owns only one immutable workflow
revision and a narrow broker credential.

```text
MCP client
    │  stdio or authenticated Streamable HTTP
    ▼
control-plane server ───── Discord REST / Gateway / OAuth
    │     │
    │     ├── SQLite, blobs, immutable workflow artifacts
    │     └── capability broker Unix socket
    │
    └── authenticated supervisor Unix socket
              │
              ▼
       rootless Docker daemon
          ├── builder container (per validation/build)
          └── runner container (per enabled revision)
```

The control plane is stateful and single-active. SQLite journals blueprint execution, workflow
queues, revisions, grants, bindings, event cursors, interactions, and audit history. Starting two
active servers against one Discord application and data set would create competing Gateway sessions,
duplicate schedules, and ambiguous ownership. Multiple active replicas are therefore unsupported by
design.

## Components

### Control-plane server

The server:

- serves MCP over stdio or Streamable HTTP;
- authenticates HTTP callers and enforces local scopes;
- owns the Discord bot token and optional Discord OAuth profiles;
- validates and dispatches the pinned Discord REST catalog;
- manages presentations, templates, blueprints, blobs, secrets, and workflows;
- owns the Gateway connection and Discord interaction endpoint;
- owns SQLite and the blob/artifact metadata;
- runs the capability broker used by workflows;
- exports health, metrics, audit, and structured logs.

The server never receives a Docker socket.

### Sandbox supervisor

The supervisor accepts authenticated build, start, stop, inspect, and destroy requests over a Unix
socket. It is the only service with access to the rootless Docker socket. It derives container names,
mounts, images, security options, and resource limits; callers cannot supply arbitrary Docker flags
or host paths.

Startup inspects the daemon and requires:

- rootless mode, unless explicitly overridden for isolated development;
- cgroup v2;
- effective memory-limit support;
- effective PID-limit support.

### Workflow builder

A builder container receives only the workflow source, dependency manifest, workflow SDK, and
presentation package. It performs a deterministic install and TypeScript build, emits a compiled
manifest and artifact, and never receives Discord credentials, database access, the control-plane
source, or a Docker socket.

Dependency lifecycle scripts are disabled unless a workflow administrator explicitly enables them
for validation and the revision grant records that decision.

### Workflow runner

One runner represents one enabled published revision. It imports a content-addressed artifact after
consuming and unlinking a one-use bootstrap file. It communicates with:

- the capability broker for Discord, KV, HTTP, logging, clock, and execution operations;
- a private runner socket used by the runtime manager.

It has no direct network interface and no control-plane environment.

## Data ownership

| Data | Owner | Storage |
| --- | --- | --- |
| Bot token and client secret | Server process/deployment secret store | Environment only |
| PAT verifier hashes | Server | SQLite |
| OAuth access and refresh tokens | Server | AES-256-GCM ciphertext in SQLite |
| Named route or webhook secrets | Server | AES-256-GCM ciphertext in SQLite |
| Templates and blueprints | Server | Drafts and immutable revisions in SQLite |
| Workflow source, manifests, grants, queues, executions | Server | SQLite |
| Blob bytes | Server | Configured blob directory |
| Workflow build artifacts | Server/supervisor | Content-addressed artifact directory |
| Docker socket | Supervisor | Host bind mount |
| Runner revision credential | Runner and broker | One-use file, then process memory |

## Request paths

### MCP request

An HTTP request is authenticated into MCP `AuthInfo`. The server factory derives a principal from
that request-local carrier and builds the tool handlers around it. Tool execution then checks:

1. whether the toolset exposes the tool;
2. whether the principal has the required local scope;
3. tool-specific ownership or target checks;
4. Discord permissions and Discord-side authorization.

### Discord operation

Curated tools normalize a narrow semantic input. Catalog tools resolve an operation ID from the
vendored spec. The dispatcher rejects unknown parameters, raw credentials, arbitrary URLs, and
sensitive fields supplied directly. Risk determines which local dispatcher and preview controls are
required.

### Workflow execution

A trigger is inserted into a durable SQLite queue. The runtime manager applies per-workflow
concurrency, starts or reuses the exact revision runner, and sends the event. Every broker request
checks the currently enabled revision, its grant, targets, action budget, and causal depth before the
server performs an operation.

## Why Docker, not serverless

Workflows may install arbitrary npm packages and publish custom code without rebuilding the control
plane. They need a real build environment, immutable artifact storage, process limits, and private
Unix sockets. Those requirements are the product architecture, not a temporary implementation
detail. Cloudflare/serverless deployment and horizontal control-plane scaling are permanently out of
scope.

## Compatibility foundation

The repository pins one verified cohort of Effect v4, TypeScript, and the MCP v2 beta. Schemas are
compiled eagerly during server construction so a malformed tool fails startup rather than breaking
tool discovery after deployment. See [ADR 0001](architecture/0001-beta-foundations.md).
