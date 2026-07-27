# PLAN.md v1 acceptance matrix

This matrix covers every non-deferred implementation phase in `PLAN.md`. Cloudflare/serverless
deployment and horizontal or multiple-active-replica operation are permanent exclusions, not future
work. UI/login, Social SDK, and voice-media transport are deferred or excluded as stated in PLAN.

| Phase | Delivered evidence | Acceptance evidence |
| --- | --- | --- |
| 0 — beta foundations | Exact Effect v4/MCP v2/TypeScript cohort in the lockfile; `McpInput`, request context, Effect SQL, and architecture decision record | Core schema/SQL tests; current npm dist-tags confirm MCP v2 stable does not exist |
| 1 — tracer bullet | `discord_guild_get`, managed Effect runtime, cancellable REST, stdio and HTTP transports | Server tracer-bullet tests, REST interruption tests, stdio-purity subprocess |
| 2 — complete REST catalog | Vendored OpenAPI pin, deterministic generator, 242 operations/150 paths, overrides, search/describe/preview, four risk dispatchers, multipart/blob/OAuth/secret paths | Catalog/dispatcher/REST tests, `spec:check`, Inspector inventory |
| 3 — presentations | Strict legacy/Components V2/modal schemas, validation/encoding, safe mentions, attachments, message/webhook semantic tools, opaque bindings | Presentation/template tests, server integration flow, raw-dispatch mention-policy tests |
| 4 — templates and blueprints | Mutable drafts, immutable revisions, typed rendering, guild snapshots, permission explanations, logical bindings, plan/token/apply/resume journal | Versioned-store, planner, permission, apply, stale-token, and partial-resume tests |
| 5 — operator surface and Gateway | 126-tool curated inventory, remaining Discord families, lazy/eager Gateway lifecycle, durable cursor/wait, presence and voice-state control | Full tools snapshot, catalog contracts, Gateway lifecycle/event tests |
| 6 — persistence and auth | Seven migrations, encrypted secrets, PAT CLI, OIDC/JWKS, trusted proxy identity, protected-resource metadata, host/origin/proxy startup guards | Database, PAT/auth/OIDC/proxy/config/HTTP tests; OIDC principal persistence and disabled-principal tests |
| 7 — OAuth profiles | PKCE authorization/callback, encrypted durable tokens, serialized refresh, profile dispatch, revoke-and-erase | OAuth state/refresh/restart/revoke/principal tests |
| 8 — interactions | Raw-body Ed25519 verification, PING, command/component ownership, durable dedupe/inbox, deterministic defer/follow-up, safe failure completion | Signature, deadline, dedupe, revision, opaque-handle, autocomplete, immediate/slow-failure tests |
| 9 — workflows and SDK | Draft/validate/publish/grant/enable/disable/rollback/delete, typed SDK, Promise/plain/Effect handlers, triggers, tails, command registry | Workflow store/runtime/manager/response/command-policy tests |
| 10 — sandbox and broker | Rootless Docker supervisor, immutable build artifacts, deterministic installs, non-root read-only runners, scoped credential RPC, Discord/KV/log/HTTP broker | Supervisor/broker tests and hostile sandbox suite with an actual cgroup OOM kill |
| 11 — routes and hardening | Namespaced routes, API key/bearer/HMAC policies, replay and CIDR controls, queues/budgets/causality, supervised retention, metrics/audit, restart recovery | Route, runtime-crash/timeout/orphan, retention, capability and integration tests |
| 12 — release | Docker Compose and four images, CI on Node 24 with frozen install/check/typecheck/unit/integration/package smoke, operator/security/recovery docs, 12 MCP eval scenarios | `release:check`, all four pinned Trivy image scans, live acceptance harness/checklist |

## Final executable gates

- `corepack pnpm release:check`: passed — Biome, typecheck, deterministic catalog, 149 unit tests,
  2 offline integration tests, stdio purity, Compose, hostile sandbox, build, 126-tool Inspector,
  12 evaluation scenarios, package tarball installation, and moderate dependency audit.
- `corepack pnpm image:audit`: passed — server, supervisor, workflow builder, and workflow runner
  contain no fixable HIGH/CRITICAL findings under pinned Trivy 0.72.0.
- `corepack pnpm test:e2e`: cleanly skipped because live Discord credentials were not supplied.
  The opt-in automated coverage and human-bound public/client checks are explicit in
  `docs/live-acceptance.md`; no live result is claimed.
- npm registry check: `@modelcontextprotocol/{server,client,node}` `latest` remains
  `2.0.0-beta.5`; the exact verified beta remains pinned.

No non-deferred implementation item is intentionally left open.
