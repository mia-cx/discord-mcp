# Observability

The service exposes four complementary signals: public health, structured process logs, durable audit
records, and in-memory metrics. Use correlation identifiers to move between them.

## Health endpoints

```text
GET /health/live
GET /health/ready
```

Both return:

```json
{ "ok": true }
```

They are intentionally unauthenticated and reveal no version, database path, Discord identity, or
dependency state. Liveness proves the HTTP process can answer. Readiness proves startup completed; it
does not prove every optional feature, Discord permission, Gateway session, or workflow is healthy.

## Structured logs

Logs are newline-delimited JSON on stderr. Depending on the event, fields can include:

- `timestamp`, `level`, `event`, and `outcome`;
- `requestId` and `principalId`;
- `workflowId`, `revision`, and `executionId`;
- `operationId`;
- `correlationId`, `causationId`, and causal depth context;
- `durationMs`;
- a redacted `detail` object.

In Compose:

```sh
docker compose logs --since=1h server supervisor
docker compose logs --follow server supervisor
```

Filter examples with `jq`:

```sh
docker compose logs --no-log-prefix server |
  jq 'select(.level == "error" or .level == "warning")'

docker compose logs --no-log-prefix server |
  jq 'select(.correlationId == "CORRELATION_ID")'
```

The redactor removes values under secret-, token-, authorization-, credential-, content-, body-, and
base64-like keys and scrubs recognizable bot/bearer/PAT strings. Redaction is defense in depth, not
permission to log secrets deliberately.

## Durable audit log

Mutating tool calls, administrative CLI changes, authentication/profile actions, and important
failure outcomes write audit rows to SQLite. Each row includes a cursor, principal, action,
target type/ID, request ID, redacted detail JSON, outcome, and timestamp.

Read with `discord_audit_list` using `audit:read`:

```json
{
  "cursor": 0,
  "limit": 50,
  "outcome": "failure"
}
```

Limits are clamped to 1–200. Advance the cursor using the last returned row. Omit `outcome` for both
success and failure.

Audit entries are retained for 90 days. Export them to your log or compliance system if a longer
window is required.

## Metrics

Metrics are process-local and reset on restart. Read them through either:

- `discord_metrics_snapshot`, which returns deterministic counter/gauge arrays over MCP; or
- authenticated `GET /metrics`, which returns Prometheus text format.

Both require `audit:read`. Example:

```sh
curl --fail \
  -H "Authorization: Bearer $DISCORD_MCP_PAT" \
  https://discord-mcp.example.com/metrics
```

The registry includes:

| Family | Meaning |
| --- | --- |
| `discord_mcp_discord_requests_total` | Discord calls by family, method, status, and outcome |
| `discord_mcp_discord_request_duration_milliseconds_*` | Discord request count and total duration |
| `discord_mcp_rate_limit_wait_milliseconds_*` | Discord bucket/global wait time |
| `discord_mcp_discord_retry_wait_milliseconds_*` | Retry backoff time |
| `discord_mcp_rate_guard_trips_total` | Local invalid-response guard trips |
| `discord_mcp_gateway_reconnects_total` | Gateway reconnects and reasons |
| `discord_mcp_interaction_deadlines_total` | Interaction deadline failures |
| `discord_mcp_interaction_defers_total` | Automatic interaction deferrals |
| `discord_mcp_workflow_queue_depth` | Current durable queue depth per workflow |
| `discord_mcp_workflow_duration_milliseconds_*` | Workflow execution count and total duration |
| `discord_mcp_workflow_failures_total` | Failed workflow executions |
| `discord_mcp_workflow_timeouts_total` | Workflow deadline failures |
| `discord_mcp_workflow_kills_total` | Supervisor runner kills by reason |
| `discord_mcp_blueprint_apply_total` | Blueprint apply outcomes |
| `discord_mcp_blueprint_apply_duration_milliseconds_*` | Blueprint apply count and total duration |
| `discord_mcp_sandbox_build_duration_milliseconds_*` | Workflow build count and total duration |
| `discord_mcp_sandbox_build_failures_total` | Workflow build failures |
| `discord_mcp_route_auth_failures_total` | Workflow route authentication failures |
| `discord_mcp_oauth_refresh_failures_total` | Discord OAuth refresh failures |
| `discord_mcp_tool_calls_total` | MCP tool calls by tool/outcome |
| `discord_mcp_tool_response_truncations_total` | Responses truncated at the configured limit |

The `*_count` and `*_sum` pairs are aggregate observations, not histograms. Derive a mean over a time
window from counter deltas; do not interpret the lifetime sum as a latency gauge.

## Suggested alerts

Alert on sustained conditions rather than one-off failures:

- readiness failure or container restart loops;
- any RateGuard trip;
- workflow queue depth that grows across multiple samples;
- workflow timeouts/kills increasing after a revision enable;
- interaction deadlines above zero;
- OAuth refresh failures for an active profile;
- repeated route authentication failures;
- sandbox build failures for a release candidate;
- Discord 401/403 growth or long rate-limit waits.

Because in-memory metrics reset on restart, scrape them into an external time-series store if history
matters.

## Correlation workflow

For a failed automation:

1. start from the MCP `requestId`, workflow `executionId`, or returned `correlationId`;
2. find the matching structured logs;
3. inspect the durable audit row for the principal, action, and redacted outcome;
4. retrieve the workflow execution and its bounded logs;
5. compare metric changes around the timestamp;
6. inspect Discord permissions only after confirming local scope/grant checks passed.

Correlation/causation IDs also reveal event loops: Discord mutations created by a workflow are tied to
their execution, and matching Gateway events inherit the root correlation with incremented causal
depth.
