# Goal

Serve Discord's bot-authenticated HTTP API through stateless MCP tools.

- Require Discord OAuth login plus a separate bot-token header on every HTTP request.
- Execute that request's tools using exactly its supplied bot token.
- Retain no bot credentials, authentication results, MCP sessions, or Discord responses.
- Keep OAuth grants encrypted in client-held relay credentials; keep only short-lived code-replay hashes in memory.
- Let Discord enforce bot permissions; require no local accounts or grants.
- Keep local schema validation and actionable Discord errors.
- Run without a database, Gateway, or workflow engine.

The old phase checklist belonged to the control-plane design in `PLAN.md`.
It is no longer the implementation contract.
