# Authentication and authorization

Authentication answers which MCP principal is calling. Authorization then checks that principal's
scopes before a tool or HTTP endpoint can act. Discord's own guild permissions and workflow grants
are additional, independent layers.

MCP authentication and [Discord OAuth profiles](oauth.md) are different systems. An MCP bearer token
authorizes a person or client to call this server. A Discord OAuth profile lets an already authorized
principal call Discord endpoints in a user's context.

## Transport behavior

### Stdio

Stdio is a trusted local-administrator transport. The spawned client receives a synthetic local
principal with every scope. Use it only when the process boundary and MCP client configuration are
trusted.

### HTTP

`POST /mcp` accepts an `Authorization: Bearer ...` credential:

- a `dcmcp_` personal access token;
- an OIDC access token, when OIDC is configured;
- or, only when explicitly enabled, a principal identity asserted by a trusted reverse proxy.

Bearer identity is carried through the MCP request's own authentication context, so concurrent
requests cannot overwrite one another's principal.

## Personal access tokens

Create a principal first:

```sh
corepack pnpm cli -- principal create operator \
  mcp:read,mcp:write,template:read,template:write,server:plan
```

Then create a token:

```sh
corepack pnpm cli -- auth token create PRINCIPAL_ID laptop 90
```

The token is printed once and begins with `dcmcp_`. Only an Argon2id hash and a short display prefix
are stored. Expiry defaults to 90 days and must be between 1 and 365 days.

Use it with an HTTP MCP client:

```http
Authorization: Bearer dcmcp_REDACTED
```

List or revoke tokens without exposing their values:

```sh
corepack pnpm cli -- auth token list PRINCIPAL_ID
corepack pnpm cli -- auth token revoke TOKEN_ID
```

Revocation and principal disablement take effect on the next request.

## OIDC bearer tokens

Set all three variables to enable OIDC:

```dotenv
OIDC_ISSUER=https://identity.example.com/
OIDC_AUDIENCE=https://discord-mcp.example.com/mcp
OIDC_JWKS_URI=https://identity.example.com/.well-known/jwks.json
```

The server verifies the JWT signature against the remote JWKS and requires matching issuer,
audience, `sub`, and `exp`. It accepts scopes from a space-separated `scope` claim or an array-valued
`scopes` claim and ignores names outside the supported scope list.

The first valid subject is materialized as an OIDC principal. Subsequent requests use the persisted
principal record so an operator can disable it. The server is only an OAuth resource server: it does
not provide user accounts, passwords, consent, or a login page.

Resource metadata is available without authentication:

```text
/.well-known/oauth-protected-resource
/.well-known/oauth-protected-resource/mcp
```

## Trusted proxy identity

Trusted proxy identity is disabled by default. Enable it only when the reverse proxy exclusively
controls the identity and groups headers and the server port cannot be reached around that proxy:

```dotenv
TRUST_PROXY_IDENTITY=true
TRUSTED_PROXY_CIDRS=172.18.0.0/16
TRUST_PROXY_IDENTITY_HEADER=x-forwarded-user
TRUST_PROXY_GROUPS_HEADER=x-forwarded-groups
```

The immediate peer must be inside `TRUSTED_PROXY_CIDRS`. Forwarded requests must report HTTPS and an
allowed host. Both configured identity and groups headers are required, and the identity must map to
an active stored principal. The groups header is required to prove the proxy's complete identity
contract, but scopes come from local principal bindings, not from arbitrary group names.

V1 intentionally has no proxy-identity provisioning command. Deployments using this mode must
provision `principals`, `principal_scope_bindings`, and `proxy_identities` as part of their controlled
identity integration. Prefer PAT or OIDC unless that integration is already managed.

If any forwarding header arrives from an untrusted peer, the request is rejected rather than treated
as a direct request.

## Scope reference

| Scope | Grants |
| --- | --- |
| `mcp:read` | Read-only Discord operations and owned metadata |
| `mcp:write` | Ordinary Discord mutations |
| `mcp:destructive` | Destructive Discord operations after a one-use preview |
| `bot:admin` | Bot/application configuration, presence, voice state, and administrator-class calls |
| `mentions:broad` | Permit broad mention forms otherwise blocked by presentation policy |
| `template:read` | List/get/render owned templates |
| `template:write` | Create, update, publish, and delete templates |
| `server:plan` | Capture snapshots, plan blueprints, and explain permissions |
| `server:apply` | Apply a previewed blueprint plan |
| `blob:write` | Upload and delete owned blobs |
| `oauth:manage` | Authorize, inspect, grant, and revoke Discord OAuth profiles |
| `workflow:read` | Inspect owned workflows, revisions, and executions |
| `workflow:write` | Create, edit, validate, and publish workflows |
| `workflow:admin` | Grant, enable, disable, rollback, and administer workflow execution |
| `auth:admin` | Cross-owner administration where supported |
| `audit:read` | Read audit/metrics data |

Tools may require more than one scope, and a risk class can add a stronger scope than the feature's
base scope. Scope authorization does not bypass Discord guild permissions, role hierarchy, preview
tokens, ownership checks, or workflow grants.

## Least-privilege examples

Read-only Discord inspection:

```sh
corepack pnpm cli -- principal create observer mcp:read
```

Template author:

```sh
corepack pnpm cli -- principal create publisher \
  mcp:read,template:read,template:write,blob:write
```

Blueprint operator who can plan but not apply:

```sh
corepack pnpm cli -- principal create planner mcp:read,server:plan
```

Do not give automation `mcp:destructive`, `bot:admin`, `server:apply`, `workflow:admin`, or
`auth:admin` merely for convenience.

## HTTP safety checks

For a non-loopback listener the server requires an HTTPS `PUBLIC_BASE_URL`, exact
`ALLOWED_HOSTS`, and explicit trusted-proxy configuration. It validates the direct Host header,
forwarded host/protocol, and proxy CIDR chain. Workflow routes additionally validate their own
configured Origin allowlists. CORS only controls browser access; it is not authentication.

Health endpoints disclose only `{ "ok": true }`. `/metrics`, blob endpoints, OAuth authorization,
and `/mcp` apply their own authentication and scopes.
