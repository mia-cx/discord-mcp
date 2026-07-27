# MCP tool guide

The MCP surface has 127 tools. This guide explains how to choose one, how risk and authorization
work, and what each tool family contains. The MCP client remains the authoritative source for exact
input and output schemas: use `tools/list`, and let the client validate arguments instead of guessing
fields.

## Tool contract

Every tool:

- begins with `discord_`;
- accepts an object at the input root and returns a structured object;
- rejects unknown properties at strict schema boundaries;
- declares local scope requirements in its description;
- explains relevant Discord guild permissions or OAuth requirements;
- uses MCP read-only, destructive, idempotent, and open-world annotations;
- includes a request ID in the result metadata;
- returns typed error information rather than exposing raw credentials or private request bodies.

Large results are bounded by `DISCORD_MCP_MAX_RESPONSE_BYTES`. When a response is too large, the tool
returns a preview plus an explicit instruction to continue with the operation's pagination cursor or
the matching `discord://` resource instead of silently returning malformed JSON.

## MCP resources

Resources provide detailed, addressable JSON without adding more action tools:

| Resource URI | Scope | Contents |
| --- | --- | --- |
| `discord://api/operations/{operationId}` | `mcp:read` | One pinned Discord operation description |
| `discord://api/families/{family}` | `mcp:read` | Every pinned operation in one family |
| `discord://components/v2` | `mcp:read` | Components V2 structural limits and incompatibilities |
| `discord://message-templates/{id}/revisions/{revision}` | `template:read` | One owned immutable template revision |
| `discord://server-blueprints/{id}/revisions/{revision}` | `server:plan` | One owned immutable blueprint revision |
| `discord://server-blueprints/{id}/executions/{executionId}` | `server:plan` | One owned blueprint apply journal |
| `discord://workflows/{workflowId}` | `workflow:read` | Owned workflow metadata and revision summary |
| `discord://workflows/{id}/revisions/{revision}` | `workflow:read` | One owned workflow revision and diagnostics |
| `discord://workflows/{id}/executions/{executionId}` | `workflow:read` | One owned execution |
| `discord://audit/{auditId}` | `audit:read` | One redacted local audit row |

The local administrator and principals with `auth:admin` may read cross-owner stored resources where
the resource supports administration. A missing or inaccessible stored object returns a missing
record rather than revealing another owner's data.

## Authorization layers

A successful operation may pass through four independent checks:

1. **Toolset** — whether the server exposes the tool.
2. **Local scope** — whether the MCP principal may request the class of action.
3. **Control-plane policy** — ownership, preview token, workflow grant, target, hierarchy, or mention
   checks.
4. **Discord authorization** — bot permissions, role hierarchy, OAuth scopes, application ownership,
   and Discord endpoint rules.

A Discord 403 does not mean the local scope model failed. Call `discord_permissions_explain` and
inspect the bot's guild role placement.

## Toolsets

| Toolset | Enable when |
| --- | --- |
| `operator` | Clients need routine Discord reads/writes, presentations, blobs, snapshots, or blueprint planning. |
| `automation` | Clients manage templates, workflows, and durable event tails. |
| `admin` | Clients manage OAuth profiles, application state, audit/metrics, or apply blueprints. |
| `api` | Clients need search and controlled access to the complete pinned Discord catalog. |

Configure a comma-separated selection in `DISCORD_MCP_TOOLSETS`. Default:

```dotenv
DISCORD_MCP_TOOLSETS=operator,automation,api
```

Toolsets reduce discovery noise and accidental exposure. They do not replace scopes.

## Curated tools or catalog tools?

Use a curated tool whenever possible. A curated tool:

- names the intent in Discord language;
- exposes only relevant fields;
- adds local validation and mutual-exclusion rules;
- can pre-check role hierarchy or permission requirements;
- generates safer diagnostics for an MCP agent.

Use the catalog when the pinned Discord operation exists but no curated tool covers it.

### Catalog workflow

Search:

```json
{
  "query": "list archived threads",
  "limit": 10
}
```

Pass that to `discord_api_search`, then call `discord_api_describe` with the selected operation ID.
The description reports method, route, parameters, request bodies, auth modes, OAuth scopes,
sensitive fields, pagination, and risk.

For `destructive` or `bot_admin` risk:

1. call `discord_api_preview` with the exact normalized request;
2. inspect the operation, target, and warnings;
3. pass the returned preview token and unchanged request to the matching dispatcher within 60
   seconds.

Preview tokens are single-use and bind the principal, operation, auth profile, targets, and
normalized arguments. A token cannot authorize a modified call.

### Dispatchers

| Tool | Risk | Typical local scope |
| --- | --- | --- |
| `discord_api_read` | Read-only catalog operations | `mcp:read` |
| `discord_api_write` | Reversible or ordinary writes | `mcp:write` |
| `discord_api_destructive` | Deletes, bans, revocations, exact-set replacements | `mcp:destructive` |
| `discord_api_admin` | Application and bot administration | `bot:admin` |

Catalog input cannot set an authorization header or arbitrary URL. Sensitive body or query fields
must come from an encrypted named secret reference when the operation supports one.

## Complete inventory

### Catalog and discovery

- `discord_api_search`
- `discord_api_describe`
- `discord_api_preview`
- `discord_api_read`
- `discord_api_write`
- `discord_api_destructive`
- `discord_api_admin`

### Guild, channel, and thread reads

- `discord_guild_get`, `discord_guild_list`, `discord_guild_inspect`
- `discord_channel_get`, `discord_channel_list`
- `discord_thread_list`
- `discord_server_snapshot`
- `discord_permissions_explain`

### Channel and permission-overwrite management

- `discord_channel_create`, `discord_channel_update`, `discord_channel_delete`
- `discord_channel_reorder`
- `discord_channel_overwrite_set`, `discord_channel_overwrite_delete`
- `discord_forum_post_create`
- `discord_thread_update`, `discord_thread_member_update`

Channel creation uses a discriminated channel kind. Fields from text, voice, forum, media, or category
variants cannot be mixed. Permission overwrites use disjoint allow and deny sets.

### Messages and reactions

- `discord_message_get`, `discord_message_list`
- `discord_message_send`, `discord_message_edit`, `discord_message_validate`
- `discord_message_delete`, `discord_message_bulk_delete`
- `discord_message_crosspost`, `discord_message_thread_create`
- `discord_message_pin_update`, `discord_message_reaction_update`
- `discord_webhook_execute`
- `discord_modal_validate`

Semantic send, edit, validate, and webhook tools use the shared presentation pipeline. Catalog and
curated raw body operations still receive safe-mention enforcement.

### Members, roles, moderation, and bans

- `discord_member_get`, `discord_member_list`, `discord_member_search`
- `discord_member_update`, `discord_member_timeout`
- `discord_member_kick`, `discord_member_ban`, `discord_member_unban`
- `discord_ban_list`
- `discord_role_list`, `discord_role_create`, `discord_role_update`
- `discord_role_assign`, `discord_role_remove`, `discord_role_delete`, `discord_role_reorder`

Role mutation tools check that the bot can manage the target role or member and cannot grant
permissions it does not hold. Timeout accepts one of duration, exact expiry, or clear—not a mixture.

### AutoMod and audit log

- `discord_automod_rule_list`
- `discord_automod_rule_create`
- `discord_automod_rule_update`
- `discord_automod_rule_delete`
- `discord_audit_log_list`

`discord_audit_log_list` reads Discord's guild audit log. `discord_audit_list` reads this
application's local control-plane audit history.

### Webhooks and invites

- `discord_webhook_list`, `discord_webhook_create`, `discord_webhook_delete`
- `discord_invite_list`, `discord_invite_create`, `discord_invite_revoke`

Webhook execution accepts a named encrypted token reference instead of exposing a credential to an
MCP client. Credential-bearing route segments are redacted from errors.

### Scheduled events, emoji, and stickers

- `discord_scheduled_event_list`
- `discord_scheduled_event_create`
- `discord_scheduled_event_update`
- `discord_scheduled_event_delete`
- `discord_emoji_list`, `discord_emoji_create`, `discord_emoji_delete`
- `discord_sticker_list`, `discord_sticker_create`, `discord_sticker_delete`

### Bot, application, and application commands

- `discord_bot_get_profile`, `discord_bot_update_profile`
- `discord_application_get`, `discord_application_update`
- `discord_application_command_list`
- `discord_application_command_publish`
- `discord_application_command_delete`

Publishing is an exact-set replacement and is destructive. Prefer workflow-owned command
publication for workflow triggers so ownership and rollback remain automatic.

### Message templates

- `discord_message_template_list`
- `discord_message_template_get`
- `discord_message_template_create`
- `discord_message_template_update_draft`
- `discord_message_template_validate`
- `discord_message_template_publish`
- `discord_message_template_render`
- `discord_message_template_archive`

See [Message templates](templates.md).

### Blobs

- `discord_blob_put`
- `discord_blob_get_metadata`
- `discord_blob_delete`

MCP blob input is bounded inline base64. It never accepts a local path. Use the local CLI for a
filesystem upload or authenticated `POST /blobs` for streaming HTTP upload.

### Server blueprints

- `discord_server_blueprint_list`
- `discord_server_blueprint_get`
- `discord_server_blueprint_create`
- `discord_server_blueprint_update_draft`
- `discord_server_blueprint_validate`
- `discord_server_blueprint_publish`
- `discord_server_blueprint_archive`
- `discord_server_blueprint_plan`
- `discord_server_blueprint_apply`

See [Server blueprints](blueprints.md).

### Workflows and durable events

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
- `discord_events_tail`

See [Workflow lifecycle](workflows.md).

### OAuth profiles

- `discord_oauth_profile_authorize`
- `discord_oauth_profile_list`
- `discord_oauth_profile_get`
- `discord_oauth_profile_revoke`

These manage Discord user-context credentials, not MCP login. See [Discord OAuth profiles](oauth.md).

### Gateway

- `discord_gateway_status`
- `discord_gateway_recent_events`
- `discord_gateway_wait_for_event`
- `discord_presence_set`
- `discord_voice_state_set`

See [Gateway and interactions](gateway-interactions.md).

### Local audit and metrics

- `discord_audit_list`
- `discord_metrics_snapshot`

Both require `audit:read`. Audit details recursively redact credentials and content. Metrics expose
the same in-process counters and gauges as the authenticated `/metrics` endpoint.

## Error handling

Tool failures distinguish local validation, authorization, preview-token, Discord HTTP, rate-limit,
and runtime failures. Use the returned suggestion and request ID.

Do not retry unchanged arguments when:

- a local scope is missing;
- Discord returns 401 or 403;
- a preview token is expired, consumed, or mismatched;
- RateGuard has tripped;
- a schema says fields are mutually exclusive;
- a blueprint snapshot digest changed.

Correct the authority, permission, state, or arguments first. Retrying invalid Discord requests can
turn one configuration problem into an account or IP restriction.
