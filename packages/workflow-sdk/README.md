# `@discord-mcp/workflow-sdk`

The public, semver-versioned SDK for sandboxed discord-mcp workflows. It exposes declarative triggers
and capability-backed `Discord`, `WorkflowKv`, `Http`, `Log`, `Execution`, and `Clock` services.
Workflow code never receives Discord credentials, the host filesystem, or unrestricted networking.

See the repository's `docs/workflows.md` for authoring and deployment examples.
