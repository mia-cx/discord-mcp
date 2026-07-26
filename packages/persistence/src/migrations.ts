/**
 * Migrations as plain SQL, applied in order and recorded in `schema_migrations`.
 *
 * Deliberately not the Effect migrator: that loads migration *files* from disk, which would make
 * the running server depend on its own source tree being present — awkward in a container and
 * impossible from a packed tarball. Inlining them keeps a migration and the code that needs it in
 * the same reviewable unit.
 *
 * Append only. Editing an applied migration silently diverges databases that already ran it.
 */

export interface Migration {
  readonly id: number
  readonly name: string
  /** Executed as one transaction. Split statements on the caller's side. */
  readonly statements: ReadonlyArray<string>
}

export const MIGRATIONS: ReadonlyArray<Migration> = [
  {
    id: 1,
    name: 'principals_and_auth',
    statements: [
      `CREATE TABLE principals (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('stdio-local','oauth','pat','trusted-proxy')),
        display_name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        disabled_at INTEGER
      )`,
      `CREATE TABLE principal_scope_bindings (
        principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
        scope TEXT NOT NULL,
        PRIMARY KEY (principal_id, scope)
      )`,
      `CREATE TABLE personal_access_tokens (
        id TEXT PRIMARY KEY,
        principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        -- argon2id hash. The token itself is shown once and never stored.
        token_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        revoked_at INTEGER,
        last_used_at INTEGER
      )`,
      `CREATE INDEX personal_access_tokens_principal ON personal_access_tokens(principal_id)`,
      `CREATE TABLE proxy_identities (
        header_value TEXT PRIMARY KEY,
        principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL
      )`,
      `CREATE TABLE encrypted_secrets (
        name TEXT PRIMARY KEY,
        -- AES-256-GCM under DISCORD_MCP_MASTER_KEY. Losing the key makes these unrecoverable.
        ciphertext BLOB NOT NULL,
        iv BLOB NOT NULL,
        auth_tag BLOB NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE TABLE discord_oauth_profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        owner_principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
        discord_user_id TEXT,
        scopes TEXT NOT NULL,
        access_secret_name TEXT REFERENCES encrypted_secrets(name),
        refresh_secret_name TEXT REFERENCES encrypted_secrets(name),
        expires_at INTEGER,
        created_at INTEGER NOT NULL,
        revoked_at INTEGER
      )`,
      `CREATE TABLE oauth_authorization_states (
        state TEXT PRIMARY KEY,
        principal_id TEXT NOT NULL,
        profile_name TEXT NOT NULL,
        scopes TEXT NOT NULL,
        code_verifier TEXT NOT NULL,
        nonce TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        consumed_at INTEGER
      )`,
    ],
  },
  {
    id: 2,
    name: 'blobs_templates_bindings',
    statements: [
      `CREATE TABLE stored_blobs (
        id TEXT PRIMARY KEY,
        -- Content addressed, so the same bytes uploaded twice cost one row.
        digest TEXT NOT NULL,
        filename TEXT NOT NULL,
        content_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        owner_principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        last_referenced_at INTEGER
      )`,
      `CREATE INDEX stored_blobs_digest ON stored_blobs(digest)`,
      `CREATE TABLE message_templates (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT,
        -- Mutable working copy. Publishing freezes a revision.
        draft_json TEXT,
        latest_revision INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        archived_at INTEGER
      )`,
      `CREATE TABLE message_template_revisions (
        template_id TEXT NOT NULL REFERENCES message_templates(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL,
        -- Immutable once written. There is no update path for this table by design.
        body_json TEXT NOT NULL,
        digest TEXT NOT NULL,
        published_by TEXT NOT NULL,
        published_at INTEGER NOT NULL,
        PRIMARY KEY (template_id, revision)
      )`,
      `CREATE TABLE server_blueprints (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT,
        draft_json TEXT,
        latest_revision INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        archived_at INTEGER
      )`,
      `CREATE TABLE server_blueprint_revisions (
        blueprint_id TEXT NOT NULL REFERENCES server_blueprints(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL,
        body_json TEXT NOT NULL,
        digest TEXT NOT NULL,
        published_by TEXT NOT NULL,
        published_at INTEGER NOT NULL,
        PRIMARY KEY (blueprint_id, revision)
      )`,
      `CREATE TABLE server_blueprint_bindings (
        blueprint_id TEXT NOT NULL REFERENCES server_blueprints(id) ON DELETE CASCADE,
        guild_id TEXT NOT NULL,
        -- The whole point: logical key -> snowflake, so a rename preserves identity.
        logical_key TEXT NOT NULL,
        discord_id TEXT NOT NULL,
        object_kind TEXT NOT NULL CHECK (object_kind IN ('role','channel')),
        bound_at INTEGER NOT NULL,
        PRIMARY KEY (blueprint_id, guild_id, logical_key)
      )`,
      `CREATE TABLE server_blueprint_executions (
        id TEXT PRIMARY KEY,
        blueprint_id TEXT NOT NULL REFERENCES server_blueprints(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL,
        guild_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running','completed','failed','partial')),
        -- Digest of the guild snapshot the plan was built against, so a stale apply is refused.
        snapshot_digest TEXT NOT NULL,
        started_by TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        finished_at INTEGER
      )`,
      `CREATE TABLE server_blueprint_actions (
        execution_id TEXT NOT NULL REFERENCES server_blueprint_executions(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        kind TEXT NOT NULL,
        logical_key TEXT NOT NULL,
        summary TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending','completed','failed','skipped')),
        discord_id TEXT,
        error TEXT,
        completed_at INTEGER,
        PRIMARY KEY (execution_id, sequence)
      )`,
    ],
  },
  {
    id: 3,
    name: 'components_interactions_audit',
    statements: [
      `CREATE TABLE component_bindings (
        -- The opaque handle Discord round-trips. Never carries meaning: it is a lookup key only,
        -- because anything encoded in a custom_id comes back as untrusted client input.
        handle TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('workflow','inbox')),
        action_key TEXT NOT NULL,
        owner_kind TEXT NOT NULL CHECK (owner_kind IN ('message','template','workflow')),
        owner_id TEXT NOT NULL,
        owner_revision INTEGER,
        created_at INTEGER NOT NULL,
        expires_at INTEGER
      )`,
      `CREATE INDEX component_bindings_owner ON component_bindings(owner_kind, owner_id)`,
      `CREATE TABLE interaction_deduplication (
        interaction_id TEXT PRIMARY KEY,
        received_at INTEGER NOT NULL
      )`,
      `CREATE TABLE webhook_replay_protection (
        replay_id TEXT PRIMARY KEY,
        route_id TEXT NOT NULL,
        seen_at INTEGER NOT NULL
      )`,
      `CREATE TABLE preview_tokens (
        token_hash TEXT PRIMARY KEY,
        principal_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        auth_profile TEXT NOT NULL,
        argument_hash TEXT NOT NULL,
        targets TEXT NOT NULL,
        issued_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        redeemed_at INTEGER
      )`,
      `CREATE TABLE audit_log (
        id TEXT PRIMARY KEY,
        at INTEGER NOT NULL,
        principal_id TEXT,
        action TEXT NOT NULL,
        subject_kind TEXT,
        subject_id TEXT,
        outcome TEXT NOT NULL CHECK (outcome IN ('allowed','denied','failed')),
        detail_json TEXT,
        correlation_id TEXT
      )`,
      `CREATE INDEX audit_log_at ON audit_log(at)`,
      `CREATE INDEX audit_log_principal ON audit_log(principal_id, at)`,
    ],
  },
  {
    id: 4,
    name: 'workflows_events_kv',
    statements: [
      `CREATE TABLE workflows (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        description TEXT,
        enabled_revision INTEGER,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted_at INTEGER
      )`,
      `CREATE TABLE workflow_revisions (
        workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL,
        source TEXT NOT NULL,
        dependencies_json TEXT NOT NULL,
        lockfile TEXT,
        source_digest TEXT NOT NULL,
        artifact_digest TEXT,
        requested_grants_json TEXT NOT NULL,
        compiled_manifest_json TEXT,
        status TEXT NOT NULL CHECK (status IN ('draft','building','validated','published','failed')),
        diagnostics_json TEXT NOT NULL DEFAULT '[]',
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (workflow_id, revision)
      )`,
      `CREATE TABLE workflow_grants (
        workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL,
        -- Approved separately from source: publishing grants nothing.
        grant_json TEXT NOT NULL,
        granted_by TEXT NOT NULL,
        granted_at INTEGER NOT NULL,
        PRIMARY KEY (workflow_id, revision)
      )`,
      `CREATE TABLE workflow_routes (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        auth_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE (workflow_id, method, path)
      )`,
      `CREATE TABLE workflow_commands (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL,
        discord_command_id TEXT,
        guild_id TEXT,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
      `CREATE TABLE workflow_executions (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL,
        trigger_kind TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed','timeout','killed')),
        correlation_id TEXT NOT NULL,
        causation_id TEXT,
        -- Capped at 5 so a workflow that triggers itself cannot recurse indefinitely.
        causal_depth INTEGER NOT NULL DEFAULT 0,
        started_at INTEGER,
        finished_at INTEGER,
        queued_at INTEGER NOT NULL,
        logs TEXT,
        error TEXT
      )`,
      `CREATE INDEX workflow_executions_workflow ON workflow_executions(workflow_id, queued_at)`,
      `CREATE TABLE workflow_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        workflow_id TEXT REFERENCES workflows(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        correlation_id TEXT,
        received_at INTEGER NOT NULL
      )`,
      `CREATE TABLE gateway_events (
        -- Monotonic and persistent, so a cursor survives a restart.
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        discord_event_id TEXT,
        shard_id INTEGER,
        guild_id TEXT,
        channel_id TEXT,
        payload_json TEXT NOT NULL,
        correlation_id TEXT NOT NULL,
        causation_id TEXT,
        received_at INTEGER NOT NULL
      )`,
      `CREATE INDEX gateway_events_type ON gateway_events(event_type, sequence)`,
      `CREATE TABLE workflow_kv (
        workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER,
        PRIMARY KEY (workflow_id, key)
      )`,
    ],
  },
  {
    id: 5,
    name: 'route_dispatch_columns',
    statements: [
      // Resolving a request needs the slug to build the mounted path and the trigger index to know
      // which handler to run; without them a lookup would have to join back to the manifest.
      `ALTER TABLE workflow_routes ADD COLUMN workflow_slug TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE workflow_routes ADD COLUMN trigger_index INTEGER NOT NULL DEFAULT 0`,
      // The hot path is method + path on every public request.
      `CREATE INDEX workflow_routes_lookup ON workflow_routes(method, path)`,
      `CREATE INDEX webhook_replay_seen_at ON webhook_replay_protection(seen_at)`,
    ],
  },
]

/**
 * Retention, in milliseconds. Cleanup runs as a supervised schedule.
 *
 * The bounded tables are the ones an automated system fills fastest; leaving them unbounded is how
 * a long-running deployment eventually fails on disk rather than on logic.
 */
export const RETENTION_MS = {
  workflowEvents: 7 * 24 * 60 * 60 * 1000,
  executionLogs: 7 * 24 * 60 * 60 * 1000,
  interactionDeduplication: 24 * 60 * 60 * 1000,
  webhookReplay: 10 * 60 * 1000,
  auditLog: 90 * 24 * 60 * 60 * 1000,
  previewTokens: 60 * 1000,
} as const

/** Per-workflow event cap, whichever bound is reached first. */
export const MAX_EVENTS_PER_WORKFLOW = 10_000
