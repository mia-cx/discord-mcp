# CLI reference

The local CLI performs administrative work that should not accept arbitrary remote filesystem paths:
database migration and diagnostics, principal and PAT management, local blob ingestion, and encrypted
named-secret management.

Run it from the repository:

```sh
corepack pnpm cli -- COMMAND
```

The server and CLI must use the same `DATABASE_PATH`, blob directory, and master key.

## Environment

| Variable | Default | Used by |
| --- | --- | --- |
| `DATABASE_PATH` | `data/discord-mcp.sqlite` | Every command |
| `DISCORD_MCP_BLOB_DIR` | `data/blobs` | Blob commands |
| `DISCORD_MCP_MAX_BLOB_BYTES` | 25 MiB | Blob ingestion limit |
| `DISCORD_MCP_BLOB_QUOTA_BYTES` | 250 MiB | Per-principal blob quota |
| `DISCORD_MCP_MASTER_KEY` | none | Secret commands |

Migrations run automatically when the CLI opens the database.

## Database commands

```sh
corepack pnpm cli -- migrate
corepack pnpm cli -- diagnostics
```

`migrate` applies pending migrations and reports the database path. `diagnostics` reports the Node
version, database path, applied migrations, and principal count. It does not contact Discord or start
the MCP server.

## Principals

```sh
corepack pnpm cli -- principal create NAME [scope,scope,...]
corepack pnpm cli -- principal list
```

`principal create` validates every scope and returns the new UUID. Scope names are listed in
[Authentication and authorization](authentication.md). An empty scope list creates a principal that
can authenticate but cannot call protected features.

The current CLI lists disabled state but does not add, remove, or disable scope bindings after
creation. Plan the initial binding carefully; use controlled database administration or a replacement
principal for changes until a dedicated command exists.

## Personal access tokens

```sh
corepack pnpm cli -- auth token create PRINCIPAL_ID NAME [days]
corepack pnpm cli -- auth token list [PRINCIPAL_ID]
corepack pnpm cli -- auth token revoke TOKEN_ID
```

The create command prints the `dcmcp_` token once. Expiry defaults to 90 days and must be 1–365 days.
List returns metadata and display prefixes, never the stored token. Revoke is permanent.

## Blobs

```sh
corepack pnpm cli -- blob put PRINCIPAL_ID PATH MIME_TYPE [FILENAME]
corepack pnpm cli -- blob metadata PRINCIPAL_ID BLOB_ID
corepack pnpm cli -- blob delete PRINCIPAL_ID BLOB_ID
```

`blob put` reads the explicit local path, stores content by SHA-256 ID, and returns metadata for use in
message/template attachments. The optional display filename defaults to the path's basename. Remote
MCP calls never accept a filesystem path.

Deleting a referenced blob is refused. Explicit deletion removes an unreferenced blob immediately;
otherwise a newly uploaded blob that remains unreferenced is removed by retention after seven days.
See [Backups](backups.md) before bulk maintenance.

HTTP clients can instead upload bytes to `POST /blobs` with bearer authentication, `blob:write`,
`Content-Type`, and `X-Discord-Mcp-Filename`. Metadata is available at
`GET /blobs/{sha256}/metadata`; owned blobs can be deleted at `DELETE /blobs/{sha256}`.

## Named secrets

```sh
printf %s "$VALUE" | corepack pnpm cli -- secret set PRINCIPAL_ID NAME
corepack pnpm cli -- secret list PRINCIPAL_ID
corepack pnpm cli -- secret delete PRINCIPAL_ID SECRET_ID
```

The value is read from standard input, encrypted with AES-256-GCM, and never returned by list. A
second `set` with the same principal/name replaces the ciphertext in place. Use named references for
workflow HTTP authentication and other secret-bearing configuration; never put the value in workflow
source.

`DISCORD_MCP_MASTER_KEY` must be the same 32-byte base64 key used by the server. Losing it makes
encrypted named secrets and Discord OAuth profiles irrecoverable.

## Output and auditing

Commands write machine-readable JSON to stdout and failures to stderr with a non-zero exit. Mutating
commands add redacted audit records to the same database. Treat command output from PAT creation as
sensitive because it contains the one-time token.
