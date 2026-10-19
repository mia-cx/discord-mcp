# Goal

Serve Discord's bot-authenticated HTTP API through stateless MCP tools.

- Authenticate each HTTP request with the caller's Discord bot token.
- Execute that request's tools using exactly that token.
- Retain no credentials, authentication results, MCP sessions, or Discord responses.
- Let Discord enforce bot permissions; require no local accounts or grants.
- Keep local schema validation and actionable Discord errors.
- Run without a database, Gateway, workflow engine, or sandbox supervisor.

The old phase checklist belonged to the control-plane design in `PLAN.md`.
It is no longer the implementation contract.
