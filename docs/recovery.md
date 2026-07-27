# Incident and partial-failure recovery

## Discord credentials or invalid-request storm

Stop the server, rotate the bot token in the Developer Portal, update the secret, and restart.
RateGuard deliberately trips far below Discord's IP-ban threshold. Diagnose 401/403/429 causes before
restoring traffic; do not clear the guard merely to retry.

## Blueprint partial apply

`discord_server_blueprint_apply` returns an execution ID and completed, pending, and failed actions.
Fix the named permission/hierarchy or transient Discord condition, capture a fresh snapshot, plan
again, and resume only when the exact blueprint/snapshot/action digests still match. If state changed,
create a new plan; never edit the durable journal.

## Workflow failure

Use `discord_workflow_execution_get` and `discord_workflow_executions_tail`. Timeouts and runner
crashes terminate/destroy the runner and are recorded as typed failures; the manager recreates a
runner on the next invocation. Disable to stop new work, allow active handlers to reach their
deadline, then rollback to a known published revision. Routes and workflow-owned commands are removed
when their revision is no longer enabled.

## Database or key loss

Restore SQLite, blobs, and artifacts from one backup set. Run `discord-mcp migrate` and
`diagnostics`. If only the master key was lost, encrypted values are irrecoverable: rotate/revoke them
upstream and authorize/store replacements. If the database was lost, discard orphaned runner
containers (`dcmcp-*`) through the supervisor and recreate bindings explicitly; never adopt Discord
resources by name.

## Sandbox policy violation

Disable the workflow, preserve its immutable source/artifact digest and audit entries, destroy the
runner, and rotate the supervisor and revision credentials. A workflow must never expose Discord
credentials, the Docker socket, a host path, or unrestricted networking. Treat evidence of any such
access as a control-plane incident.
