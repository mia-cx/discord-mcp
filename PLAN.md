# Discord MCP Control Plane and Sandboxed Workflow Runtime

A self-hosted Discord automation platform driven by an AI agent through MCP.

## Context

You prompt an agent in your own editor/CLI; the agent performs Discord actions through MCP tools.
Discord is the action target, never the prompting surface.

Two capabilities are the point of the system, and everything else exists to support them:

1. **Sending messages in specific formats** — Components V2 layouts, legacy embeds, modals, and
   reusable versioned templates, all validated locally before any Discord request.
2. **Setting up servers** — roles, channels, categories, ordering, permission overwrites, forums,
   expressed as declarative blueprints with plan/apply and idempotent reconciliation.

Around them: complete callable coverage of the stable Discord HTTP API via a generated catalog, a
Gateway connection, a signed interactions endpoint, and agent-authored TypeScript workflows running in
isolated Docker containers with capability-brokered Discord access.

### Scope

**Included.** Discord HTTP API v10 stable · bot-token auth · Discord OAuth2 authorization-code flow
with PKCE and encrypted refresh tokens · Gateway lifecycle with configurable standard and privileged
intents · outbound Gateway actions (presence, voice-state) · incoming events as workflow triggers ·
slash/context commands, autocomplete, buttons, selects, modals · Ed25519-verified interactions
endpoint with deferred and follow-up responses · Components V2 for messages, interaction responses,
modals, and webhooks · versioned message templates with typed render variables · declarative server
blueprints with idempotent reconciliation · runtime-created workflows and namespaced HTTP routes ·
arbitrary npm dependencies inside sandbox builds · schedules and manual triggers · SQLite persistence,
audit history, retention, rollback · Docker Compose with Traefik compatibility · stdio and
authenticated Streamable HTTP MCP transports.

**Deferred.** Discord Social SDK native bridge — it supports standalone C++20+, Unity, and Unreal with
Linux experimental, and is a game-user runtime rather than a Node bot library
([platform compatibility](https://docs.discord.com/developers/discord-social-sdk/core-concepts/platform-compatibility));
provisional accounts additionally require Discord to configure your app. Bot voice media (joining for
playback, receiving audio, codecs, recording, FFmpeg). Horizontal scaling or multiple active
control-plane replicas. Hosted Cloudflare deployment. A bundled identity provider or login UI.
Automatically starting a new model turn when a Discord event arrives — MCP clients do not consistently
convert server notifications into agent turns, which is precisely why the workflow runtime exists.

**Prohibited.** User-token self-bots. Exposing raw Discord credentials to workflows. Letting workflows
mount host directories or the Docker socket. Letting workflows replace built-in root HTTP routes.
Treating CORS or the `Host` header as authentication. **Accepting arbitrary local filesystem paths in
MCP inputs.** Claiming API coverage for an operation no configured auth profile can execute.

---

## The Discord dependency boundary

**Do not use the assembled `discord.js` package.** Use its focused packages directly:

- **`@discordjs/rest`** — rate-limit buckets, request queues, retries, multipart HTTP, typed route
  requests.
- **`@discordjs/ws`** — Gateway identify/resume, heartbeats, reconnection, invalid-session recovery,
  sharding seam, outbound payload support.
- **`discord-api-types/v10`** — wire types, routes, permission flags, component types, Gateway payloads.
- **The generated OpenAPI catalog** — the authoritative REST operation surface.
- **Our own normalized, serializable Gateway events** and bounded persistent state.

Rationale:

- `discord.js` is an assembled high-level wrapper; we are deliberately building our own complete
  wrapper and policy layer. The project already publishes its REST and WS packages separately.
- Its managers transform API data into stateful classes backed by mutable caches. Those objects are
  awkward across SQLite, Effect Schema, RPC, audit logs, and sandbox boundaries.
- Some fundamental caches cannot safely be disabled without breaking `discord.js` behaviour, which
  conflicts with owning persistence and loading data explicitly.
- Risk classification, OAuth profiles, preview tokens, workflow grants, and complete OpenAPI coverage
  need operation IDs and raw request semantics — not manager methods.

```text
Discord wire protocols
  ├── @discordjs/rest        ├── @discordjs/ws        └── discord-api-types
                                   │
                                   ▼
Our Effect services
  ├── generated REST catalog       ├── normalized Gateway events
  ├── Components V2 presentations  ├── permissions and blueprints
  └── capability and risk enforcement
```

**No `discord.js` class instance crosses any boundary.** Everything traversing a service, persistence,
MCP, or workflow boundary is plain Effect-Schema-validated data.

---

## Verified foundations

Read from shipped artifacts on 2026-07-25/26. Several items contradict the published documentation.

### Effect v4 and MCP v2 interoperate natively

Verified against `effect@4.0.0-beta.101/dist/Schema.js` and
`@modelcontextprotocol/server@2.0.0-beta.5/dist/createMcpHandler-*.d.mts`:

- `Schema.toStandardSchemaV1(s)` attaches `~standard.validate` (mutates and returns `s`; idempotent).
- `Schema.toStandardJSONSchemaV1(s)` attaches `~standard.jsonSchema.{input,output}` to the **same**
  `~standard` object, supporting `target: "draft-2020-12"`, and inlines `$defs`.
- MCP v2's `registerTool` requires `StandardSchemaWithJSON` = both prop sets on one `~standard`; it
  calls `std.jsonSchema[io]({ target: "draft-2020-12" })` and `await std.validate(data)`.

**Therefore there is no adapter package.** The bridge is two calls. MCP throws if an `inputSchema`
root `type` is not `"object"`, so tool inputs are always `Schema.Struct` at the root.

**MCP v2 stable is expected 2026-07-28** (repo README). `registerTool` / `createMcpHandler` /
`serveStdio` / `requireBearerAuth` / `ProtocolError` were stable across beta.1→beta.5. Pin exact;
re-pin at GA in the final phase.

### Effect v4 — the actual API

`effect@4.0.0-beta.101`, published from `Effect-TS/effect` (the `effect-smol` repo was the v4
development line before it merged). The repo's own `MCP.md` and `SCHEMA.md` are **stale**; trust the
shipped `.d.ts`.

| Concern | v4 reality |
|---|---|
| Schema module | `effect/Schema` (capital S). `effect/schema` does **not** exist. |
| JSON Schema | `effect/JsonSchema`. `Schema.toJsonSchemaDocument(s)` → `{dialect, schema, definitions}`, always **draft-2020-12**. |
| `fromAST` / `topLevelReferenceStrategy` | **Removed** (0 grep hits). Merge `definitions` into `$defs` yourself. |
| Services | `Context.Service<Self, Shape>()("pkg/dir/Name")` with a `static readonly layer`. `Effect.Service`, `Context.Tag`, and the `dependencies` option are all **gone**; wire with `Layer.provide`. |
| Scoped layers | `Layer.scoped` → **`Layer.effect`** (it consumes the Scope, so `Effect.acquireRelease` inside just works). `Layer.scopedDiscard` → `Layer.effectDiscard`. |
| Runtime | **`Runtime<R>` was removed.** Use `effect/ManagedRuntime` to call into Effect from a promise-returning MCP handler. |
| Errors | `Schema.TaggedErrorClass<E>()("Tag", fields)` is house style — schema-backed, so it serializes across RPC. `Schema.ErrorClass<E>("Id")(fields)` for untagged. `Data.TaggedError` still works. `Schema.Defect()` wraps arbitrary causes. |
| Error formatting | No `effect/ParseResult`. `SchemaIssue.makeFormatterStandardSchemaV1()` (≈ArrayFormatter, yields `{path, message}[]`) and `SchemaIssue.makeFormatterDefault()` (≈TreeFormatter). |
| Decoding | `Schema.decodeUnknownEffect(s, {errors:"all"})`, failing with `Schema.SchemaError` (`_tag: "SchemaError"`, `.issue`). `decodeUnknownEither` → `decodeUnknownExit`. `validate*` removed. |
| Optionals | `Schema.optionalKey(S)` = exact optional; `Schema.optional(S)` = absent **or** `undefined`. `optionalWith` removed. |
| Filters | `Schema.filter` → `Schema.check(Schema.isMinLength(1), …)`; custom predicates via `Schema.makeFilter`. Built-ins are `is*`-prefixed. `positive`/`nonNegative` removed. |
| Variadics | `Schema.Union([A,B])`, `Schema.Literals([...])`, `Schema.Tuple([...])` take **arrays**. `Schema.Record(k, v)` went the opposite way. |
| Annotations | `.annotations({})` → `.annotate({})`, plus `annotateEncoded` (what JSON Schema sees) and `annotateKey`. |
| Config | **`Config.int`**, not `Config.integer`. `redacted`/`string`/`withDefault`/`nested`/`all` unchanged; new `Config.schema`, `Config.url`, `Config.port`. |
| Control flow | `Effect.catchAll`→`catch`, `catchAllCause`→`catchCause`, `Effect.either`→`Effect.result`, `Effect.async`→`Effect.callback`. `Either` is renamed **`Result`**. |
| SQL | `@effect/sql` has no 4.x — it is `effect/unstable/sql`. `@effect/sql-sqlite-node@4.0.0-beta.101` is zero-dependency, built on `node:sqlite` (so Node ≥ 22.5; we target 24). |
| HTTP | `effect/unstable/http` (`HttpRouter`, `HttpServerResponse`), served via `NodeHttpServer.layer`. |
| Logging | `Layer.succeed(Logger.LogToStderr)(true)` — the stdio-safety switch. Also `Logger.consolePretty({stderr:true})`. |
| Entrypoint | `Layer.launch(...)` + `NodeRuntime.runMain` — unchanged. |

**Beta discipline.** All Effect v4 packages stay on one version-aligned cohort, upgraded atomically as
a single dependency change gated on the full type, schema-conformance, persistence, RPC, and sandbox
suites. No source file imports an Effect v3 compatibility package. Falling back to v3 is not an
option. `effect/unstable/*` may break in minor releases **even after v4 GA**, so no `unstable/*` type
crosses a service boundary — wrap `unstable/sql` and `unstable/http` behind our own services.

TypeScript 7 is the target, but phase 0 must verify it against the selected Effect beta. If that
combination is broken, pin the newest TypeScript that Effect v4 supports and record the upstream issue.

### Discord Components V2

`IS_COMPONENTS_V2 = 1 << 15 = 32768`.

- **Set-only, never removable** from a message. Upgrading V1→V2 on edit requires clearing
  `content: null`, `poll: null`, `embeds: []`, `sticker_ids: []` **in the same request**, or Discord
  returns 400. A V2 message can never be edited back to legacy.
- With the flag set, sending `content`, `embeds`, `sticker_ids`, `poll`, or `shared_client_theme`
  **fails 400** — they are rejected, not ignored.
- Message components: ActionRow 1, Button 2, String/User/Role/Mentionable/Channel Select 3/5/6/7/8,
  Section 9, TextDisplay 10, Thumbnail 11, MediaGallery 12, File 13, Separator 14, Container 17.
  Modal-only: TextInput 4, Label 18, FileUpload 19, RadioGroup 21, CheckboxGroup 22, Checkbox 23.
  Type 16 is `@unstable` in `discord-api-types` and undocumented by Discord — **never emit it**.
- **Nesting:** Container cannot nest in Container. Section cannot nest in Section. Thumbnail is
  reachable *only* as `Section.accessory`. Section = 1–3 TextDisplays plus a **required** accessory
  (Button or Thumbnail). Max effective depth 3.
- **File's field is `file`, not `attachment_id`** — an unfurled media item, `attachment:` protocol
  only. Thumbnail and MediaGallery accept `attachment://` *or* https.
- **Uploaded files are invisible unless referenced by a component.** V1 auto-rendered them; V2 does not.
- `accent_color` is a **decimal integer** (`5793266`), never a hex string. `null` clears it.
- Button styles: Primary 1, Secondary 2, Success 3, Danger 4, Link 5, Premium 6. Styles 1–4 require
  `custom_id` and forbid `url`; style 5 requires `url` and forbids `custom_id`; style 6 requires
  `sku_id` and forbids `custom_id`/`label`/`url`/`emoji`. Styles 5 and 6 never fire an interaction.
- **Hard limits (reject):** 40 total components counted recursively · MediaGallery 1–10 items ·
  ActionRow 5 buttons XOR 1 select · string select ≤25 options · button label ≤80 · TextDisplay
  content 1–4000 · Thumbnail/gallery `description` ≤1024 · `custom_id` 1–100.
- **Advisory limits (warn only, undocumented by Discord):** message-wide 4000-character text budget
  (only the per-TextDisplay 4000 is verifiable, in `@discordjs/builders`) · 10 top-level components
  (from an April 2025 changelog that also stated a since-raised "30 total") · Container's 10 children
  (JSDoc only, unenforced). Warning rather than rejecting means a Discord change never breaks a valid
  send.
- **Webhook trap:** `with_components` defaults to **`false`**, so components are silently dropped
  without `?with_components=true` — and since the flag forbids `content`, the result is an empty
  message or a 400. Non-application-owned webhooks can only send non-interactive components even with
  the parameter.
- Deferred interaction responses (callback type 5) **cannot** set the flag; V2 content must be created
  by editing the original response.

Reference: [Components](https://docs.discord.com/developers/components/reference) ·
[Message resource](https://docs.discord.com/developers/resources/message).

### Discord REST

- The stable OpenAPI document contains **242 operations across 150 paths** at the initial pin. Treat
  those as facts about the pin, not constants. Pin `discord/discord-api-spec` at SHA
  `74fda0fad044407ea280043a03ffc9bc64c4e49e` (2026-07-18) and record commit, fetch timestamp, content
  digest, and counts in `vendor/discord/source.json`.
- **0 of 242 operations have a `summary`**; 17 have a `description`. Search cannot be summary-driven.
- **Path parameters live on the path item, not the operation.** 130 of 150 paths carry
  `paths[p].parameters`; operation-level parameters are query-only. Reading `op.parameters` alone
  yields *zero* path parameters. The single easiest thing in the project to get wrong.
- **Five operations reject a bot token** — `get_current_user_application_entitlements`, the three
  `/users/@me/applications/{id}/role-connection` operations, and `get_my_guild_member`. They are
  reachable with an **OAuth2 bearer**, so they are refused only when the resolved auth profile is
  `bot`, never unconditionally.
- **Cloudflare bans the IP after 10,000 401/403/429 responses in 10 minutes.** 400s are free. This is
  the dominant operational hazard for an agent-driven server.
- **`MESSAGE_CONTENT` gates message content over REST too**, not just the Gateway — `content`,
  `embeds`, `attachments`, and `components` come back empty without it.
- `discord-api-types@0.38.51` exports every V2 component type, including
  `APIMessageTopLevelComponent` (which correctly excludes Thumbnail and bare buttons) and
  `APIComponentInContainer` — the best types to encode against.
- Discord's OpenAPI repository is explicitly a public preview with missing descriptions and known
  schema quirks ([spec repo](https://github.com/discord/discord-api-spec)).

---

## Stack

pnpm workspace, Node 24, TypeScript 7 strict, Biome 2.5 as the only formatter and linter, `tsc` for
build (unbundled output keeps `Cause.pretty` pointing at real files, which is the whole debugging
story for a multi-process sandboxed system), `tsx` for dev.

```
effect 4.0.0-beta.101                                # + effect/unstable/{sql,http}
@effect/platform-node · @effect/sql-sqlite-node · @effect/vitest    all 4.0.0-beta.101
@modelcontextprotocol/{server,express,node,client} 2.0.0-beta.5     # client = tests only
@discordjs/rest 2.6.3 · @discordjs/ws 2.0.4 · discord-api-types 0.38.51
ajv 8 + ajv-formats · jose · argon2 · node:crypto AES-256-GCM
```

**MCP v2 official SDK, not `effect/unstable/ai/McpServer`.** The Effect module is more idiomatic but
is pinned to protocol `2025-06-18`, has **no** auth surface (grep `auth|oauth|bearer` → zero hits),
and lives in `unstable/*`. This system needs OAuth resource-server behaviour behind Traefik, and the
bridge to the official SDK is two calls — so idiom loses to the auth story.

Application code defines no Zod schemas. A transitive Zod dependency inside the MCP SDK is acceptable.

---

## Architecture

```text
MCP client
  ├── stdio: trusted local administrator
  └── Streamable HTTP via Traefik
        ├── OAuth/OIDC access token   ├── scoped PAT   └── trusted proxy identity
                    ▼
Discord MCP control plane  (sole holder of Discord credentials)
  ├── MCP tool registry          ├── operation catalog       ├── auth & authorization
  ├── presentation encoder       ├── blueprint reconciler    ├── workflow control plane
  ├── interactions router        ├── event broker            ├── capability broker
  ├── RateGuard                  └── SQLite repositories
        ├── @discordjs/rest ──► Discord HTTP
        ├── @discordjs/ws  ──► Discord Gateway
        └── sandbox supervisor  (sole holder of the rootless Docker socket)
              └── isolated workflow containers
                    immutable source+deps · no credentials · capability RPC only
                    restricted filesystem/network/resources
```

Workflow containers receive a revision-specific capability credential useful only against the broker
and only within that revision's grants.

### Workspace layout

One repository, one lockfile, one coordinated release, three executables: **`server`** (MCP
transports, HTTP, Discord REST/Gateway, interactions, auth, persistence, workflow control plane, event
broker, capability broker), **`sandbox-supervisor`** (the only process allowed to control rootless
Docker), **`cli`** (secrets, blobs, principals, tokens, migrations, diagnostics, recovery).

A shared package must justify itself by defining at least one of: a deployment or security boundary; a
public API consumed by agent-authored workflows; a separately testable domain boundary with multiple
consumers; or generated artifacts whose lifecycle differs from application code. Curated tool families
stay as modules inside `apps/server` — not one package per Discord feature. Internal packages are not
independently versioned or published. **`workflow-sdk` is the intentional exception:** it is published
and follows semver because sandboxed workflow projects depend on it.

```text
apps/{server,cli,sandbox-supervisor}
packages/
  core/                   # ids, errors, MCP bridge, request context, shared schemas
  discord-api/            # REST service, catalog, RateGuard, permissions
  discord-gateway/        # @discordjs/ws lifecycle, normalized events
  discord-presentations/  # ★ Components V2, modals, legacy, templates
  discord-blueprints/     # ★ snapshot, diff, plan, reconciliation journal
  auth/ persistence/ workflow-sdk/ workflow-runtime/ test-support/
docker/{server,supervisor,workflow-runner}.Dockerfile · compose.yaml
vendor/discord/{openapi.json,source.json,overrides.json}
native/social-sdk-bridge/   # deferred, no initial implementation
```

`core` holds the MCP bridge because everything depends on it and it must not depend on Discord.
`discord-presentations` and `discord-blueprints` are packages because each is a separately testable
domain with multiple consumers (MCP tools, workflow SDK, interactions router).

---

## The bridge: Effect v4 ↔ MCP v2

```ts
// packages/core/src/mcp/schema.ts
import { Schema } from "effect"

/** Effect Schema -> StandardSchemaWithJSON, exactly what MCP v2 registerTool consumes. */
export const McpInput = <S extends Schema.Top>(s: S) =>
  Schema.toStandardJSONSchemaV1(Schema.toStandardSchemaV1(s))

/** Standalone JSON Schema for the catalog, elicitation, and MCP resources. */
export const toJsonSchema = (s: Schema.Top) => {
  const doc = Schema.toJsonSchemaDocument(s)
  const out: Record<string, unknown> = { ...doc.schema }
  if (Object.keys(doc.definitions).length > 0) out.$defs = doc.definitions
  return out
}
```

`$defs`-embedded is correct: MCP requires *self-contained*, and internal `#/$defs/` references are
legal. v4 ships no full inliner; write one only if a client proves unable to follow refs.

```ts
// packages/core/src/mcp/tool.ts
export interface ToolDef<A, Out, R> {
  name: string                    // ^[a-z0-9_]{1,64}$
  title: string; description: string
  toolset: "operator" | "automation" | "admin" | "api"
  gate?: "always" | "gateway" | "workflows"
  risk: RiskClass
  scopes: ReadonlyArray<Scope>
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean
                 idempotentHint?: boolean; openWorldHint?: boolean }
  input: Schema.Struct<any>; output?: Schema.Top
  handler: (args: A) => Effect.Effect<Out, unknown, R | McpRequestContext>
}
export const defineTool = <A, Out, R>(d: ToolDef<A, Out, R>) => d
```

An identity function whose only job is inference. Handler `R` unions across every tool, so the
compiler proves the application layer satisfies all requirements.

**Registry** — a `Context.Service` that filters by selected toolset and gate, then builds every JSON
Schema **eagerly during layer construction**, so an unrepresentable schema fails startup naming the
offending tool rather than failing later at `tools/list`. It asserts each root is `type: "object"` and
each name matches the regex, then calls `registerTool`.

**The Effect↔Promise boundary.** `Runtime<R>` was removed in v4, so build one `ManagedRuntime` from
the application layer and reuse it for every handler:

```ts
const runtime = ManagedRuntime.make(AppLayer)   // once, at startup

const callTool = async (tool, args, ctx: ServerContext) => {
  // Transport-level facts, all known before authorization runs.
  const request = {
    signal: ctx.mcpReq.signal,
    requestId: ctx.mcpReq.id,
    progressToken: ctx.mcpReq._meta?.progressToken,
    notify: ctx.mcpReq.notify,
    authInfo: ctx.http?.authInfo,
  }

  // Authorize FIRST, then build the context. `provideService` cannot be
  // back-filled, so the principal must be resolved before any downstream
  // service, audit record, or Discord call can observe the context.
  const program = authorize(request, tool).pipe(          // scope + risk
    Effect.flatMap((principal) =>
      Effect.gen(function* () {
        const decoded = yield* Schema.decodeUnknownEffect(tool.input, { errors: "all" })(args)
        const out = yield* tool.handler(decoded)
        return tool.output ? yield* Schema.encodeEffect(tool.output)(out) : out
      }).pipe(
        Effect.provideService(McpRequestContext, { ...request, principal }),
        Effect.annotateLogs({ principal: principal.id }),
      ),
    ),
    Effect.withLogSpan(`tool:${tool.name}`),
  )

  const exit = await runtime.runPromiseExit(program, { signal: ctx.mcpReq.signal })
  return Exit.match(exit, { onFailure: (c) => errorResult(renderCause(tool, c)),
                            onSuccess: (v) => successResult(tool, v) })
}
```

Four invariants:

1. **The principal is resolved before the context exists.** Authorization runs outside the provided
   scope and its result is folded in, because a service cannot be back-filled after it is provided.
   Anything reading `McpRequestContext` — audit records, the capability broker, `DiscordRest` — sees a
   complete principal or the request never reaches it.
2. **The cancellation signal is used twice** — passed to `runPromiseExit` so client cancellation
   interrupts the fiber and runs finalizers, *and* placed in `McpRequestContext` so `DiscordRest`
   hands it to `@discordjs/rest`'s `RequestData.signal`, aborting the in-flight HTTP request rather
   than abandoning it. Read it with `Effect.serviceOption` so REST also works outside a tool call
   (startup probes, workflows, tests).
3. **Domain failures return `CallToolResult` with `isError: true`** and actionable text so the model
   self-corrects. Unknown tools and protocol-shape failures follow the SDK's protocol-error behaviour;
   only `UrlElicitationRequiredError` propagates from a handler as a protocol error.
4. **`runtime.dispose()` on shutdown**, so the Gateway is destroyed and containers stopped in
   finalizer order before the process exits.

All tool schemas are generated before the transport accepts connections. **Stdio owns stdout
exclusively;** Effect logs and defects go to stderr. Tool descriptions state required Discord
permissions, required local scopes, destructive behaviour, important mutual exclusions, and the next
diagnostic tool to call after a likely failure.

> **Phase-0 gate:** `ManagedRuntime.runPromiseExit(program, { signal })` — the options bag is
> unverified in beta.101. Fallback: `Effect.interruptWhen` + `Effect.callback` on abort. The
> abstraction absorbs either.

---

## Discord API coverage

### Generated catalog

`pnpm spec:generate` distils the vendored spec deterministically. Per operation: operation ID · method
and path template · parameter schemas (**path-item merged with operation-level**) · request-body and
multipart schemas · response schemas · authentication modes · required OAuth scopes when documented ·
risk classification · operation family · pagination style · audit-log-reason support · sensitive
parameters that must resolve through secret references · documentation link · project overrides and
rationale · search tokens from operation IDs, method synonyms, path segments, and a maintained gloss.

Recursive component schemas stay as `$ref` graphs with a scoped `$defs` closure rather than being
dereferenced — Discord's schemas are recursive (`Channel.parent`, `Message.referenced_message`,
component trees), so full inlining would not terminate.

Two tiers: a **~46 KB statically imported index** that powers search and all local validation, and a
**lazily loaded schema map** (539 component schemas, `$ref` rewritten to `#/$defs/`, per-operation
transitive closures as name lists) assembled on demand and memoized.

**CI fails when:** a vendored operation has no catalog entry · an operation has no risk class · an
operation has no authentication class · a sensitive parameter would be exposed as an ordinary MCP
string · generated output differs from committed output · the pinned SHA does not match the vendored
file · **a path template contains a parameter missing from its generated operation entry** (the
invariant that catches the path-item bug) · **an operation cannot be executed by any supported bot,
OAuth2, webhook, or interaction auth mode**.

`pnpm spec:drift` fetches upstream read-only and reports additions, removals, and schema changes. It
never silently updates the vendor. `spec:generate` also warns about operations with neither a gloss
nor a curated tool, so search-quality drift is visible at build time rather than discovered by a
confused agent.

### Risk classes

`read` (no mutation) · `write` (creates/updates, normally reversible) · `destructive` (deletes, bans,
kicks, prunes, bulk changes) · `bot_admin` (bot identity, application metadata, commands, privileged
configuration, global presence) · `credential` (OAuth exchange/refresh/revocation, webhook and
interaction tokens — handled only by dedicated services, never exposed as a tool).

### Generic API tools

`discord_api_search` · `discord_api_describe` · `discord_api_preview` · `discord_api_read` ·
`discord_api_write` · `discord_api_destructive` · `discord_api_admin`

Splitting the dispatcher by risk class puts the risk in the tool name and makes it structurally
impossible to reach a destructive operation through the read tool.

```ts
// search
{ query?: string; method?: "GET"|"POST"|"PUT"|"PATCH"|"DELETE"
  family?: OperationFamily; auth?: "bot"|"oauth2"|"webhook"|"interaction"
  risk?: RiskClass; limit?: number /* default 20, max 100 */; cursor?: string }

// dispatch
{ operationId: string; authProfile?: string /* default "bot" */
  path?: Record<string, string>; query?: Record<string, unknown>; body?: unknown
  files?: ReadonlyArray<AttachmentInput>; auditLogReason?: string; previewToken?: string }
```

Rules: the dispatcher resolves only cataloged operation IDs — never an arbitrary URL, raw
authorization header, or raw Discord token. `read`/`write` dispatchers accept only their own class.
`destructive` requires `mcp:destructive` plus an unexpired preview token; `admin` requires `bot:admin`
plus a preview token. **Preview tokens expire after 60 seconds** and bind principal, operation,
normalized argument hash, auth profile, and resolved targets. `credential` operations are rejected and
redirected to the dedicated OAuth, interaction, or secret-management flows.

**Every dispatch validates locally before any network call:** resolve the operation · check the
resolved auth profile can execute it (**this is where the five bot-incompatible operations are refused
— only under a `bot` profile, since an OAuth2 profile can call them**) · require every `{param}` with
`*_id` matching `^\d{17,21}$` · reject query keys absent from the catalog, because Discord silently
ignores unknown parameters and a typo would otherwise become a mysterious wrong answer ·
percent-encode segments · validate the body with **AJV 2020** against the catalog schema (the
authoritative input is already JSON Schema, so this is nearly free and converts a round trip into an
immediate fixable message) · consult `RateGuard`.

Response validation is strict Effect Schema for curated tools, best-effort in development and CI for
raw dispatch, and **warning-only in production** for raw dispatch, because Discord's preview spec
under-describes real response variants.

Search results name the matching curated tool when one exists. Describe results include a ready-to-use
dispatcher example, required permissions and scopes when known, request schemas with their transitive
`$defs`, multipart rules, and any override warnings.

### Standard tool result

```ts
type DiscordToolResult<A> =
  | { ok: true; data: A
      meta: { requestId: string; operationId?: string; authProfile: string
              pagination?: { hasMore: boolean; nextCursor?: string }; truncated: boolean }
      warnings: ReadonlyArray<string> }
  | { ok: false
      error: { code: string; message: string; retryable: boolean
               httpStatus?: number; discordCode?: number; retryAfterMs?: number
               missingPermission?: string; suggestion?: string }
      meta: { requestId: string } }
```

Failed results set MCP `isError: true`. Responses default to structured JSON plus concise text.
Responses above 25,000 characters truncate with an explicit cursor or resource link. Discord
rate-limit metadata is surfaced without leaking bucket internals.

---

## Curated tools and toolsets

Hybrid catalog: curated tools for what an operator commonly asks for, generated API tools for uncommon
or newly added operations. Curated tools use strict Effect v4 input/output schemas, **named permission
flags instead of raw bitfields**, actionable descriptions, MCP annotations, and the same cataloged
operation service as generic dispatch.

Registration is grouped into startup-selected toolsets so clients do not pay schema cost for
irrelevant capabilities:

- **`operator`** (default) — discovery, messages, Components V2, guild inspection, roles, channels,
  permissions, members, threads/forums, moderation, webhooks, invites, events, bot, Gateway.
- **`automation`** — workflows, templates, interactions, executions, event tails.
- **`admin`** — OAuth, principals, credentials, audit, application configuration, blueprint apply.
- **`api`** — the seven complete-coverage catalog tools.

The selected set is stable for the process lifetime. **Authorization remains per call; hiding a
toolset is context optimization, not a security boundary.**

**Guild discovery and diagnostics.** `guild_list` · `guild_get` · `guild_inspect` · `channel_list` ·
`channel_get` · `member_list` · `member_get` · `member_search` · `role_list` · `permissions_explain`.

`guild_inspect` returns a bounded, cursor-aware structural view suitable for planning: guild settings,
categories, channels, positions, role hierarchy, named permission flags, channel overwrites, feature
flags, onboarding/welcome configuration, and the bot's effective permissions.

**Messaging.** `message_validate` · `modal_validate` · `message_send` · `message_edit` · `message_get`
· `message_list` · `message_delete` · `message_bulk_delete` · `message_crosspost` ·
`message_pin_update` · `message_reaction_update` · `message_thread_create`.

**Templates.** `message_template_{list,get,create,update_draft,validate,publish,render,archive}`.

**Blobs.** `blob_put` · `blob_get_metadata` · `blob_delete`.

**Blueprints.** `server_snapshot` · `server_blueprint_{list,get,create,update_draft,validate,publish,archive}`
· `server_blueprint_plan` · `server_blueprint_apply`.

Blueprints follow the same draft/publish lifecycle as message templates, and for the same reason:
`server_blueprint_revisions` stores immutable published revisions, and a preview token binds a
*specific* revision digest, so an apply cannot silently target edited desired state. Drafts are
mutable; publishing freezes a revision; `plan` and `apply` operate only on published revisions.
`archive` retires a blueprint without touching the guild or its bindings.

**Channels and permissions.** `channel_{create,update,delete,reorder}` ·
`channel_overwrite_{set,delete}` · `forum_post_create` · `thread_{list,update,member_update}`.

**Roles and members.** `role_{create,update,delete,reorder,assign,remove}` · `member_update`.

**Moderation.** `member_{timeout,kick,ban,unban}` · `ban_list` ·
`automod_rule_{list,create,update,delete}` · `audit_log_list`.

**Webhooks, invites, events, assets.** `webhook_{list,create,execute,delete}` ·
`invite_{create,list,revoke}` · `scheduled_event_{list,create,update,delete}` ·
`emoji_{list,create,delete}` · `sticker_{list,create,delete}`.

**Bot, application, commands, Gateway.** `bot_get_profile` · `bot_update_profile` ·
`application_{get,update}` · `application_command_{list,publish,delete}` · `presence_set` ·
`gateway_status` · `gateway_recent_events` · `gateway_wait_for_event`.

All names carry the `discord_` prefix. Channel creation uses a discriminated union per channel kind so
forum-only, voice-only, and category-only fields cannot be mixed. Permission inputs use named
allow/deny flags and reject the same flag appearing in both sets. Every role mutation checks the bot's
hierarchy first and explains impossible operations locally; managed/integration roles and `@everyone`
are rejected where Discord does not permit the requested change. Timeouts accept either a duration or
an absolute timestamp. Kick, ban, bulk-delete, destructive AutoMod changes, and prune require
destructive scope and a bound preview token. Bot/application/command mutations require `bot:admin`;
global command publication additionally requires a preview token. Webhook tokens are stored as
encrypted secret references and never returned.

---

## ★ Presentations: Components V2, modals, templates

`packages/discord-presentations` owns the schemas, validator, encoder, and renderer. It is used
identically by MCP tools, the interactions router, and the workflow SDK.

### One canonical presentation type

```ts
type MessagePresentation =
  | { type: "legacy"; content?: string; embeds?: ReadonlyArray<Embed>
      components?: ReadonlyArray<LegacyActionRow>; poll?: Poll
      attachments?: ReadonlyArray<AttachmentInput> }
  | { type: "components_v2"; components: ReadonlyArray<ComponentsV2TopLevel>
      attachments?: ReadonlyArray<AttachmentInput> }
  | { type: "template"; templateId: MessageTemplateId; revision?: number; variables: unknown }
```

The Components V2 schema uses **semantic discriminators** — `text`, `section`, `thumbnail`,
`mediaGallery`, `file`, `separator`, `container`, `actionRow`, `button`, and the select variants — and
the encoder maps them to Discord's numeric types. Semantic tags are markedly easier for a model to
emit correctly than `type: 10`, and they let the encoder own every numeric detail. The schema models
allowed child and accessory relationships structurally rather than accepting arbitrary recursive JSON:

```ts
const Text = Schema.Struct({
  type: Schema.Literal("text"),
  id: Schema.optionalKey(Schema.Int),
  content: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(4000)))
    .annotate({ description: "Markdown. Mentions, custom emoji, headings, -# subtext." }),
}).annotate({ title: "Text",
  description: "Markdown block. The V2 replacement for message content and embed description." })

const Section = Schema.Struct({
  type: Schema.Literal("section"),
  components: Schema.Array(Text).pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(3))),
  accessory: Schema.Union([Button, Thumbnail]),        // REQUIRED
})

const Container = Schema.Struct({
  type: Schema.Literal("container"),
  accentColor: Schema.optionalKey(Schema.Int.pipe(
    Schema.check(Schema.isBetween({ minimum: 0, maximum: 0xffffff })))),
  spoiler: Schema.optionalKey(Schema.Boolean),
  components: Schema.Array(Schema.Union([ActionRow, Text, Section, MediaGallery, Separator, File])),
  //                              ^ no Container (no nesting), no bare Thumbnail or Button
})

export const ComponentsV2TopLevel = Schema.Union([
  ActionRow, Container, File, MediaGallery, Section, Separator, Text])
```

Button is a **discriminated union on style**, so the style↔field matrix is a type error rather than a
400. `accentColor` is exposed as an integer and documented as such (`0x5865f2`), since Discord's wire
field is decimal.

### Modals are a separate presentation

`ModalPresentation` covers text displays, labels, text inputs, selects, file uploads, radio groups,
checkbox groups, and checkboxes. **Message-only and modal-only components cannot cross the
boundary** — types 4/18/19/21/22/23 are modal-only, 9/11/12/13/14/17 are message-only, and the type
system enforces it. `discord_modal_validate` exercises the same encoder the workflow interaction
handlers use, without attempting to open a modal outside an interaction.

### Validation, all local, all before any request

- `IS_COMPONENTS_V2` is **set automatically** and cannot be manually toggled. Components V2 cannot
  carry legacy `content`, `embeds`, stickers, or polls — rejected at the tool boundary with a clear
  message rather than forwarded to a 400.
- **V1→V2 edit transition:** when an edit adds V2 components to a legacy message, the encoder emits
  `content: null`, `poll: null`, `embeds: []`, `sticker_ids: []` in the same request. A V2 message can
  never be edited back to legacy.
- Hard rejects: ≤40 total components counted recursively · valid nesting and child counts · unique
  explicitly supplied numeric IDs · unique `custom_id` values · per-component length limits · Section
  accessory present · MediaGallery 1–10 · ActionRow 5 buttons XOR 1 select.
- Warnings: message-wide 4000-character total · >10 top-level components · >10 Container children.
  These three are undocumented by Discord, so they never block a send.
- File components reference an uploaded `attachment://filename`; **every reference resolves exactly
  once**, filenames are normalized safely, and an uploaded attachment referenced by nothing produces a
  warning — in V2 it uploads and is invisible, which is the most common silent failure.
- **Link and premium buttons need no handler. Every other interactive component must bind** either to
  a published workflow action or to a persisted event-inbox key.
- **`custom_id` values exposed to Discord are opaque server-generated handles**, ≤100 characters, bound
  to the owning message/template/workflow revision. Workflow state lives server-side. Discord
  round-trips `custom_id` through the client, so anything encoded in it is untrusted input on the way
  back; treating it as trusted data would be a genuine vulnerability.
- Webhook component sends set `with_components=true`.
- Deferred interaction responses create V2 content by editing the original response, respecting
  Discord's callback restrictions.

`discord_message_validate` runs the exact local validation and encoding path without sending, and is
the preferred tool while authoring a complex presentation. It returns the normalized Discord payload,
attachment manifest, component count, mention analysis, interactive bindings, required permissions,
warnings, and an **ASCII layout preview** so the model can see the structure it just described.

### Mention safety

Every presentation defaults to:

```ts
allowedMentions = { parse: [], repliedUser: false }
```

Specific users and roles are allowlisted explicitly. `@everyone`, `@here`, or parse-all behaviour
requires an explicit request **and** the `mentions:broad` scope. Components V2 text displays receive
the same mention analysis as legacy content. This is a safe default rather than a permission gate —
Discord still governs whether the bot *may* mention — but it prevents the most embarrassing accident.

### Versioned message templates

A template holds a **serializable declarative variable-schema AST** supporting bounded strings,
numbers, booleans, snowflakes, URLs, timestamps, enums, arrays, objects, optionals, and defaults. The
control plane compiles that AST to Effect v4 Schema. **Templates cannot submit executable transforms
or arbitrary code**, and no JavaScript expression or general template-evaluation language runs in the
control plane. Interpolation is structural: each variable node declares `plainText`,
`discordMarkdown`, `inlineCode`, `codeBlock`, `url`, or explicit mention formatting, and rendering
escapes according to that target context.

A template also holds a legacy or Components V2 presentation AST, defaults, and optional workflow
interaction bindings. Drafts are mutable; **published revisions are immutable.** Rendering validates
variables, escapes them, produces a `MessagePresentation`, and passes through the same message
validator as any hand-authored send. Workflows may pin a revision or explicitly follow latest
published. Reads and renders require `template:read`; draft and publication changes require
`template:write`.

### Attachments and blobs

**MCP inputs never accept an arbitrary local filesystem path.** The MCP transport can be remote and
authenticated, so accepting a path would let a remote principal read arbitrary server files.
`AttachmentInput` accepts bounded inline base64 or a **named blob reference** previously uploaded via
the local CLI or the authenticated blob endpoint. Profile images use the same mechanism.

Large files use `discord-mcp blobs put <path>` — where only the CLI process reads the explicitly
supplied path — or authenticated streaming `POST /blobs`. Stored blobs are content-addressed,
principal-owned, size- and MIME-validated, quota-limited, and garbage-collected when unreferenced
after retention. **Blob content is never returned through MCP.**

---

## ★ Declarative server blueprints

A blueprint describes: guild settings the bot may manage · roles with **stable logical keys**, names,
colors, hoist/mention behaviour, named permission flags, and relative ordering · categories and text,
voice, stage, announcement, forum, and media channels with logical keys, settings, relative ordering,
and parents · permission overwrites referring to blueprint role keys, known Discord role IDs, members,
or `@everyone` · forum tags and default reaction/layout/sort settings · optional onboarding, welcome
screen, rules, AutoMod, and system-channel configuration.

**Logical keys with persisted bindings, not name matching.** Names are neither unique nor stable in
Discord; matching by name creates duplicates on rename and picks the wrong object when names collide.
Each blueprint object carries a logical key, and `server_blueprint_bindings` maps key → snowflake, so a
rename preserves identity.

**Planning never mutates Discord.** It resolves logical keys through persisted bindings, compares
normalized desired and actual state, checks the bot's permissions and role position, and returns an
ordered diff. Apply requires a 60-second preview token bound to principal, guild, blueprint digest,
auth profile, **current guild snapshot digest**, and the exact action list, plus the `server:apply`
scope. Planning requires `server:plan`. Managed deletion additionally requires `mcp:destructive`.

Default-conservative behaviour:

- Reapplying the same blueprint is idempotent — a converged guild yields a zero-action diff.
- **Unmanaged Discord resources are never changed or deleted.** Existing resources are adopted only
  through an explicit binding.
- Renames preserve bindings rather than create duplicates.
- Deletion is disabled unless the blueprint marks a previously managed object absent **and** the caller
  explicitly enables `deleteManaged`; those deletions use destructive authorization.
- **Apply uses an execution journal.** Discord has no transactions, so partial failure returns
  completed, pending, and compensatable actions, and can safely resume from the journal after a
  restart.
- Ordering is derived, not requested: roles created and ordered before channels; categories before
  children; permission overwrites after role and channel IDs resolve; position updates batched last.
- Role hierarchy violations — the bot can only manage roles strictly below its highest and only grant
  permissions it holds — are reported at **plan** time naming the specific role, never discovered as a
  mid-apply 403.

## Permission diagnosis

`discord_permissions_explain` computes effective permissions for a member, role set, or the bot in a
channel. It follows Discord's owner and administrator short-circuits and the full overwrite order —
base `@everyone` → aggregated role permissions → `@everyone` overwrite → role denies → role allows →
member deny → member allow — returns permission **names**, and explains which role or overwrite
produced each important allow or deny.

Every 403 renderer directs the agent here instead of inviting retries. This matters more than it
sounds: a model's reflex on 403 is to retry with permuted arguments, and that is exactly the behaviour
that walks toward Cloudflare's 10,000-invalid-response ban. One cheap deterministic diagnostic
converts a retry loop into a report to the user. Permission flags come from `discord-api-types`'
`PermissionFlagsBits` with BigInt arithmetic — decimal strings in API v8+ exceed `2^53`.

---

## Gateway and events

`@discordjs/ws` `WebSocketManager` sharing the `@discordjs/rest` instance — one token, one rate-limit
pool. It owns identify, resume, heartbeats, reconnection, invalid-session recovery, intent
configuration, outbound payloads (presence, voice state), and the sharding seam. Everything above that
is ours.

Gateway mode is `off`, `lazy`, or `eager`, defaulting to **`lazy`**: REST-only operation opens no
WebSocket, so the common case pays nothing. The first Gateway-dependent tool or enabled workflow
connects through a `SynchronizedRef` single-flight latch so two concurrent calls cannot open two
sockets. The connection's finalizer attaches to the application scope, so it outlives the triggering
call but is destroyed before process exit.

`ManagerShardEventsMap` emits **positional** arguments (`Dispatch: [payload, shardId]`); handlers
bridge into Effect through the `ManagedRuntime`. Every event is **normalized into plain serializable
data** — no library class instances — and receives a persistent monotonic sequence number, the Discord
event ID where available, received time, correlation ID, and causation ID, then lands in a
`PubSub.sliding` hub plus a bounded persistent ring.

**The cursor closes a real race.** An MCP call is request/response, so "subscribe → act → observe" is
impossible in one call:

```
discord_gateway_recent_events({ limit: 1 })        → latestCursor
discord_message_send(...)                          → post a question
discord_gateway_wait_for_event({ types, filter, cursor, waitMs: 25000 })
```

`wait_for_event` **subscribes first, then drains persisted events after the requested cursor, then
waits** — so an event arriving between the action and the wait is not lost. Default `waitMs` 25 s
(inside every client's 60 s default), hard cap 120 s, with MCP progress notifications every 5 s when a
`progressToken` is present. **Timeout is a successful empty result carrying a fresh cursor, not an MCP
error** — "nothing arrived" is a legitimate answer, and flagging it invites pointless retries. The
durable inbox remains authoritative if the client disconnects.

Privileged intents are disabled by default. Enabling a workflow that requires an unavailable intent
fails with an actionable error naming the required Developer Portal setting
([intents](https://docs.discord.com/developers/events/gateway#gateway-intents)). Close codes map to
corrective instructions — 4004 invalid token · 4013 an intent name is not real · **4014 disallowed
privileged intents, enable them at `discord.com/developers/applications/<id>/bot`**, the most common
new-bot failure.

**`MESSAGE_CONTENT` redaction is diagnosed, not silently returned.** The REST layer detects the
signature — 2xx, non-empty message array, every `content` empty — and appends the required-intent
diagnosis. The intent gates content over REST as well as the Gateway, and everyone assumes empty
strings are a bug in the server.

Voice-media transport is not implemented; voice/stage REST operations and member voice-state control
remain available.

---

## Interactions and component routing

```text
POST /discord/interactions
```

Preserve the **raw** request body; validate Discord's timestamp and Ed25519 signature **before** JSON
decoding; reject stale timestamps and invalid signatures. Answer `PING`. Dispatch only to an enabled
published workflow revision. Deduplicate interaction IDs and enforce command/component ownership.
**Resolve opaque component handles** to their persisted event-inbox or published-workflow binding.
Default to deterministic deferral when a handler does not respond immediately, using a **2.5-second
internal deadline** to leave margin under Discord's three-second initial-response requirement
([timing](https://docs.discord.com/developers/interactions/receiving-and-responding)). Persist
interaction state until the 15-minute follow-up window expires. **Redact interaction tokens** from
logs and stored event payloads. Validate Components V2 responses through the same presentation encoder
used by message and webhook tools, including the deferred-response restriction.

Workflow command publishing defaults to guild commands in configured development guilds. Global
publishing requires `workflow:admin` and an explicit workflow grant.

---

## Workflows

```text
draft → validate/build → validated → publish → published revision → {enable | disable | rollback}
```

Published revisions are immutable; editing creates a new draft.

```ts
type WorkflowRevision = {
  id: WorkflowRevisionId; workflowId: WorkflowId; revision: number
  source: string; dependencies: Record<string, string>; lockfile?: string
  sourceDigest: string; artifactDigest?: string
  requestedGrants: WorkflowGrantRequest; compiledManifest?: CompiledWorkflowManifest
  status: "draft" | "building" | "validated" | "published" | "failed"
  diagnostics: ReadonlyArray<WorkflowDiagnostic>
  createdBy: PrincipalId; createdAt: Date
}
```

Limits: source 256 KiB · 100 direct dependencies · 20 MiB artifact · 5-minute build · 64 KiB logs per
execution · 30 s default handler timeout (administrator maximum 5 min) · concurrency 1 (maximum 8) ·
1,000 queued events per workflow.

### Public SDK

`@discord-mcp/workflow-sdk` — published, semver, the one package sandboxed projects depend on.

```ts
import { Discord, Effect, Http, Schema, Trigger, Workflow } from "@discord-mcp/workflow-sdk"

export default Workflow.make({
  triggers: [
    Trigger.schedule({
      schedule: "0 9 * * 1",
      handler: () => Discord.sendMessage({
        channelId: "456",
        presentation: { type: "components_v2", components: [{
          type: "container", accentColor: 0x5865f2, components: [
            { type: "text", content: "## Weekly status\nThe new report is ready." },
            { type: "actionRow", components: [{
                type: "button", style: "primary", label: "Acknowledge",
                action: { type: "workflow", key: "acknowledge" } }] },
          ]}]},
      }),
    }),
    Trigger.interactionComponent({
      action: "acknowledge",
      handler: ({ interaction }) => Discord.respondToInteraction({
        interaction, ephemeral: true,
        presentation: { type: "legacy", content: "Acknowledged." },
      }),
    }),
    Trigger.http({
      method: "POST", path: "/deploy",
      auth: { type: "hmacSha256", secretRef: "deploy-hook" },
      request: Schema.Struct({ repository: Schema.String, ref: Schema.String }),
      handler: ({ request }) => Effect.succeed(Http.json({ accepted: true, ref: request.ref })),
    }),
  ],
})
```

Note `action: { type: "workflow", key }` — the author names a logical action and the control plane
compiles it into an opaque persisted handle. Authors never construct a `custom_id`.

Triggers: `gateway` · `interactionCommand` · `interactionComponent` · `interactionModal` ·
`interactionAutocomplete` · `http` · `schedule` · `manual`.

Handlers receive Effect services — `Discord` (cataloged operations through the broker; its message
methods accept the same `MessagePresentation` and template references as MCP tools), `WorkflowKv`,
`Http` (brokered outbound to granted hosts), `Log` (structured, redacted), `Execution`, `Clock`. They
receive **no** bot or OAuth tokens, no Docker access, no SQLite handle, no host filesystem paths, no
MCP principal beyond a redacted triggering identity, and no unrestricted Node networking.

The build sandbox imports the module and emits a serializable compiled manifest; the control plane
validates that manifest before granting or enabling anything.

### Grants — default-deny, approved separately from source

```ts
type WorkflowGrant = {
  discord: { operationIds: ReadonlyArray<string>; operationFamilies: ReadonlyArray<OperationFamily>
             guildIds: ReadonlyArray<string>; channelIds: ReadonlyArray<string>
             oauthProfileIds: ReadonlyArray<string>
             botAdmin: boolean; broadMentions: boolean; maxActionsPerMinute: number }
  gateway: { eventTypes: ReadonlyArray<string>; includeBotAuthoredEvents: boolean }
  interactions: { guildCommandPublishing: boolean; globalCommandPublishing: boolean }
  routes: { public: boolean; allowedHosts: ReadonlyArray<string>
            allowedOrigins: ReadonlyArray<string>; allowedSourceCidrs: ReadonlyArray<string>
            maxBodyBytes: number }
  network: { allowedOutboundHosts: ReadonlyArray<string> }
  runtime: { allowNpmInstallScripts: boolean; timeoutSeconds: number; concurrency: number }
}
```

Defaults: `botAdmin=false` · `broadMentions=false` · `includeBotAuthoredEvents=false` ·
`globalCommandPublishing=false` · `public=false` · `allowNpmInstallScripts=false` ·
`maxActionsPerMinute=60` · `maxBodyBytes=1 MiB`. **Empty target lists mean no access, not unrestricted
access.** Discord remains authoritative for guild and channel permission checks *after* the grant
check passes; permission failures surface as typed Discord errors.

Loop prevention: ignore bot-authored Gateway events by default · propagate correlation and causation
IDs · cap causal workflow depth at 5 · enforce per-workflow action budgets · deduplicate Discord event
and interaction IDs.

### Lifecycle tools

`workflow_{list,get,create,update_draft,validate,publish,grant,enable,disable,rollback,delete,invoke}`
· `workflow_execution_get` · `workflow_executions_tail` · `events_tail`.

Creation and draft updates grant nothing. Validation always occurs in a sandbox. Publishing requires a
successful build artifact digest matching the current source and dependency lock. Granting requires
`workflow:admin`. Enabling atomically registers triggers, routes, commands, and the enabled revision;
failed enablement rolls back every partial registration. Disablement stops new dispatch, drains active
handlers to their deadline, and removes workflow-owned guild commands and routes. Deletion is a soft
delete after disablement. Rollback switches to an existing published artifact without rebuilding.

Tail tools take `{ cursor?, workflowId?, eventTypes?, statuses?, limit? /*50, max 200*/,
waitMs? /*0, max 30000*/ }`. While an agent waits the server may emit progress and log notifications;
persistent records stay queryable if the client disconnects. **An event never automatically creates a
fresh agent turn.**

### Sandbox and capability broker

A separate `sandbox-supervisor` is the **only** holder of the rootless Docker socket; the MCP server
never receives it. Server↔supervisor communication is a private Unix socket with filesystem
permissions and a service credential. The supervisor exposes only build, start, stop, inspect, and
destroy for workflow-owned containers; names, images, mounts, networks, and resource limits are
derived internally and never accepted as arbitrary strings.

**Build:** isolated workspace → write only workflow source, generated package metadata, and SDK type
declarations → resolve arbitrary npm from the configured registry → generate and persist a pnpm
lockfile → lifecycle scripts only when `allowNpmInstallScripts=true` → compile and typecheck → import
in-sandbox and emit the manifest → validate manifest and requested capabilities → content-addressed
immutable artifact → destroy the build container. Build containers receive no Discord or MCP
credentials, no database, no control-plane source, no host mounts, no production route secrets.

**Runtime:** non-root UID · read-only root filesystem · read-only artifact and dependency mounts ·
ephemeral `tmpfs` for `/tmp` · no Docker socket · no Linux capabilities · `no-new-privileges` · PID
limit 128 · 256 MiB memory · one CPU · **no direct network** · one revision-specific capability
credential · a private capability RPC socket · forced termination at the handler deadline. Arbitrary
packages must use the SDK's brokered `Http` service.

**The broker checks on every call:** workflow ID and revision · revision still enabled · capability
credential · operation ID/family grant · target guild/channel grant · OAuth profile grant · rate
budget · deadline and cancellation state · causal-depth limit · bot-administration prohibition unless
explicitly granted. It injects Discord credentials only while performing the authorized call.

### Dynamic public routes

Always mounted beneath `/workflows/{workflowSlug}/{workflowRelativePath}`. Workflows can never
register `/mcp`, `/discord/*`, `/oauth/*`, `/.well-known/*`, `/health/*`, `/metrics`, or another
workflow's namespace.

Route authentication: `apiKey` · `bearer` · `hmacSha256` · `none` (explicit administrator grant
required). Route secrets are named encrypted references — MCP tools may reference them but cannot read
their values. HMAC signs timestamp plus raw body, rejects timestamps older than five minutes, persists
replay IDs for that window, and compares in constant time.

Every public route validates allowed hosts · applies source-CIDR rules using only trusted proxy
forwarding data · applies route authentication · applies body-size limits **before** buffering ·
validates request schemas before invoking the workflow · applies an execution deadline · validates
response status, headers, and body size · adds CORS headers only for configured origins. **CORS is
never the access-control decision.**

---

## Authentication and principals

Three paths to Streamable HTTP, all producing identical principal and scoping behaviour: external
OAuth/OIDC access tokens, scoped personal access tokens, trusted Traefik identity headers. Stdio runs
as a local administrator principal.

**OAuth resource server, not an authorization server.** MCP v2 provides this directly:
`requireBearerAuth({ verifier, requiredScopes, resourceMetadataUrl })` from
`@modelcontextprotocol/express`, `mcpAuthMetadataRouter` (which mounts
`/.well-known/oauth-protected-resource/mcp` plus the RFC 8414 mirror), and
`getOAuthProtectedResourceMetadataUrl` for the `WWW-Authenticate` challenge. We supply one function,
`verifyAccessToken(token) => AuthInfo`, validating issuer, audience, signature, expiry, not-before,
and scopes with `jose`. **`expiresAt` must always be populated** — an unset value is treated as `401
invalid_token`. Auth reaches handlers as `ctx.http?.authInfo`, which is `undefined` on stdio, so
always optional-chain. No passwords, login pages, client registration, or consent UI
([MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)).

**PATs** via `discord-mcp auth token {create,list,revoke}`: prefix `dcmcp_`, 256 bits of randomness,
displayed once, argon2id hash in SQLite, 90-day default expiry (365 maximum), named principal with
explicit scopes, revocable without restart.

**Trusted proxy identity** is accepted only when the TCP peer belongs to `TRUSTED_PROXY_CIDRS`,
`TRUST_PROXY_IDENTITY=true`, the request passed allowed-host and forwarded-protocol validation,
configured identity and group headers are present, the identity maps to a stored or configured
principal, and that principal holds the required scope. Forwarded identity headers from any other
source are discarded.

**Scopes.** `mcp:read` · `mcp:write` · `mcp:destructive` · `bot:admin` · `mentions:broad` ·
`template:read` · `template:write` · `server:plan` · `server:apply` · `blob:write` · `oauth:manage` ·
`workflow:read` · `workflow:write` · `workflow:admin` · `auth:admin` · `audit:read`.

Tool registration is stable; **every call checks the authenticated principal.**

### Discord OAuth2 profiles

Separate from MCP client authentication. Tools:
`oauth_profile_{authorize,list,get,revoke}`.

An authorized principal requests a named profile and scopes → the server creates state, PKCE
verifier/challenge, nonce, initiating principal, and a ten-minute expiry → if the client supports URL
elicitation use it, otherwise return the authorization URL → Discord redirects to
`/oauth/discord/callback` → validate state, principal binding, expiry, and PKCE → exchange the code
server-side → encrypt access and refresh tokens with AES-256-GCM → store scopes, expiry, Discord user
ID, and owner → refresh shortly before expiry under a single-flight lock → revoke and delete encrypted
material on request.

`DISCORD_MCP_MASTER_KEY` is 32 bytes base64. **Losing it makes stored credentials unrecoverable; back
it up separately from SQLite.** Workflows may use a profile only when their grant names it explicitly.

### HTTP endpoints

| Endpoint | Authentication |
|---|---|
| `GET /health/live` · `/health/ready` | None; no sensitive detail |
| `GET /metrics` | `audit:read` or trusted monitoring principal |
| `POST/GET/DELETE /mcp` | OAuth/OIDC, PAT, or trusted proxy principal |
| `GET /.well-known/oauth-protected-resource` | None |
| `POST /discord/interactions` | Discord Ed25519 signature |
| `POST /blobs` | Principal with `blob:write` |
| `GET /blobs/{id}/metadata` · `DELETE /blobs/{id}` | Owning principal or `auth:admin` |
| `GET /oauth/discord/authorize/{state}` | Initiating MCP principal session |
| `GET /oauth/discord/callback` | State and PKCE |
| `ANY /workflows/{slug}/*` | Per-route policy |

### Deployment

The server listens on `0.0.0.0:3000` inside its container; Compose publishes
`"${HOST_BIND_ADDRESS:-127.0.0.1}:${HOST_PORT:-3000}:3000"`. Support both Traefik patterns — joining a
named external Docker network and routing to port 3000, or routing to the published host port.
Non-loopback exposure requires TLS terminating at Traefik, an HTTPS `PUBLIC_BASE_URL`, a non-empty
`ALLOWED_HOSTS`, explicit trusted proxy CIDRs, forwarded identity disabled unless the proxy mapping is
configured, rejection of unexpected forwarded headers and invalid host/protocol combinations, and
interactions/OAuth-callback URLs on the public HTTPS base. Provide documented Traefik labels and a
sample dynamic configuration without requiring a particular domain or network name.

---

## Persistence

SQLite via `@effect/sql-sqlite-node` in WAL mode with foreign keys and a busy timeout.

`schema_migrations` · `principals` · `principal_scope_bindings` · `personal_access_tokens` ·
`proxy_identities` · `discord_oauth_profiles` · `encrypted_secrets` · `stored_blobs` ·
`message_templates` · `message_template_revisions` · `component_bindings` · `server_blueprints` ·
`server_blueprint_revisions` · `server_blueprint_bindings` · `server_blueprint_executions` ·
`server_blueprint_actions` · `workflows` · `workflow_revisions` · `workflow_grants` ·
`workflow_routes` · `workflow_commands` · `workflow_executions` · `workflow_events` ·
`gateway_events` · `workflow_kv` · `interaction_deduplication` · `webhook_replay_protection` ·
`preview_tokens` · `audit_log`.

Retention: workflow events 7 days or 10,000 per workflow, whichever first · execution logs 7 days ·
interaction deduplication 24 h · HMAC replay 10 min · audit 90 days · published workflow revisions
until explicit deletion · disabled workflow artifacts retained for rollback. Cleanup runs as a
supervised Effect schedule.

Audited: authentication and token administration · OAuth profile creation and revocation · destructive
previews and calls · bot-administration changes · every workflow lifecycle transition · blueprint
plan and apply · template publication · public route and secret changes · sandbox policy violations.

---

## Errors, retry, and rate safety

`Schema.TaggedErrorClass` throughout, so errors serialize across the capability RPC boundary:
`ConfigurationError` · `AuthenticationError` · `AuthorizationError` · `ValidationError` ·
`DiscordApiError` · `DiscordPermissionError` · `DiscordRateLimitError` · `DiscordGatewayError` ·
`PresentationError` · `TemplateError` · `BlueprintError` · `BlobError` · `PreviewTokenError` ·
`RateGuardTrippedError` · `OperationNotFoundError` · `OAuthProfileError` · `WorkflowBuildError` ·
`WorkflowGrantError` · `WorkflowExecutionError` · `SandboxError` · `RoutePolicyError` ·
`PersistenceError`.

- Let `@discordjs/rest` manage rate-limit buckets. Set `rejectOnRateLimit` so short waits are absorbed
  and long ones fail fast rather than blocking a tool call for minutes.
- **`RateGuard`** is a rolling circuit breaker over repeated 401/403/429 responses, defaulting to 25
  failures in ten minutes per auth-profile/operation-family. Tripping stops outbound calls and
  instructs the agent to diagnose permissions or credentials instead of retrying. The threshold is
  three orders of magnitude below Cloudflare's 10,000 because the failure mode is an agent in a tight
  loop, which reaches thousands in minutes.
- Retry idempotent reads on transient connection failures and selected 5xx with capped exponential
  backoff and jitter. **Never** automatically retry a non-idempotent write after an ambiguous
  transport failure.
- Honour Effect cancellation and MCP request cancellation.
- **Flatten Discord's nested invalid-form-body tree into field paths.**
  `{"code":50035,"errors":{"components":{"0":{"accessory":{"_errors":[{"code":"BASE_TYPE_REQUIRED",…}]}}}}}`
  becomes `components.0.accessory: This field is required [BASE_TYPE_REQUIRED]`. A model fixes that on
  the next turn, every time.
- Every renderer states **what happened, why, and what to do next** — the last clause is what stops
  retry loops. 403 → "Do not retry; call `discord_permissions_explain`." 401 → "Do not retry; tell the
  user to check the token." Defect → "This is a bug in discord-mcp, not a problem with your arguments;
  do not retry with different arguments." Schema failures use
  `SchemaIssue.makeFormatterStandardSchemaV1` for `- path.to.field: message` lines, with the tree
  formatter going to stderr only.
- Never expose internal stack traces to remote MCP callers; record full causes only in redacted
  structured logs.
- Gateway wait timeouts are successful empty results. Likely `MESSAGE_CONTENT` redaction is diagnosed.

### Observability

Structured JSON logs on **stderr** carrying request ID, principal ID, workflow/revision/execution IDs,
Discord operation ID, correlation and causation IDs, redacted target IDs per logging configuration,
duration, and outcome.

**Never logged:** bot tokens · OAuth access or refresh tokens · interaction tokens · API keys or HMAC
secrets · authorization headers · attachment and blob bodies · message content by default.

Metrics: Discord request counts and latency by family and status · rate-limit waits · RateGuard trips
· Gateway reconnects · interaction deadline and defer counts · workflow queue depth, duration,
failure, timeout, and kill counts · blueprint apply outcomes · sandbox build duration and failure ·
route authentication failures · OAuth refresh failures.

### MCP resources

Read-only, to keep large detail out of tool results: `discord://api/operations/{operationId}` ·
`discord://api/families/{family}` · `discord://components/v2` ·
`discord://message-templates/{templateId}/revisions/{revision}` ·
`discord://server-blueprints/{blueprintId}/revisions/{revision}` ·
`discord://server-blueprints/{blueprintId}/executions/{executionId}` ·
`discord://workflows/{workflowId}` · `discord://workflows/{workflowId}/revisions/{revision}` ·
`discord://workflows/{workflowId}/executions/{executionId}` · `discord://audit/{auditId}`.

No MCP prompts initially. Server instructions document the discovery flow: search or use a curated
tool → describe unfamiliar operations → preview destructive/admin calls → execute with the returned
preview token → for workflows, draft, validate, publish, grant, enable in that order.

---

## Configuration

`DISCORD_TOKEN` (required, `Config.redacted`) · `DISCORD_APPLICATION_ID` (lazily derived from
`GET /applications/@me` and cached) · `DISCORD_PUBLIC_KEY` (interaction verification) ·
`MCP_TRANSPORT` · `MCP_HTTP_{PORT,HOST}` (default `3000`/`127.0.0.1`; this process holds a bot token) ·
`PUBLIC_BASE_URL` · `ALLOWED_HOSTS` · `TRUSTED_PROXY_CIDRS` · `TRUST_PROXY_IDENTITY` ·
`DISCORD_MCP_TOOLSETS` (default `operator,automation,api`) ·
`DISCORD_MCP_GATEWAY_{MODE,INTENTS,BUFFER_SIZE,MAX_WAIT_MS}` ·
`DISCORD_MCP_REST_{TIMEOUT_MS,RETRIES,GLOBAL_RPS,MAX_RATELIMIT_WAIT_MS,DENY_THRESHOLD}` ·
`DISCORD_MCP_{MAX_RESPONSE_BYTES,LOG_LEVEL,MASTER_KEY,BLOB_QUOTA_BYTES}` · `DATABASE_PATH` ·
`SUPERVISOR_SOCKET` · `OIDC_{ISSUER,AUDIENCE,JWKS_URI}`.

Composed with `Config.all` and `Config.nested`; note `Config.int`. Configuration decoding **rejects
unsafe public exposure at startup** — a missing `ALLOWED_HOSTS` or non-HTTPS `PUBLIC_BASE_URL` with a
non-loopback bind is a `ConfigurationError`, printed by `NodeRuntime.runMain` with the offending
variable, exiting non-zero.

Root scripts: `pnpm check` · `check:fix` · `typecheck` · `build` · `test` · `test:integration` ·
`test:e2e` · `spec:generate` · `spec:check` · `spec:drift` · `mcp:inspect`.

Biome: two-space indent, LF, UTF-8, 100-column width, single quotes, trailing commas where valid,
organized imports, selective correctness/suspicious/security/complexity/nursery rules. Generated
catalog files are excluded from stylistic rules but checked for determinism. **`suspicious/noConsole`
is an error and is load-bearing, not style** — under stdio one `console.log` corrupts the JSON-RPC
stream.

---

## Implementation sequence

Every phase ends green on Biome, typecheck, unit tests, and all earlier acceptance tests. Each phase
is independently releasable behind disabled-by-default feature flags: **do not wait for the sandbox
platform before shipping a useful local Discord MCP.**

**0 — Spike both beta foundations (1d).** Scratch package pinned to the Effect v4 cohort, MCP v2 beta,
TypeScript, and Node. Compile and run representative v4 services, layers, scoped finalizers,
interruption, Schema transforms, JSON Schema generation, a SQLite transaction, RPC, and Vitest.
Register one Effect Schema with MCP through `McpInput` and call it with a real in-memory client.
Verify `ManagedRuntime.runPromiseExit(program, { signal })`.
*Acceptance:* no Effect v3 package or API is required · MCP and direct Effect decoding accept and
reject the same fixtures · a deliberately unrepresentable schema fails startup naming its tool · exact
beta versions recorded together in the lockfile · any beta API deviation written into an architecture
note before production scaffolding.

**1 — Tracer bullet: one real Discord tool (2d).** Workspace, TypeScript, Biome, Vitest, package
boundaries. Effect v4 configuration, logging, typed errors, request context, shutdown. The MCP bridge,
one reusable tool definition, stdio transport, `@discordjs/rest` service. Implement exactly
`discord_guild_get`.
*Acceptance:* MCP Inspector lists it and returns a real test-guild response · an in-memory client
drives the full schema/handler/result path against a mocked REST layer · a subprocess stdio-purity
test proves every non-empty stdout line is JSON-RPC and logs are on stderr · **client cancellation
interrupts both the Effect fiber and the in-flight Discord request**.

**2 — Errors, rate safety, complete REST catalog (3d).** Typed error mapping, nested Discord error
flattening, truncation, pagination, `RateGuard`. Vendor the spec at an exact commit. Build the
deterministic catalog with path-item parameter merge, scoped `$defs`, overrides, auth/risk manifests,
gloss search index, drift reporter. Search, describe, preview, and risk-separated dispatchers. JSON,
form, multipart, blob-backed attachment, audit-reason, secret-reference, and OAuth-profile request
paths.
*Acceptance:* the pin's expected operation and path counts match generated metadata · every operation
carries auth and risk classification · representative natural-language searches return the right
curated tool or operation · invented routes, missing path parameters, unknown query keys, invalid
bodies, unsafe attachment sources, and auth-mode mismatches all fail **without a network request** ·
the five bot-incompatible operations succeed under an OAuth2 profile and are refused under `bot` ·
synthetic 400/401/403/429/timeout/defect fixtures produce exact actionable messages.

**3 — Presentations and Components V2 (3d).** Canonical `MessagePresentation` schemas and encoder;
every documented V2 layout, content, and interactive component, nesting rule, attachment reference,
mention policy, and interaction binding; `ModalPresentation`; message validate/send/edit/read/delete,
reactions, pins, crosspost, threads; webhook execution through the same pipeline; stored blobs with no
arbitrary filesystem paths; ASCII layout preview.
*Acceptance:* MCP can validate and send a real V2 presentation in a test guild · illegal V2/legacy
combinations and every structural error fail locally · hard limits reject and advisory limits warn ·
mention-safe defaults apply to every text-bearing component · one presentation fixture works through
bot message, webhook, and interaction-response paths where Discord permits · encoded fixtures stay
compatible with the pinned Discord types and mock API.

**4 — Templates and declarative server setup (4d).** Immutable published template revisions and typed
rendering; guild inspection and effective-permission explanation; atomic role, channel, ordering, and
overwrite tools; blueprint schemas, persistent logical-key bindings, snapshot normalization, diff,
preview, apply journal, resume, destructive managed deletion.
*Acceptance:* a template renders deterministically and passes the normal validator · a
natural-language server specification is representable without raw permission integers · the test
blueprint creates roles, categories, text/forum/voice channels, ordering, and overwrites · reapplying
produces zero Discord mutations · a stale preview cannot apply · partial failure produces a resumable
journal · unmanaged resources survive every default apply · a hierarchy violation is reported at plan
time.

**5 — Remaining operator surface and Gateway (3d).** Members, moderation, AutoMod, invites, scheduled
events, emoji/sticker, bot, application, command tools. `@discordjs/ws` lifecycle with lazy
connection, intent diagnostics, normalized persistent cursors, recent-event queries, race-free waits.
Bot-admin and destructive preview gates.
*Acceptance:* the documented curated inventory is present with unique names and correct annotations ·
common server operation never requires raw operation IDs · permission and hierarchy failures are
diagnosed locally where possible · an event published **before** the wait subscribes is still returned
after its cursor · wait timeout is a successful empty response · close codes are actionable.

**6 — Persistence and control-plane authentication (3d).** Migrations and repositories, encrypted
secrets, PAT CLI, JWT/JWKS verification, trusted proxy identity, protected-resource metadata,
Traefik-safe host/origin/proxy validation.
*Acceptance:* all three auth paths produce identical principal and scoping behaviour · spoofed proxy
headers are rejected · public startup fails when required TLS/proxy metadata is unsafe or missing.

**7 — Discord OAuth2 profiles (2d).** Authorization URL, callback, PKCE, encrypted tokens, refresh,
listing, revocation, profile-aware dispatch.
*Acceptance:* a profile survives restart and refreshes without exposing token material · ungranted
principals and workflows cannot use it.

**8 — Interactions and component routing (3d).** Signed endpoint and command registry; opaque
component binding resolution and the persistent component event inbox; deterministic defer/follow-up;
persisted deduplication.
*Acceptance:* invalid signatures never reach handlers · slow handlers defer before the internal
deadline · V2 follow-ups and original-response edits respect Discord's allowed callback sequence ·
tampered or expired handles are rejected.

**9 — Workflow persistence and SDK (4d).** Workflow/revision/grant/execution repositories; published
SDK types and Effect services; lifecycle tools; manifest compilation and trigger registration; event
inbox and long-poll tails.
*Acceptance:* draft-to-enable and rollback work without sandboxed Discord mutation yet · event cursors
survive restarts.

**10 — Sandbox supervisor and capability broker (5d).** Narrow rootless-Docker supervisor; immutable
artifacts; arbitrary npm with deterministic lockfiles; runtime resource restrictions;
revision-specific capability RPC; brokered Discord/KV/logging/HTTP services.
*Acceptance:* a granted workflow can act · an ungranted one cannot · every hostile fixture is
contained · no workflow environment or filesystem contains a Discord credential.

**11 — Dynamic routes and automation hardening (3d).** Namespaced routing; route auth schemes and
secret references; schedules, manual triggers, queues, budgets, loop prevention, retention; metrics
and full audit coverage.
*Acceptance:* public HMAC and API-key examples pass through Traefik · queue overflow, timeouts,
dependency failures, and runner crashes produce recoverable typed failures · enabled workflows restart
automatically after a control-plane restart.

**12 — Release validation (2d).** Full unit, contract, sandbox, integration, Inspector, and test-guild
suites. Credential-leak review. Dependency and container-image audit. **Re-pin MCP to v2 stable.**
Operator documentation: setup, Discord permissions and intents, OAuth, Traefik, backups, workflow
authoring, incident recovery. Tag only after the complete acceptance suite passes.

**13 — Deferred Social SDK bridge.** Only after release validation. A standalone C++20 sidecar reusing
the capability-broker model, with user Social SDK authorization kept separate from bot credentials,
adding friends, rich presence, game invites, lobbies, and voice incrementally. Discord
communication-feature approval and platform requirements are external prerequisites.

**~38 focused implementation days**, which is the sum of the phase estimates and assumes no
investigation, no upstream breakage, and no rework. For one engineer, plan on **55–70 calendar days**.

The estimate is least trustworthy in three places, and each should carry explicit contingency rather
than being squeezed:

- **Phase 10 (sandbox, 5d)** is the most likely to overrun by a wide margin. Getting rootless Docker,
  read-only mounts, PID/memory caps, and a revision-scoped capability credential correct is one thing;
  *proving* it against the hostile fixture suite is another, and every fixture that escapes is a
  redesign rather than a patch. Budget double.
- **Phases 6 and 11 (auth and remote deployment, 6d combined)** involve Traefik, TLS, forwarded-header
  trust, and OAuth metadata — integration work whose failures are environmental and slow to diagnose.
- **Phase 0 (1d)** is a research spike against two pre-stable dependencies. If the TypeScript 7 ×
  Effect v4 gate fails, everything shifts.

Phases 3 and 4 — the two capabilities that motivate the project — land inside the first three weeks,
and every phase before 9 is independently shippable, so the schedule risk sits behind working
software rather than in front of it.

---

## Verification

**Unit.** Effect v4 service, scope, interruption, Schema, JSON Schema, SQL, and RPC compatibility
fixtures · `McpInput` conformance, so the advertised JSON Schema and direct Effect decoding accept and
reject exactly the same fixtures · JSON Schema advertisement preserves required fields, defaults,
descriptions, and constraints · configuration decoding rejects unsafe public exposure · snowflake,
cursor, attachment, pagination, and audit-reason schemas · catalog generation and risk classification ·
path/query/JSON/form/multipart/file request construction · sensitive OpenAPI parameters become secret
references · Discord error and permission mapping · safe allowed-mentions defaults · legacy versus V2
discrimination · **every V2 nesting rule, child-count limit, total count, ID and `custom_id`
uniqueness rule, and incompatible message field, with hard-reject and warn-only cases distinguished** ·
modal/message component separation and every modal input constraint · attachment reference resolution
and normalized filename collision handling · opaque handle ownership, expiry, and tamper rejection ·
template variable decoding, contextual escaping, revision pinning, deterministic rendering · blueprint
normalization, logical-key resolution, adoption, idempotent diffing, ordering, stale-snapshot
rejection, destructive classification, execution resume, partial-failure journals ·
effective-permission computation for owner, administrator, role aggregation, and every overwrite stage
· retry decisions distinguishing idempotent from non-idempotent · response truncation and resource
links · workflow lifecycle transitions · grant matching and target restrictions · causal depth and
self-event suppression · route host/origin/CIDR/apiKey/bearer/HMAC policies · HMAC timestamp and
replay protection · PAT hashing, expiry, revocation, scopes · JWT issuer, audience, expiry, JWKS
rotation, invalid signature · trusted-proxy spoofing rejection · OAuth state, PKCE, refresh,
encryption, revocation, principal binding · interaction signature, PING, dedup, deferral, follow-up ·
retention and cleanup. Plus a full `tools/list` snapshot so schema drift is a reviewable diff.

**Contract.** The pinned Effect v4 cohort is version-aligned · every pinned operation has exactly one
catalog entry with one auth and one risk classification · every generic dispatcher rejects operations
outside its class · every curated tool delegates only to cataloged operations and declares correct MCP
annotations · catalog schemas compile under AJV · every Effect schema compiles through `McpInput` ·
workflow SDK types match broker RPC schemas · curated V2 types encode to payloads accepted by the
pinned Discord types and mock fixtures.

**Sandbox security.** Hostile fixtures attempting to read environment variables, locate Discord
tokens, read host paths, mount or contact the Docker socket, fork-bomb, exhaust memory, run forever,
bind arbitrary ports, reach unrestricted external hosts, call ungranted operations, target ungranted
guilds or channels, reuse another revision's capability credential, exceed action budgets, emit
oversized logs or responses, and install a package with a malicious lifecycle script. Each must be
impossible or terminate within configured limits without exposing secrets.

**Integration**, against mocked Discord HTTP and Gateway servers: rate-limit bucket waits ·
identify/resume/reconnect · privileged-intent failures · message and channel flows · legacy, V2,
template-rendered, webhook, and interaction-follow-up messages · interactive component dispatch
through opaque bindings · blueprint plan/apply/reapply, stale preview rejection, resumable partial
failure · interaction deferral and follow-up · OAuth token refresh · workflow publish/enable/rollback ·
dynamic route authentication · long-poll event tailing · supervisor container lifecycle.

**In-process MCP harness** — MCP v2's own recommendation: drive a real `Client` against a real
`createMcpHandler` by passing `handler.fetch` as the client transport's `fetch`. No port, no socket, no
mock transport. `InMemoryTransport.createLinkedPair()` remains available but links only 2025-era
instances. `DiscordRest` is layer-swapped for a stub so the entire tool surface is testable offline.

**Test-guild end-to-end**, explicit opt-in, never in ordinary CI: connect and inspect the
application/profile → list guilds and channels → send, edit, react to, delete a message → send a V2
release announcement containing a container, section, thumbnail, media gallery, separator, file, and
workflow-bound button, then exercise the interaction and edit it → publish and render a reusable V2
template → plan and apply a temporary blueprint with roles, a category, text/forum/voice channels,
named overwrites, and ordering, then reapply and assert a zero-action diff → create and remove a
temporary channel and role atomically → exercise timeout/ban against a designated test account only →
create a workflow reacting to a filtered message event → verify the execution appears through
`workflow_executions_tail` → publish a guild slash command workflow and verify defer/follow-up →
publish a namespaced HMAC route through Traefik → complete an OAuth2 profile flow and call a permitted
user-scoped endpoint → roll a workflow back → confirm no runner container holds a Discord credential.

Two negative live tests matter more than the happy paths: call a route the bot genuinely lacks
permission for and confirm the 403 names the missing permission; and disable `MESSAGE_CONTENT` in the
portal and confirm reads return the intent diagnosis rather than silently empty strings.

**MCP evaluation scenarios** — natural-language task evals, the closest thing to a real quality
measure for an agent-facing product: find a channel by name and send a guarded message without broad
mentions · compose, validate, and send a V2 announcement from a natural-language brief · diagnose and
repair an invalid nested V2 presentation without sending a bad request · inspect a guild, propose a
role/channel/permission blueprint, preview it, and safely apply it · explain why the bot cannot manage
a role or post in a channel without retrying the failed action · discover the right operation for an
uncommon resource and call it · preview and perform a destructive test-guild operation · create,
validate, grant, publish, and enable a workflow · diagnose a workflow failure from execution history ·
tail a filtered event stream with a cursor · update bot presence · use an OAuth profile without
revealing its token.

**CI.** `pnpm install --frozen-lockfile && pnpm check` on Node 24, plus `pnpm pack` and an
install-from-tarball smoke test of the CLI.

---

## Open risks

1. **Effect v4 beta churn.** Ships roughly every 2–3 days (99 beta releases in five months); Effect's
   own guidance is that v3 remains the production recommendation; `effect/unstable/*` may break in
   minor releases even after v4 GA. Mitigation: exact pins as one version-aligned cohort, atomic
   renovation gated on the full suite, and no `unstable/*` type crossing a service boundary.
2. **TypeScript 7 × Effect v4** — unverified. Phase-0 gate; if broken, pin the newest TypeScript that
   Effect v4 supports and record the upstream issue. Falling back to Effect v3 is not an option.
3. **MCP v2 beta → stable, expected 2026-07-28.** Low risk given a stable API surface across
   beta.1→beta.5, but `@modelcontextprotocol/fastify` lags at beta.4 (we use Express, so it does not
   bite). Re-pin in phase 12.
4. **`ManagedRuntime.runPromiseExit` signal option** — unverified; `Effect.interruptWhen` fallback
   specified.
5. **Three Components V2 limits are undocumented** (message-wide 4000 characters, 10 top-level
   components, Container's 10 children). Implemented as warnings so an upstream change never blocks a
   valid send.
6. **The maintained gloss drifts** as Discord adds operations — mitigated by the build-time warning
   for operations with neither a gloss nor a curated tool.
7. **`openapi.json` and `openapi_preview.json` are currently near-identical** and both self-describe
   as "(Preview)". Record the observation in `source.json`; do not build a stable/preview split yet.
8. **Rootless Docker is assumed.** Under rootful Docker the supervisor's isolation guarantees weaken
   substantially and phase 10's acceptance criteria must be re-derived.
9. **Blueprint apply is not transactional.** The journal makes partial failure recoverable, but a
   guild can be left mid-migration; operators need the resume path documented, not just implemented.
10. **The 38-day figure is a floor, not a forecast.** It is the sum of phase estimates with no
    contingency. Phase 10's hostile-fixture suite is the dominant schedule risk — a fixture that
    escapes forces redesign, not a patch — followed by Traefik/TLS/forwarded-header integration in
    phases 6 and 11. Track against the 55–70 calendar-day range and re-baseline after phase 0, since a
    failed TypeScript 7 × Effect v4 gate shifts everything.
