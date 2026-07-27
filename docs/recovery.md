# Recovery

Preserve evidence and external state before attempting repair. For an uncertain incident, stop public
traffic first, then disable affected workflows or stop the server. Do not edit durable journals,
artifacts, or resource bindings by hand.

## Credential exposure

### Discord bot token

1. stop the server or block outbound/public traffic;
2. reset the bot token in the Discord Developer Portal;
3. update the secret store and deployment environment;
4. inspect audit/logs for affected actions and guilds;
5. restart and verify `/users/@me`/guild access through safe read tools;
6. review bot roles, installed commands, webhooks, and recent audit log entries.

### MCP PAT or principal

Revoke the PAT immediately:

```sh
corepack pnpm cli -- auth token revoke TOKEN_ID
```

If identity-wide compromise is suspected, disable or replace the principal and review durable audit
entries by principal ID. Rotate downstream named secrets the principal could administer.

### OAuth profile or named secret

Revoke the OAuth profile upstream and through `discord_oauth_profile_revoke`, or replace the named
secret with `secret set`. Profile/list APIs never recover plaintext, so authorize/store a replacement.

### Master key

If the key alone is lost, encrypted OAuth profiles and named secrets are irrecoverable. Revoke them
upstream, install a new key, and recreate them. If SQLite and the key were both exposed, assume every
encrypted value was compromised.

### Supervisor credential or Docker socket

Stop workflow execution, rotate the supervisor credential, restart both long-lived services, destroy
unknown runner/builder containers through the trusted supervisor/daemon, and verify artifact digests.
Treat arbitrary access to the daemon as host-level compromise for everything on that daemon.

## Invalid-request storm or RateGuard trip

Do not restart merely to retry.

1. identify the auth profile and operation family;
2. separate Discord 401, 403, 404/validation, and 429 responses;
3. confirm credential type and expiry;
4. inspect guild permission, channel overwrite, role hierarchy, and target IDs;
5. call `discord_permissions_explain`;
6. correct the cause;
7. resume with one safe read before restoring automation.

## Blueprint partial apply

`discord_server_blueprint_apply` returns an execution ID with completed, pending, and failed actions.
Completed Discord mutations are real and are not rolled back automatically.

1. retrieve the execution;
2. inspect the failed action and current guild state;
3. fix the named permission, hierarchy, or transient condition;
4. capture a fresh snapshot and plan again;
5. resume using `resumeExecutionId` only when the blueprint revision, snapshot, and action digests
   match the durable journal;
6. otherwise use a new plan that includes current reality.

Never delete completed journal rows to force replay.

## Workflow failure

Use `discord_workflow_execution_get` and `discord_workflow_executions_tail`.

For code/input failures:

1. disable the workflow;
2. inspect bounded logs and the immutable revision;
3. fix and validate a new draft;
4. publish and grant the new revision;
5. enable and invoke a disposable trigger.

For a regression, roll back to an existing published and granted artifact. Rollback does not rebuild
or silently copy the newest grant.

For timeout, OOM, or crash, the runner is terminated and destroyed; the manager recreates it on the
next invocation. Repeated runner death is a code/resource problem, not a reason to raise every limit.

## Queue backlog

1. disable noisy external routes/triggers if the queue is still growing;
2. inspect queue depth metrics per workflow;
3. classify failures, slow external dependencies, and insufficient concurrency;
4. fix the revision or narrow trigger filters;
5. increase concurrency only within 1–8 after measuring idempotency and downstream limits;
6. monitor the durable queue as it drains.

Do not delete queue rows manually; doing so loses accepted events without audit semantics.

## Database loss or corruption

1. stop server and supervisor;
2. preserve the damaged database and matching WAL/SHM for forensic recovery;
3. restore SQLite, blobs, and artifacts from one verified backup set;
4. restore the matching master key;
5. run migrations and diagnostics;
6. start without public traffic;
7. verify principals, templates, blueprints, workflows, blobs, artifacts, and encrypted metadata;
8. reconcile/destroy orphaned `dcmcp-*` containers;
9. perform live acceptance before reopening traffic.

If the database is lost but Discord resources remain, do not adopt resources merely because names
match. Recreate ownership/bindings explicitly and inspect commands/components/webhooks for orphans.

## Missing blobs or artifacts

A missing referenced blob prevents the related attachment operation. Restore it under its
content-addressed path and verify the SHA-256 ID.

A missing or modified published artifact causes digest verification/start failure. Restore the exact
artifact from backup or publish a new revision from source and approve a new grant. Never replace the
file while retaining the old digest.

## Interaction signature failures

After a proxy change:

1. confirm the Developer Portal interaction URL is exact;
2. confirm `DISCORD_PUBLIC_KEY`;
3. ensure the proxy forwards the raw bytes without JSON reserialization or decompression surprises;
4. preserve `X-Signature-Ed25519` and `X-Signature-Timestamp`;
5. confirm the body limit is at least Discord's payload;
6. test PING validation from the Developer Portal.

Do not bypass signature verification as a diagnostic.

## Sandbox policy violation

If workflow code appears to read a Discord/control-plane credential, host path, Docker socket, or
direct network:

1. disable all affected workflows and isolate the runner daemon;
2. preserve immutable source/artifact digests, image digests, container metadata, audit, and logs;
3. do not execute the artifact again;
4. rotate supervisor and revision credentials;
5. rotate every credential that evidence says could have entered the runner;
6. rebuild the host/daemon from trusted images if escape is plausible;
7. reproduce only in an isolated forensic environment;
8. rerun `test:sandbox` before restoring workflow service.

Credential absence is an architectural guarantee. Evidence to the contrary is a control-plane or
host incident, not an ordinary workflow bug.

## Accidental second replica

Stop the newer/clone replica immediately. Disable its proxy route, Gateway, schedules, commands, and
workflow routes. Compare audit and execution timelines to identify duplicate effects, then retain one
authoritative data set. Rotate route secrets if both replicas accepted replay-protected traffic with
divergent databases.

## Post-incident checklist

- record time range, affected principals/workflows/guilds, and correlation IDs;
- record rotations/revocations without recording secret values;
- verify backup and restore state;
- verify Discord commands, webhooks, roles, channels, and audit log;
- run release and live acceptance appropriate to the changed boundary;
- document the root cause and a concrete prevention/alert improvement.
