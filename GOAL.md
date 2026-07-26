# Goal

Implement **all of PLAN.md except its Deferred section**, to the acceptance criteria stated in
each phase.

## Out of scope, by PLAN.md's own decision

- Phase 13 / `native/social-sdk-bridge` — Discord Social SDK native bridge.
- Bot voice media: joining for playback, receiving audio, codecs, recording, FFmpeg.
  Voice/stage REST operations and member voice-state control stay in scope.
- Horizontal scaling or multiple active control-plane replicas. **Permanently out of scope**, not
  deferred: the design assumes one active control plane, and the single-writer SQLite persistence
  and in-process broker state both depend on that.
- Any hosted or serverless deployment target, Cloudflare included. **Permanently out of scope.**
  The only deployment surface is the Docker image set under `docker/`.
  (Cloudflare appears throughout the code for an unrelated reason: Discord's API sits behind it and
  bans a source IP after 10,000 401/403/429 responses in ten minutes. That is a rate-safety
  constraint on the client, not a deployment target.)
- A bundled identity provider or login UI.
- Automatically starting a new model turn when a Discord event arrives.

## Definition of done

For every phase 0–12: `pnpm check` green (Biome, `tsc --build`, Vitest) **and** that phase's
acceptance criteria demonstrably met, **and** all earlier phases' acceptance tests still green.

PLAN.md: "Every phase ends green on Biome, typecheck, unit tests, and all earlier acceptance
tests." A phase is not done because its code exists; it is done when its acceptance test passes.

## Progress

| Phase | Status |
|---|---|
| 0 — Spike both beta foundations | done |
| 1 — Tracer bullet: one real Discord tool | done |
| 2 — Errors, rate safety, complete REST catalog | done |
| 3 — Presentations and Components V2 | done |
| 4 — Templates and declarative server setup | done |
| 5 — Remaining operator surface and Gateway | done |
| 6 — Persistence and control-plane authentication | done |
| 7 — Discord OAuth2 profiles | done |
| 8 — Interactions and component routing | done |
| 9 — Workflow persistence and SDK | done |
| 10 — Sandbox supervisor and capability broker | done |
| 11 — Dynamic routes and automation hardening | done |
| 12 — Release validation | done |

Keep this table honest. "Not started" is information; a green row that is not actually green is
worse than useless on a build this long.

## Known blocker

**MCP stays pinned to `2.0.0-beta.5`.** Phase 12 calls for re-pinning to v2 stable, but v2 stable
is not published — `npm view @modelcontextprotocol/server dist-tags` still resolves `latest` to
this beta. The pin is already the newest available; re-pin when upstream ships.
