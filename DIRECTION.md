# Direction

Build a self-hosted Discord MCP control plane with optional sandboxed TypeScript workflows.
An external MCP client owns model conversations. The architecture assumes one active control
plane with SQLite; hosted/serverless deployment and horizontal scaling are outside its scope.

## Current state

`main` contains the independent `t3code/implement-plan-1` implementation. Read `README.md` for
implemented features and integration gaps; the phase table in `GOAL.md` overstates completion.

The live Docker stack on Athena still uses the divergent `t3code/implement-plan` worktree.
Publishing to `main` has not migrated that instance. Treat any replacement as a separate deployment
with explicit state compatibility checks.

## Public access

`https://discord.mia.cx/mcp` reaches the live instance through public k3s Traefik. Mia manages DNS.
Routing shipped without rebuilding or restarting the application. Remote clients use application
PATs or configured OIDC; the bot token stays in server configuration.

Routing manifests, Athena relay units, and recovery instructions live in
`mia-cx/yggdrasil-spec` under `argocd/discord-mcp/` and `hosts/athena-hephaestus/`.
Consult those files when changing ingress or recovering its backend registration.
