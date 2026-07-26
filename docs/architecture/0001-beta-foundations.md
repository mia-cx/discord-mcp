# ADR 0001 — Beta foundations, verified

Status: accepted · Date: 2026-07-26 · Phase: 0

PLAN.md requires that "any beta API deviation [is] written into an architecture note before
production scaffolding". This is that note. Every claim below was verified by executing
`spike/spike.ts` and `spike/typecheck-probe.ts` against the shipped artifacts, not by reading
documentation.

## Verdict

The gate passes. `effect@4.0.0-beta.101` + `@modelcontextprotocol/server@2.0.0-beta.5` +
`typescript@7.0.2` + Node 24 is a viable cohort. No Effect v3 package or API is required. All 15
runtime gates pass.

## Confirmed as written in PLAN.md

- `Schema.toStandardSchemaV1(s)` attaches `~standard.validate`, mutates and returns the same schema
  object, and is idempotent.
- `Schema.toStandardJSONSchemaV1(s)` attaches `~standard.jsonSchema.{input,output}` to the **same**
  `~standard` object, and honours `{ target: "draft-2020-12" }`.
- The two calls together satisfy MCP v2's `StandardSchemaWithJSON`. There is no adapter package.
- `Schema.optionalKey` produces an exact-optional key that is correctly absent from JSON Schema
  `required`.
- Constraints survive the bridge: `Schema.check(Schema.isMinLength(17))` is advertised as
  `minLength: 17` in `tools/list`, and MCP rejects a violating `tools/call` with `isError: true`.
- **Conformance holds.** For every fixture tried, MCP's `~standard.validate` and
  `Schema.decodeUnknownEffect` accept and reject identically. This is the property the plan's
  `McpInput` conformance suite exists to protect.
- `Context.Service<Self, Shape>()("key")` + `Layer.effect` runs `Effect.acquireRelease` finalizers,
  and `ManagedRuntime.dispose()` executes them.
- API renames are exactly as tabulated: `Config.int` (no `Config.integer`), `Effect.catch` (no
  `catchAll`), `Effect.result`, `Effect.callback`, `Layer.effect` (no `Layer.scoped`).

## Deviations found — these change the implementation

### 1. Open risk #4 is closed: the signal option works

`ManagedRuntime.runPromiseExit(program, { signal })` interrupts the fiber and runs `onInterrupt`
finalizers when the `AbortController` fires. **The `Effect.interruptWhen` + `Effect.callback`
fallback specified in PLAN.md is not needed** and should not be built.

### 2. A non-object root schema fails at `tools/list`, not at `registerTool`

PLAN.md says "MCP throws if an `inputSchema` root `type` is not `object`". It does — but the throw
happens when the schema is serialised for `tools/list`, **not** when `registerTool` is called.
Registration of `McpInput(Schema.String)` succeeds silently.

The consequence is worse than the plan assumed: one unrepresentable schema breaks **discovery for
every tool on that server**, and it surfaces at first client contact rather than at startup. This
makes the registry's "build every JSON Schema eagerly during layer construction and assert
`type === 'object'`" behaviour **load-bearing rather than defensive**. It is the only thing that
turns a total, remote, late failure into a startup failure naming the offending tool.

### 3. `createMcpHandler` takes a factory, and `handler.fetch` takes a `Request`

- The signature is `createMcpHandler(factory: () => McpServer, options?)` — a factory, not a server
  instance. Passing an instance yields an opaque HTTP 500.
- `handler.fetch(request: Request, options?)` is not `fetch`-compatible. The client's `FetchLike` is
  `(url, init)`. The in-process harness needs the adapter
  `(url, init) => handler.fetch(new Request(url, init))`.
- Pass `options.onerror`; without it, server-side failures surface only as
  `{"code":-32603,"message":"Internal server error"}` with no cause.

### 4. `@modelcontextprotocol/express` is not required

PLAN.md sources `requireBearerAuth`, `mcpAuthMetadataRouter`, and
`getOAuthProtectedResourceMetadataUrl` from `@modelcontextprotocol/express`. All of the auth surface
we need is exported from `@modelcontextprotocol/server` itself: `requireBearerAuth`,
`verifyBearerToken`, `bearerAuthChallengeResponse`, `buildOAuthProtectedResourceMetadata`,
`oauthMetadataResponse`, `getOAuthProtectedResourceMetadataUrl`, plus
`validateHostHeader` / `validateOriginHeader` for the Traefik work in phase 6.

Since the server package also ships `WebStandardStreamableHTTPServerTransport` and a web-standard
`fetch` handler, **the Express dependency can be dropped from the stack entirely.** Revisit in
phase 6; do not add it in phase 1.

### 5. Checks land in `allOf`, and a trailing `.annotate()` goes with them

Effect v4 emits every `Schema.check` as an `allOf` member rather than inline, and an annotation
applied *after* a check attaches to that member. So this:

```ts
guildId: Snowflake.annotate({ description: 'The guild to read.' })
```

advertises `properties.guildId.allOf[0].description`, while an unchecked sibling advertises
`properties.withCounts.description`. Clients that render property-level descriptions — most of
them — then show help for the easy parameter and nothing for the constrained one that actually
needed explaining. Shared constrained schemas like `Snowflake` make this unavoidable by
authoring convention, since the checks are already applied before any use site annotates.

`packages/core/src/mcp/schema.ts` therefore hoists `allOf` members into their parent whenever no
key would collide and no member carries a combinator keyword (`allOf`/`anyOf`/`oneOf`/`not`/`$ref`).
That is semantically neutral — a conjunction of flat keyword sets means the same thing inline —
and it is applied both to the schema handed to `registerTool` and to the one the registry
validates, so what is advertised is what is checked.

`mcpToolInput` wraps rather than mutates, because `toStandardJSONSchemaV1` writes onto the schema
object itself and patching in place would change a shared schema for every other consumer.

### 6. `runMain`'s error reporting escapes the logging layer, and lands on stdout

`Runtime.makeRunMain` wraps the program in `Effect.tapCause(effect, … Effect.logError(cause))`.
That tap runs **outside** anything the program provides internally, so
`Layer.succeed(Logger.LogToStderr)(true)` does not reach it — not even when applied with
`Effect.provide` around the launched layer, since `runMain` wraps whatever it is given.

The result is that startup failures and unhandled defects are written to **stdout**. Under stdio
that is a JSON-RPC stream corruption, which is the exact failure PLAN.md's "stdio owns stdout
exclusively" rule exists to prevent.

Fix, in `apps/server/src/bin.ts`: report the cause ourselves inside the logging layer and pass
`{ disableErrorReporting: true }`. Exit codes still come from the default teardown. The
stdio-purity suite asserts stdout is empty on a startup failure, which is what keeps this from
regressing.

### 7. TypeScript 7 needs shims for Effect's `dom` references

Two DOM-lib types are referenced by Effect's `.d.ts` files but not declared globally by
`@types/node@24`. With `skipLibCheck: false` both are hard errors:

- `TextDecoderOptions`, referenced unqualified by `Channel.d.ts` — a global `type` alias suffices.
- `Transferable`, referenced by `unstable/rpc/RpcClient.d.ts` as `globalThis.Transferable` — this
  one must be an `interface`. A global *type alias* is not reachable through `globalThis.`
  qualification, so the obvious `type Transferable = …` does not fix it. Nor can the file use an
  `import()` type, which would make it a module and stop its declarations being global.

Rejected: adding `"dom"` to `lib`, which would let browser-only globals typecheck in a Node-only
server. Chosen: `types/globals.d.ts`, included by every project's tsconfig. Everything else in
Effect v4 typechecks under TS 7.0.2 with `strict`, `exactOptionalPropertyTypes`,
`noUncheckedIndexedAccess`, and `skipLibCheck: false`.

`Context.Service` classes are yieldable directly (`yield* Rest`); there is no `.asEffect()`.
Error-channel inference through `Effect.gen` is exact under TS7.

## Pinned cohort

| Package | Version |
|---|---|
| `effect`, `@effect/platform-node`, `@effect/sql-sqlite-node`, `@effect/vitest` | `4.0.0-beta.101` |
| `@modelcontextprotocol/{server,client}` | `2.0.0-beta.5` |
| `typescript` | `7.0.2` |
| Node | 24 |

Re-pin MCP to v2 stable in phase 12, per PLAN.md open risk #3.
