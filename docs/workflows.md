# Workflow lifecycle

Workflows are immutable, grant-scoped TypeScript automations. The control plane stores drafts,
builds them in an isolated container, publishes content-addressed revisions, approves capabilities
per revision, and runs only the enabled artifact.

They are not autonomous LLM sessions. A trigger runs a TypeScript handler and records its result; it
does not ask a model for another turn or continue an MCP client's conversation.

This page covers lifecycle and operations. See [Workflow authoring](workflow-authoring.md) for code
and [Sandbox and capability security](sandbox.md) for isolation.

## Requirements

Workflow validation and execution require:

- the server and sandbox supervisor;
- the shared supervisor credential;
- shared artifact and runtime directories;
- a rootless Docker daemon with cgroup v2 resource enforcement;
- the builder and runner images.

Without the supervisor credential, workflow metadata tools remain available but validate/build fails
with “workflow sandbox is unavailable.”

## Lifecycle

```text
draft source + dependencies
          ↓ validate/build
compiled manifest + content-addressed artifact
          ↓ publish
immutable revision
          ↓ approve grant
revision-specific authority
          ↓ enable
registered triggers + running revision
```

Tools:

- `discord_workflow_list`
- `discord_workflow_get`
- `discord_workflow_create`
- `discord_workflow_update_draft`
- `discord_workflow_validate`
- `discord_workflow_publish`
- `discord_workflow_grant`
- `discord_workflow_enable`
- `discord_workflow_disable`
- `discord_workflow_rollback`
- `discord_workflow_delete`
- `discord_workflow_invoke`
- `discord_workflow_execution_get`
- `discord_workflow_executions_tail`

Reads require `workflow:read`, draft mutation requires `workflow:write`, and grant/enable/disable/
rollback/delete require `workflow:admin`.

## Create and update a draft

Create supplies a slug, display name, TypeScript source, and exact direct dependencies:

```json
{
  "slug": "release-notifier",
  "name": "Release notifier",
  "source": "import { Trigger, Workflow } from '@discord-mcp/workflow-sdk' ...",
  "dependencies": {
    "semver": "7.7.2"
  }
}
```

The SDK and presentation package are available to the build. Dependencies should use exact versions
for reproducibility. Updating the draft does not change any published or enabled revision.

Limits:

- source: 256 KiB;
- direct dependencies: 100;
- compiled manifest: 1 MiB and 1–1,000 triggers;
- build time: five minutes;
- artifact: 20 MiB.

## Validate and build

Validate sends the draft to a one-shot builder container. The builder:

1. creates a clean package;
2. installs exact dependencies;
3. disables lifecycle scripts unless validation explicitly requests them and the caller also has
   `workflow:admin`;
4. compiles TypeScript;
5. imports and validates the default workflow definition;
6. emits a normalized manifest, lockfile, diagnostics, artifact, and SHA-256 digest.

Validation does not publish. Use it repeatedly while developing.

Requested grants in source are checked for shape and compared with the approved grant, but they never
grant authority themselves.

## Publish

Publish freezes:

- source;
- exact dependency map;
- generated lockfile;
- compiled manifest;
- artifact digest;
- build diagnostics;
- revision number.

The artifact is immutable and content-addressed. The supervisor recomputes its digest before every
runner start. A published revision can be inspected and rolled back to without rebuilding.

## Approve a grant

The grant is an independent operator decision:

```json
{
  "discord": {
    "operationIds": ["create_message"],
    "operationFamilies": [],
    "guildIds": ["12345678901234567"],
    "channelIds": ["12345678901234568"],
    "oauthProfileIds": [],
    "botAdmin": false,
    "broadMentions": false,
    "maxActionsPerMinute": 30
  },
  "gateway": {
    "eventTypes": ["MESSAGE_CREATE"],
    "includeBotAuthoredEvents": false
  },
  "interactions": {
    "guildCommandPublishing": true,
    "globalCommandPublishing": false
  },
  "routes": {
    "public": false,
    "allowedHosts": [],
    "allowedOrigins": [],
    "allowedSourceCidrs": [],
    "maxBodyBytes": 65536
  },
  "network": {
    "allowedOutboundHosts": ["status.example.com"]
  },
  "runtime": {
    "allowNpmInstallScripts": false,
    "timeoutSeconds": 30,
    "concurrency": 1
  }
}
```

Empty lists mean no access, not unrestricted access.

### Discord grant

- `operationIds` names exact pinned Discord operations.
- `operationFamilies` authorizes a classified family when maintaining individual IDs is impractical.
- `guildIds` and `channelIds` constrain targets.
- `oauthProfileIds` constrains user-context credentials.
- `botAdmin` allows bot-administration risk.
- `broadMentions` allows non-empty mention parsing.
- `maxActionsPerMinute` limits mutating Discord calls.

### Gateway grant

Only listed event types are delivered. Bot-authored events are excluded unless explicitly allowed.
Configured Gateway intents must cover the list.

### Interaction grant

Guild and global command publication are separate because global replacement affects the whole
application and propagates more slowly.

### Route grant

`public` permits an unauthenticated `none` route. Host, origin, source CIDR, and body-size policy are
still enforced. Authenticated routes do not require `public: true`.

### Network grant

Runtime has no direct network. `Http.fetch` may make HTTPS requests only to exact allowed hosts.
Redirect and resolved-target checks remain broker-controlled.

### Runtime grant

- install scripts are off by default;
- timeout is 1–300 seconds;
- concurrency is 1–8.

If validation enabled install scripts, the approved revision grant should explicitly preserve that
decision through `runtime.allowNpmInstallScripts`.

The approved grant must cover every request declared in source. It may be narrower only after source
is changed and rebuilt.

## Enable

Enable verifies:

- the revision is published;
- a grant exists for that exact revision;
- the grant covers requested capabilities;
- command publication is authorized;
- Gateway intents cover triggers;
- route policies are valid;
- the artifact digest matches.

It then registers commands, routes, schedules, and event subscriptions and starts the revision runner
when required.

Only one revision of a workflow is enabled. One installation intentionally has one active
control-plane server.

## Invocation and durable queue

Triggers enter a SQLite-backed queue with `queued`, `running`, and terminal statuses. Restart does
not silently drop queued work. Each workflow has a maximum queue depth of 1,000.

The manager:

- applies the approved concurrency;
- recovers stale running items after restart;
- ensures the exact runner is healthy;
- assigns execution, correlation, causation, and causal-depth IDs;
- enforces the handler deadline;
- records result, logs, failure tag, and duration.

Use `discord_workflow_invoke` for a manual trigger. The supplied key must match a declared manual
trigger.

## Disable

Disable:

1. rejects new capability calls;
2. stops accepting new trigger work;
3. removes routes and commands owned by the revision;
4. lets active handlers reach their deadline;
5. stops and destroys the runner.

Queued and execution history remain inspectable.

## Rollback

Rollback selects an already published revision. It does not rebuild. The target needs its own
approved grant and artifact. Registration changes follow the same enable checks.

Rollback is the fastest safe recovery when a new revision is functionally wrong but the control
plane and Discord credentials are healthy.

## Delete

Delete is destructive and requires workflow administration. It marks the workflow deleted, disables
the active revision, removes registrations, and destroys runtime state according to retention rules.
Audit and immutable evidence needed for incident investigation remain subject to retention policy.

## Executions and event tails

`discord_workflow_execution_get` returns one execution. `discord_workflow_executions_tail` performs a
bounded cursor-based wait over execution history.

`discord_events_tail` reads durable inboxes:

- workflow events;
- principal or workflow component events.

Use the returned cursor on the next call. A timeout with no events is a normal result, not a failure.

## Failure behavior

- **Build failure** — draft remains mutable; no revision is published.
- **Runner crash** — execution records failure; the runner is destroyed and recreated on the next
  invocation.
- **Timeout** — execution is terminated, runner is killed, and a typed timeout is recorded.
- **Queue full** — new trigger is rejected instead of dropping an older event.
- **Capability denied** — the operation fails locally and no Discord credential is exposed.
- **Route or command registration failure** — enable fails and ownership state is not silently
  adopted.

See [Recovery](recovery.md) and [Troubleshooting](troubleshooting.md).
