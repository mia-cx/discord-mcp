# discord-mcp

A self-hosted Discord automation platform driven by an AI agent through MCP. You prompt an agent in
your own editor or CLI; the agent performs Discord actions through MCP tools. Discord is the action
target, never the prompting surface.

See [PLAN.md](./PLAN.md) for the full design.

## Status

Phases 0 and 1 of the [implementation sequence](./PLAN.md#implementation-sequence) are complete and
green. The server runs over stdio and exposes one real Discord tool end to end.

| Phase | State |
|---|---|
| 0 — Spike both beta foundations | done · [ADR 0001](./docs/architecture/0001-beta-foundations.md) |
| 1 — Tracer bullet: one real Discord tool | done |
| 2 — Errors, rate safety, complete REST catalog | done · 242 operations, 7 dispatchers |
| 3 — Presentations and Components V2 | done · encoder, validator, message tools |
| 4 — Templates and declarative server setup | partial · permissions and blueprint planning done; templates, snapshot, and the apply journal are not |
| 5–12 | not started |

See [GOAL.md](./GOAL.md) for the definition of done and the full remaining scope.

## Quick start

```bash
pnpm install
DISCORD_TOKEN=... pnpm --filter @discord-mcp/server exec tsx src/bin.ts
```

Point an MCP client at that command. For the Inspector:

```bash
pnpm build && DISCORD_TOKEN=... pnpm mcp:inspect
```

## Checks

```bash
pnpm check        # biome + tsc --build + vitest
pnpm check:fix    # biome --write
```

`pnpm test` excludes `*.e2e.test.ts`; the test-guild suite is opt-in and never runs in ordinary CI.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `DISCORD_TOKEN` | *(required)* | Bot token. Redacted in every log and error. |
| `MCP_TRANSPORT` | `stdio` | `http` is rejected until phase 6 ships its authentication. |
| `DISCORD_MCP_TOOLSETS` | `operator,automation,api` | Startup-selected; authorization is still per call. |
| `DISCORD_MCP_REST_TIMEOUT_MS` | `15000` | |
| `DISCORD_MCP_REST_RETRIES` | `2` | |
| `DISCORD_MCP_REST_MAX_RATELIMIT_WAIT_MS` | `10000` | Longer waits fail fast rather than block a tool call. |

## Catalog

```bash
pnpm spec:generate   # regenerate the operation catalog from the vendored spec
pnpm spec:check      # CI gates: coverage, classification, path-item merge, determinism
pnpm spec:drift      # report upstream changes; never writes to vendor/
```

Configuration is decoded at startup. A bad value exits non-zero with the offending variable named.

## Layout

```
apps/server/            stdio transport, config, entrypoint, application layer
packages/core/          ids, typed errors, MCP bridge, tool definition, registry, result rendering
packages/discord-api/   DiscordRest, error mapping, RateGuard, operation catalog, dispatchers,
                        permissions, curated tools
packages/discord-presentations/  Components V2 schemas, encoder, validator, modals, ASCII preview
packages/discord-blueprints/     blueprint schema and planner
vendor/discord/         pinned OpenAPI spec, provenance, project overrides
docs/architecture/      ADRs, starting with the phase-0 beta verification
types/globals.d.ts      shims for two DOM types Effect references and @types/node omits
spike/                  the phase-0 gate, kept runnable as a regression check on the beta cohort
```

## Two things worth knowing before editing

**Stdout is the JSON-RPC stream.** One `console.log` corrupts every subsequent message, so Biome's
`suspicious/noConsole` is an error rather than a style rule, and
`apps/server/test/stdio-purity.test.ts` runs the real binary as a subprocess to prove it. That test
found a real one: `runMain`'s built-in error reporting runs outside the program's layers and wrote
startup failures to stdout. See [ADR 0001 §6](./docs/architecture/0001-beta-foundations.md).

**Every error must say what to do next.** Cloudflare bans the source IP after 10,000 401/403/429
responses in ten minutes, and the failure mode that gets there is an agent retrying with permuted
arguments. So a 403 says "do not retry; call `discord_permissions_explain`", `RateGuard` trips at
25 rejections in ten minutes, and Discord's nested invalid-form-body tree is flattened into
`components.0.accessory: This field is required [BASE_TYPE_REQUIRED]` — something a model fixes on
the next turn.
