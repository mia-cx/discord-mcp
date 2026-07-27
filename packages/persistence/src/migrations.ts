export interface Migration {
  readonly version: number
  readonly name: string
  readonly sql: string
}

export const migrations: ReadonlyArray<Migration> = [
  {
    version: 1,
    name: 'initial_control_plane',
    sql: `
CREATE TABLE principals (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('local', 'oidc', 'pat', 'proxy', 'workflow')),
  disabled_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE principal_scope_bindings (
  principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  PRIMARY KEY (principal_id, scope)
);
CREATE TABLE personal_access_tokens (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE proxy_identities (
  identity TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE
);
CREATE TABLE discord_oauth_profiles (
  id TEXT PRIMARY KEY,
  owner_principal_id TEXT NOT NULL REFERENCES principals(id),
  name TEXT NOT NULL,
  discord_user_id TEXT,
  scopes_json TEXT NOT NULL,
  access_token_encrypted BLOB,
  refresh_token_encrypted BLOB,
  expires_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (owner_principal_id, name)
);
CREATE TABLE encrypted_secrets (
  id TEXT PRIMARY KEY,
  owner_principal_id TEXT NOT NULL REFERENCES principals(id),
  name TEXT NOT NULL,
  ciphertext BLOB NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (owner_principal_id, name)
);
CREATE TABLE stored_blobs (
  id TEXT PRIMARY KEY,
  owner_principal_id TEXT NOT NULL REFERENCES principals(id),
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  storage_path TEXT NOT NULL,
  reference_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  delete_after TEXT
);
CREATE TABLE message_templates (
  id TEXT PRIMARY KEY,
  owner_principal_id TEXT NOT NULL REFERENCES principals(id),
  name TEXT NOT NULL,
  draft_json TEXT NOT NULL,
  latest_revision INTEGER,
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE message_template_revisions (
  template_id TEXT NOT NULL REFERENCES message_templates(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  digest TEXT NOT NULL,
  document_json TEXT NOT NULL,
  published_by TEXT NOT NULL REFERENCES principals(id),
  published_at TEXT NOT NULL,
  PRIMARY KEY (template_id, revision),
  UNIQUE (template_id, digest)
);
CREATE TABLE component_bindings (
  handle TEXT PRIMARY KEY,
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  owner_revision INTEGER,
  action_type TEXT NOT NULL,
  action_key TEXT NOT NULL,
  expires_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE server_blueprints (
  id TEXT PRIMARY KEY,
  owner_principal_id TEXT NOT NULL REFERENCES principals(id),
  name TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  draft_json TEXT NOT NULL,
  latest_revision INTEGER,
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE server_blueprint_revisions (
  blueprint_id TEXT NOT NULL REFERENCES server_blueprints(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  digest TEXT NOT NULL,
  document_json TEXT NOT NULL,
  published_by TEXT NOT NULL REFERENCES principals(id),
  published_at TEXT NOT NULL,
  PRIMARY KEY (blueprint_id, revision),
  UNIQUE (blueprint_id, digest)
);
CREATE TABLE server_blueprint_bindings (
  blueprint_id TEXT NOT NULL REFERENCES server_blueprints(id) ON DELETE CASCADE,
  logical_type TEXT NOT NULL,
  logical_key TEXT NOT NULL,
  discord_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (blueprint_id, logical_type, logical_key)
);
CREATE TABLE server_blueprint_executions (
  id TEXT PRIMARY KEY,
  blueprint_id TEXT NOT NULL REFERENCES server_blueprints(id),
  revision INTEGER NOT NULL,
  principal_id TEXT NOT NULL REFERENCES principals(id),
  snapshot_digest TEXT NOT NULL,
  actions_digest TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  error_json TEXT
);
CREATE TABLE server_blueprint_actions (
  execution_id TEXT NOT NULL REFERENCES server_blueprint_executions(id) ON DELETE CASCADE,
  action_index INTEGER NOT NULL,
  action_json TEXT NOT NULL,
  status TEXT NOT NULL,
  result_json TEXT,
  started_at TEXT,
  finished_at TEXT,
  PRIMARY KEY (execution_id, action_index)
);
CREATE TABLE workflows (
  id TEXT PRIMARY KEY,
  owner_principal_id TEXT NOT NULL REFERENCES principals(id),
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  enabled_revision INTEGER,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE workflow_revisions (
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  source TEXT NOT NULL,
  dependencies_json TEXT NOT NULL,
  lockfile TEXT,
  source_digest TEXT NOT NULL,
  artifact_digest TEXT,
  requested_grants_json TEXT NOT NULL,
  manifest_json TEXT,
  status TEXT NOT NULL,
  diagnostics_json TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES principals(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (workflow_id, revision)
);
CREATE TABLE workflow_grants (
  workflow_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  grants_json TEXT NOT NULL,
  granted_by TEXT NOT NULL REFERENCES principals(id),
  granted_at TEXT NOT NULL,
  PRIMARY KEY (workflow_id, revision),
  FOREIGN KEY (workflow_id, revision) REFERENCES workflow_revisions(workflow_id, revision)
);
CREATE TABLE workflow_routes (
  workflow_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  policy_json TEXT NOT NULL,
  PRIMARY KEY (workflow_id, revision, method, path)
);
CREATE TABLE workflow_commands (
  workflow_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  command_key TEXT NOT NULL,
  discord_command_id TEXT,
  guild_id TEXT,
  PRIMARY KEY (workflow_id, revision, command_key, guild_id)
);
CREATE TABLE workflow_executions (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id),
  revision INTEGER NOT NULL,
  trigger_type TEXT NOT NULL,
  status TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  causation_id TEXT,
  causal_depth INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  logs TEXT NOT NULL DEFAULT '',
  error_json TEXT
);
CREATE TABLE workflow_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id TEXT NOT NULL REFERENCES workflows(id),
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  causation_id TEXT,
  received_at TEXT NOT NULL
);
CREATE TABLE gateway_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  discord_event_id TEXT,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  causation_id TEXT,
  received_at TEXT NOT NULL
);
CREATE TABLE workflow_kv (
  workflow_id TEXT NOT NULL REFERENCES workflows(id),
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workflow_id, key)
);
CREATE TABLE interaction_deduplication (
  interaction_id TEXT PRIMARY KEY,
  response_state_json TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE webhook_replay_protection (
  replay_id TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL
);
CREATE TABLE preview_tokens (
  token_hash TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(id),
  operation_id TEXT NOT NULL,
  arguments_digest TEXT NOT NULL,
  auth_profile TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);
CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  principal_id TEXT REFERENCES principals(id),
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  request_id TEXT,
  detail_json TEXT NOT NULL,
  outcome TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_gateway_events_received ON gateway_events(received_at);
CREATE INDEX idx_workflow_events_workflow_sequence ON workflow_events(workflow_id, sequence);
CREATE INDEX idx_workflow_executions_workflow_started ON workflow_executions(workflow_id, started_at);
CREATE INDEX idx_audit_log_created ON audit_log(created_at);
`,
  },
  {
    version: 2,
    name: 'discord_oauth_authorization_states',
    sql: `
CREATE TABLE discord_oauth_authorization_states (
  state_hash TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  profile_id TEXT NOT NULL,
  profile_name TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  pkce_verifier_encrypted BLOB NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_oauth_states_expiry ON discord_oauth_authorization_states(expires_at);
`,
  },
  {
    version: 3,
    name: 'local_administrator_principal',
    sql: `
INSERT OR IGNORE INTO principals(id, name, kind, created_at)
VALUES ('local-administrator', 'Local administrator', 'local', CURRENT_TIMESTAMP);
INSERT OR IGNORE INTO principal_scope_bindings(principal_id, scope) VALUES
('local-administrator', 'mcp:read'),
('local-administrator', 'mcp:write'),
('local-administrator', 'mcp:destructive'),
('local-administrator', 'bot:admin'),
('local-administrator', 'mentions:broad'),
('local-administrator', 'template:read'),
('local-administrator', 'template:write'),
('local-administrator', 'server:plan'),
('local-administrator', 'server:apply'),
('local-administrator', 'blob:write'),
('local-administrator', 'oauth:manage'),
('local-administrator', 'workflow:read'),
('local-administrator', 'workflow:write'),
('local-administrator', 'workflow:admin'),
('local-administrator', 'auth:admin'),
('local-administrator', 'audit:read');
`,
  },
  {
    version: 4,
    name: 'gateway_event_deduplication',
    sql: `
DELETE FROM gateway_events
WHERE discord_event_id IS NOT NULL
AND sequence NOT IN (
  SELECT MIN(sequence) FROM gateway_events
  WHERE discord_event_id IS NOT NULL
  GROUP BY discord_event_id
);
CREATE UNIQUE INDEX idx_gateway_events_discord_event_id
ON gateway_events(discord_event_id)
WHERE discord_event_id IS NOT NULL;
`,
  },
  {
    version: 5,
    name: 'component_event_inbox',
    sql: `
CREATE TABLE component_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_type TEXT NOT NULL CHECK (owner_type IN ('principal', 'workflow')),
  owner_id TEXT NOT NULL,
  binding_handle TEXT NOT NULL REFERENCES component_bindings(handle),
  action_key TEXT NOT NULL,
  interaction_id TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  received_at TEXT NOT NULL
);
CREATE INDEX idx_component_events_owner_sequence
ON component_events(owner_type, owner_id, sequence);
`,
  },
  {
    version: 6,
    name: 'workflow_action_causality',
    sql: `
ALTER TABLE gateway_events ADD COLUMN causal_depth INTEGER NOT NULL DEFAULT 0;
CREATE TABLE workflow_action_causality (
  discord_entity_id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES workflow_executions(id),
  workflow_id TEXT NOT NULL REFERENCES workflows(id),
  correlation_id TEXT NOT NULL,
  causal_depth INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_workflow_action_causality_created
ON workflow_action_causality(created_at);
`,
  },
  {
    version: 7,
    name: 'workflow_command_type_ownership',
    sql: `
ALTER TABLE workflow_commands RENAME TO workflow_commands_legacy;
CREATE TABLE workflow_commands (
  workflow_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  command_key TEXT NOT NULL,
  command_type INTEGER NOT NULL,
  discord_command_id TEXT,
  guild_id TEXT NOT NULL,
  PRIMARY KEY (workflow_id, revision, command_key, command_type, guild_id)
);
INSERT INTO workflow_commands
  (workflow_id, revision, command_key, command_type, discord_command_id, guild_id)
SELECT workflow_id, revision, command_key, 1, discord_command_id, COALESCE(guild_id, 'global')
FROM workflow_commands_legacy;
DROP TABLE workflow_commands_legacy;
CREATE UNIQUE INDEX idx_enabled_command_discord_id
ON workflow_commands(discord_command_id)
WHERE discord_command_id IS NOT NULL;
`,
  },
]
