# Backups

Back up these assets together:

1. SQLite (`DATABASE_PATH`) using `sqlite3 ... ".backup ..."`, not a blind copy during writes.
2. The blob and workflow artifact directories.
3. `DISCORD_MCP_MASTER_KEY` in a separate secret manager.
4. Deployment configuration, excluding plaintext bot/client/supervisor credentials.

WAL mode means the `-wal` file may contain committed data not yet checkpointed. Use SQLite's online
backup API or stop the server cleanly before copying the database files.

Test restoration periodically in an isolated directory: run `discord-mcp migrate`, `diagnostics`,
list templates/blueprints/workflows, decrypt one disposable secret, and inspect an artifact digest.
Never start a restored copy against production Discord while the original control plane is active;
the product intentionally supports exactly one active replica. Horizontal operation is permanently
out of scope rather than a future deployment mode.
