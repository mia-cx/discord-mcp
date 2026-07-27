# Discord OAuth profiles

Discord OAuth profiles hold encrypted user access/refresh tokens for operations that require or
benefit from user context. They are owned by an MCP principal and are separate from the credential
used to authenticate that principal to this server.

Use a bot token for normal bot automation. Add OAuth only for an operation that the pinned catalog
marks as incompatible with bot authentication or when a deliberate user-context action is required.

## Prerequisites

Set:

```dotenv
DISCORD_APPLICATION_ID=123456789012345678
DISCORD_CLIENT_SECRET=replace-me
DISCORD_MCP_MASTER_KEY=base64-encoded-32-byte-key
PUBLIC_BASE_URL=https://discord-mcp.example.com
```

Generate the master key with:

```sh
openssl rand -base64 32
```

Register this exact redirect URI in the Discord Developer Portal:

```text
https://discord-mcp.example.com/oauth/discord/callback
```

The application ID may be derived and cached from Discord when omitted, but setting it explicitly
makes deployment failures easier to diagnose.

## Authorization flow

1. Call `discord_oauth_profile_authorize` with the desired profile name and Discord scopes.
2. Open the returned authorization URL while signed in to the intended Discord account.
3. Discord redirects to `/oauth/discord/callback`.
4. The server validates the one-time state, initiating principal, expiration, and PKCE verifier.
5. It exchanges the code and stores encrypted access/refresh material.
6. List or get the profile to confirm metadata; token material is never returned.

Authorization state expires after ten minutes. A state value is bound to its initiating MCP principal
and cannot be completed as another principal.

There is also an authenticated redirect helper at `/oauth/discord/authorize/{state}`. It requires
`oauth:manage` and redirects only a valid owned state to Discord.

## Using a profile

For curated or catalog operations that support it, select:

```json
{
  "authMode": "oauth2",
  "authProfileId": "PROFILE_UUID"
}
```

The caller must own the profile or have an explicit grant. A workflow must name the profile ID in the
approved revision grant. The broker never passes profile tokens into the workflow runner.

Five pinned Discord operations explicitly reject bot credentials. The server refuses those
operations in `bot` mode before making a request.

## Refresh and revocation

Access tokens are refreshed shortly before expiry. Refresh for one profile is serialized so
concurrent calls cannot rotate the same refresh token independently. Updated ciphertext is committed
durably before callers continue.

`discord_oauth_profile_revoke` calls Discord's revocation endpoint and removes local ciphertext.
Treat revocation as permanent; authorize a new profile if access is needed again.

## Encryption and ownership

Access tokens, refresh tokens, and named secrets use AES-256-GCM with
`DISCORD_MCP_MASTER_KEY`. Profile list/get results contain identity, scope, expiry, ownership, and
status metadata but no ciphertext or plaintext token.

Back up the key separately from SQLite. The database without the key cannot decrypt profile tokens;
the key without the database does not contain them. If both are compromised, revoke the upstream
Discord grants and rotate every encrypted named secret.

If the key is lost:

1. stop the service;
2. revoke the affected application grants in Discord;
3. delete or quarantine unusable encrypted rows;
4. install a new key;
5. authorize replacement profiles and restore named secrets from their source systems.

There is no recovery path for ciphertext without the original key.

## Common failures

- `invalid state` or `expired state`: begin authorization again; do not reuse the callback URL.
- Redirect mismatch: make `PUBLIC_BASE_URL` and the Developer Portal URI byte-for-byte identical.
- Refresh failure: inspect the redacted audit/metric result, then reauthorize if the grant was
  revoked.
- Profile not visible: confirm the current MCP principal owns it and has `oauth:manage`.
- Operation refuses bot auth: describe the operation, then intentionally choose a permitted OAuth
  profile rather than retrying with arbitrary headers.
