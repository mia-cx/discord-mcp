# Operator guide

This is the day-two runbook after initial [Setup](setup.md) and [Deployment](deployment.md). It focuses
on routine checks, controlled changes, and the order in which to diagnose failures.

## Daily health check

1. Confirm both long-lived containers are healthy and not restarting.
2. Check `/health/ready`.
3. Review structured error/warning logs since the previous check.
4. Inspect `discord_metrics_snapshot` or `/metrics` for new failures, timeouts, queue growth, and
   RateGuard trips.
5. Verify Gateway status if any enabled feature needs it.
6. Confirm backups completed and the most recent restore test is still current.

Commands:

```sh
docker compose ps
docker compose logs --since=24h server supervisor
curl --fail https://discord-mcp.example.com/health/ready
corepack pnpm cli -- diagnostics
```

Health endpoints intentionally report only `{ "ok": true }`; they do not prove Discord permissions,
Gateway connectivity, or sandbox execution. Use the feature-specific checks for those.

## Discord application changes

The normal baseline is a bot installed with `bot` and `applications.commands`. Add only the guild
permissions and Gateway intents used by current automations.

Before changing bot roles:

- run `discord_permissions_explain` for the planned operation;
- remember that role hierarchy is independent of permission bits;
- keep the bot's highest role above every role it must manage;
- do not grant broad permissions to work around one target-specific overwrite;
- enable privileged intents in the Developer Portal before configuring them locally.

See [Discord permissions and intents](discord-permissions.md).

## Principal and token rotation

Create separate principals for people, automation clients, and trust levels. Rotate PATs without
changing the principal:

```sh
corepack pnpm cli -- auth token create PRINCIPAL_ID replacement 90
# update the client and verify it can connect
corepack pnpm cli -- auth token revoke OLD_TOKEN_ID
```

Never paste the one-time token into logs, MCP prompts, or issue trackers. Review principal and PAT
metadata periodically:

```sh
corepack pnpm cli -- principal list
corepack pnpm cli -- auth token list
```

OIDC and proxy identities should be disabled at their identity source and locally during an incident.

## Safe Discord changes

Prefer curated `discord_*` tools because they apply local schema, scope, permission, hierarchy, and
presentation checks. For an unfamiliar operation:

1. search the pinned catalog;
2. describe the exact operation;
3. preview destructive/admin calls;
4. review normalized arguments and targets;
5. execute once with the returned token.

Preview tokens are principal-bound, argument-bound, one-use, and expire after 60 seconds. Never write
an automation loop that blindly regenerates a destructive preview after failure.

For large guild configuration changes, use a blueprint plan/apply cycle. A stale snapshot must be
replanned; a partial apply must be resumed from its durable execution record, not recreated by name.

## Workflow operations

Use the full lifecycle:

```text
create/update draft → validate → publish → grant → enable
```

Before granting, review source, exact lockfile, requested versus approved capabilities, HTTP hosts,
Discord targets, OAuth profile IDs, trigger filters, command publication, install scripts, timeout,
concurrency, and queue limits.

When a workflow misbehaves:

1. disable it to reject new work;
2. let active handlers drain to their deadline;
3. inspect recent executions and logs;
4. fix a new draft and publish a new immutable revision, or roll back;
5. approve a revision-specific grant;
6. re-enable and invoke a disposable trigger.

Do not edit an artifact or durable execution row in place.

## Blobs and named secrets

Only the local CLI accepts a path:

```sh
corepack pnpm cli -- blob put PRINCIPAL_ID ./announcement.pdf application/pdf
```

Remote clients upload bytes to the authenticated blob endpoint. Attachments refer to returned blob
IDs, never host paths. Published templates retain references; unreferenced blobs are deleted after
their grace period.

Store workflow route credentials as encrypted named secrets:

```sh
printf %s "$WEBHOOK_SECRET" |
  corepack pnpm cli -- secret set PRINCIPAL_ID deploy-hook
```

List shows metadata, not values. Rotate by setting the same name again, then verify dependent routes.

## Database maintenance

SQLite runs in WAL mode and is owned by the single server replica. Normal startup and CLI access apply
migrations automatically.

Rules:

- use SQLite's online backup API for a running system;
- do not copy only the main `.sqlite` file while writes continue;
- do not run manual `VACUUM`, journal changes, or schema edits during production traffic;
- stop the server before invasive inspection;
- retain a pre-upgrade backup until the new release has passed live acceptance.

Run `corepack pnpm cli -- diagnostics` after a restore or upgrade. See [Backups](backups.md).

## Retention

The server runs retention hourly. It removes expired OAuth states, interaction dedupe records, replay
records, and preview tokens; keeps Gateway events for seven days; bounds workflow/component event
history by age and per-owner count; clears old execution log text; prunes old causality records;
retains audit entries for 90 days; and deletes unreferenced blobs after their deadline.

Retention is not a backup. Export audit data before its window expires if policy requires longer
storage.

## Restart behavior

Queues, workflow enablement, revision grants, events, executions, interactions, component bindings,
and route registrations are persisted. On restart the control plane:

- migrates the database;
- recovers enabled revisions and registrations;
- reconciles orphaned runner state through the supervisor;
- resumes processing durable queued work;
- reconnects the Gateway according to mode and demand.

A process restart is therefore recoverable, but it is not a substitute for diagnosing repeated
crashes or queue pressure.

## RateGuard response

Repeated invalid Discord responses can lead to an upstream IP ban. RateGuard trips well before that
threshold, by default after 25 invalid responses for an auth-profile/operation family in ten minutes.

When it trips:

1. stop retrying;
2. identify 401 versus 403 versus invalid arguments;
3. confirm credential mode, guild permission, channel overwrite, role hierarchy, and target IDs;
4. use `discord_permissions_explain`;
5. rotate a compromised/invalid credential if necessary;
6. restore traffic only after the cause is fixed.

## Upgrade and rollback

Use immutable GHCR tags for the server, supervisor, builder, and runner. Back up first, pull one
coherent release, recreate the two long-lived services, and run readiness plus a disposable workflow.

Application rollback is safe only if the old code supports the current database schema. If a release
applied a non-backward-compatible migration, restore the matching pre-upgrade data set rather than
starting an older image on the newer database.

## When to invoke incident recovery

Switch from routine operations to [Recovery](recovery.md) for:

- suspected credential or master-key exposure;
- evidence that runner code accessed a forbidden secret, socket, host path, or network;
- database corruption or loss;
- a partial blueprint with uncertain external state;
- repeated supervisor preflight or cgroup failures;
- interaction signature failures after proxy changes;
- uncontrolled command/route publication;
- a restore or clone accidentally started alongside production.
