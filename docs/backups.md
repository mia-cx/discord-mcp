# Backups

A usable backup contains one consistent control-plane state plus the external key needed to decrypt
it. Back up and restore the set together.

## Backup inventory

| Asset | Why it matters |
| --- | --- |
| SQLite at `DATABASE_PATH` | Principals, token hashes, templates, blueprints, workflow source/revisions/grants, queues, executions, bindings, audit |
| Blob directory | Message/template attachment bytes referenced by SQLite |
| Artifact directory | Immutable workflow builds referenced by published revisions |
| `DISCORD_MCP_MASTER_KEY` | Decrypts OAuth profiles and named secrets |
| Deployment configuration | Image pins, public/proxy settings, intents, limits, filesystem paths |

Do not include plaintext bot/client/supervisor credentials in a general data archive. Back them up in
the secret manager designed for those credentials.

The transient `run` directory contains Unix sockets and should not be archived.

## Online SQLite backup

SQLite uses WAL mode. A blind copy of only the main database while the server is writing may omit
committed pages still in `-wal`.

Use the online backup command:

```sh
mkdir -p backups/2026-07-27
sqlite3 data/discord-mcp.sqlite \
  ".backup 'backups/2026-07-27/discord-mcp.sqlite'"
```

Then archive blobs and artifacts from the same maintenance window:

```sh
tar -C data -czf backups/2026-07-27/blobs.tar.gz blobs
tar -C data -czf backups/2026-07-27/artifacts.tar.gz artifacts
```

For the strongest consistency between database references and filesystem contents, briefly stop
public mutations or stop the server after the SQLite backup while copying blobs/artifacts.
Content-addressed blobs and immutable published artifacts make extra unreferenced files harmless, but
missing referenced files are not.

## Offline backup

For a fully quiescent set:

```sh
docker compose stop server supervisor
cp data/discord-mcp.sqlite backups/2026-07-27/discord-mcp.sqlite
tar -C data -czf backups/2026-07-27/blobs.tar.gz blobs
tar -C data -czf backups/2026-07-27/artifacts.tar.gz artifacts
docker compose up -d server supervisor
```

After a clean stop, copying the main database is sufficient. If the process was killed or stop status
is uncertain, preserve the matching `-wal` and `-shm` files too or use the online backup API before
archiving.

## Protect and verify archives

- encrypt backups at rest;
- restrict filesystem/object-store access;
- store the master key separately from the database archive;
- retain the exact application image tag or commit for each backup;
- record checksums;
- use retention and off-site copies appropriate to the guild's impact;
- never log or store PAT plaintext, Discord tokens, or message contents in a backup manifest.

Example checksums:

```sh
sha256sum backups/2026-07-27/* > backups/2026-07-27/SHA256SUMS
sha256sum -c backups/2026-07-27/SHA256SUMS
```

## Restore test

Test restoration periodically in an isolated directory and network:

1. verify archive checksums;
2. restore SQLite, blobs, and artifacts as one set;
3. provide the matching master key;
4. run `corepack pnpm cli -- migrate`;
5. run `corepack pnpm cli -- diagnostics`;
6. list principals, templates, blueprints, and workflows;
7. decrypt or rotate one disposable named secret;
8. verify referenced blob and artifact digests;
9. start with Gateway/workflow/public traffic disabled;
10. destroy the test restore after recording the result.

Never start a restored clone against the production Discord application while the original control
plane is active. The product intentionally supports one active replica.

## Recovery objectives

Choose backup frequency from the amount of durable queue, workflow state, audit history, and
configuration change you can afford to lose. SQLite state changes more frequently than workflow
artifacts, so a single infrequent filesystem snapshot can create misleading recovery confidence.

Document:

- recovery point objective;
- recovery time objective;
- who can retrieve the master key;
- where Discord and MCP credentials are rotated;
- the last successful restore-test date.
