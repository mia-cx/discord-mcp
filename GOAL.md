# Goal

Implement **all of PLAN.md except its Deferred section**, to the acceptance criteria stated in
each phase.

## Out of scope, by PLAN.md's own decision

- Phase 13 / `native/social-sdk-bridge` — Discord Social SDK native bridge.
- Bot voice media: joining for playback, receiving audio, codecs, recording, FFmpeg.
  Voice/stage REST operations and member voice-state control stay in scope.
- Horizontal scaling or multiple active control-plane replicas.
- Hosted Cloudflare deployment.
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
| 4 — Templates and declarative server setup | in progress |
| 5 — Remaining operator surface and Gateway | not started |
| 6 — Persistence and control-plane authentication | not started |
| 7 — Discord OAuth2 profiles | not started |
| 8 — Interactions and component routing | not started |
| 9 — Workflow persistence and SDK | not started |
| 10 — Sandbox supervisor and capability broker | not started |
| 11 — Dynamic routes and automation hardening | not started |
| 12 — Release validation | not started |

Keep this table honest. "Not started" is information; a green row that is not actually green is
worse than useless on a build this long.
