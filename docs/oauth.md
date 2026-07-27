# Discord OAuth2 profiles and MCP authentication

MCP client authentication and Discord OAuth profiles are separate.

For MCP HTTP, configure an external OIDC issuer (`OIDC_ISSUER`, `OIDC_AUDIENCE`, `OIDC_JWKS_URI`),
use scoped PATs from the CLI, or explicitly trust Traefik identity headers from configured CIDRs.
The server is an OAuth resource server; it does not provide accounts, passwords, consent, or login UI.

For user-context Discord operations, set `DISCORD_CLIENT_SECRET`, `PUBLIC_BASE_URL`, and
`DISCORD_MCP_MASTER_KEY`, then call `discord_oauth_profile_authorize`. Open the returned Discord URL.
The callback validates ten-minute state, initiating principal, and PKCE; access and refresh tokens are
AES-256-GCM encrypted. Profile list/get never return token material. Refresh is single-flight shortly
before expiry; revoke calls Discord and erases ciphertext.

The five Discord operations that reject bot tokens are refused only for `bot`. Select
`authMode: "oauth2"` and an owned/granted profile. A workflow must name the profile ID in its
approved grant.

If the master key is lost, encrypted OAuth and named secret material cannot be recovered. Revoke the
upstream grants, delete the unusable rows, install a new key, and authorize again.
