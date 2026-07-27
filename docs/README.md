# Documentation

This directory is the user and operator manual for `discord-mcp`. It describes the shipped behavior;
`PLAN.md` records the implementation contract and acceptance history.

## Start here

| Goal | Guide |
| --- | --- |
| Understand the product and its boundaries | [Architecture](architecture.md) |
| Run locally or install with Compose | [Setup](setup.md) |
| Configure every service | [Configuration reference](configuration.md) |
| Configure the Discord application | [Discord permissions and intents](discord-permissions.md) |
| Connect MCP clients securely | [Authentication and authorization](authentication.md) |
| Deploy through a reverse proxy | [Deployment](deployment.md) |

## Use the features

| Feature | Guide |
| --- | --- |
| Curated tools, MCP resources, and the complete API catalog | [MCP tool guide](tool-guide.md) |
| Legacy messages, Components V2, modals, files, and mentions | [Messages and Components](messages.md) |
| Typed, immutable message templates | [Message templates](templates.md) |
| Declarative guild reconciliation | [Server blueprints](blueprints.md) |
| Gateway events, waits, presence, voice state, and interactions | [Gateway and interactions](gateway-interactions.md) |
| Discord user-context tokens | [Discord OAuth profiles](oauth.md) |
| Workflow revision lifecycle and grants | [Workflow lifecycle](workflows.md) |
| Writing TypeScript workflows | [Workflow authoring](workflow-authoring.md) |
| Builder, runner, and capability isolation | [Sandbox and capability security](sandbox.md) |
| Local administration, blobs, and named secrets | [CLI reference](cli.md) |

## Operate and maintain it

| Goal | Guide |
| --- | --- |
| Day-two operations and maintenance | [Operator guide](operator-guide.md) |
| Health, logs, audit, and metrics | [Observability](observability.md) |
| Threat model and security assumptions | [Security model](security.md) |
| Create and verify backups | [Backups](backups.md) |
| Recover from partial failures or incidents | [Recovery](recovery.md) |
| Diagnose common failures | [Troubleshooting](troubleshooting.md) |
| Run local and release validation | [Testing](testing.md) |
| Validate against a disposable Discord guild | [Live acceptance](live-acceptance.md) |

## Maintainer references

- [PLAN.md acceptance matrix](plan-audit.md)
- [ADR 0001: beta foundations](architecture/0001-beta-foundations.md)
- [Traefik file-provider example](traefik.example.yaml)

## Documentation conventions

- Commands run from the repository root unless stated otherwise.
- `corepack pnpm cli -- ...` runs the local CLI from source.
- Snowflakes in examples are placeholders; use IDs from your own disposable or production guild as
  appropriate.
- Never paste a bot token, PAT, OAuth token, master key, supervisor credential, or named secret into
  an MCP argument.
- A “principal” is an authenticated MCP caller. A “Discord profile” is an encrypted OAuth2
  credential used for Discord user-context operations. They are different identities.
