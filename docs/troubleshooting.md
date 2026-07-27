# Troubleshooting

Start with the first failing boundary. Avoid changing permissions, credentials, network, and code at
the same time.

## Server exits immediately

Check structured startup logs and:

```sh
corepack pnpm cli -- diagnostics
docker compose config
docker compose logs --tail=200 server
```

Common causes:

- `DISCORD_TOKEN` is missing;
- a non-loopback listener lacks HTTPS `PUBLIC_BASE_URL`, exact `ALLOWED_HOSTS`, or proxy CIDRs;
- a required path is not writable by UID 65532;
- the database cannot migrate;
- the master key format is invalid for an enabled encrypted feature.

## HTTP returns host/proxy errors

The server rejects:

- a Host outside `ALLOWED_HOSTS`;
- forwarding headers from a peer outside `TRUSTED_PROXY_CIDRS`;
- forwarded protocol other than HTTPS;
- a forwarded host that is missing or disallowed;
- malformed forwarding chains;
- disallowed browser origins.

Inspect the direct and forwarded headers at the proxy. Do not add `0.0.0.0/0` as a trusted proxy
range to make the error disappear.

## MCP returns 401 or 403

401 means the bearer is invalid, expired, revoked, disabled, or rejected by OIDC/proxy validation.
403/authorization errors mean the authenticated principal lacks the required scope or ownership.

```sh
corepack pnpm cli -- principal list
corepack pnpm cli -- auth token list PRINCIPAL_ID
```

For OIDC, verify issuer, audience, JWKS reachability, `sub`, `exp`, and scope claims. For proxy
identity, verify the immediate peer CIDR, both configured headers, and local identity mapping.

## Discord returns 401

The bot token or OAuth profile is invalid/expired/revoked, or the operation rejects that credential
type. Describe the operation and check `authMode`. Do not paste the token into a raw API argument.

## Discord returns 403

Call `discord_permissions_explain` once with the same target. Check:

- bot role permission bits;
- channel/category overwrites;
- bot and target role hierarchy;
- application installation and command authorization;
- required privileged intent;
- OAuth profile ownership/grant.

Stop retries before RateGuard trips.

## Gateway is disconnected

Call `discord_gateway_status` and check:

- mode is not `off`;
- at least one feature needs a connection in `lazy` mode;
- every configured intent name is valid;
- privileged intents are enabled in the Developer Portal;
- outbound WebSocket/HTTPS access to Discord works.

Close 4014 points to an unavailable privileged intent; 4013 points to an invalid bitset.

## Message content is unexpectedly empty

If message objects exist but content, embeds, attachments, and components are blank, enable the
Message Content privileged intent in the Developer Portal and add `MessageContent` locally.
`discord_message_list` adds a diagnosis for this pattern.

## Interaction URL validation fails

Confirm:

- the public URL ends at `/discord/interactions`;
- `DISCORD_PUBLIC_KEY` belongs to the same application;
- the proxy preserves exact raw body bytes;
- both Discord signature headers reach the server;
- host/TLS rules accept the public request;
- no middleware parses and reserializes JSON.

## Destructive preview is rejected

Preview tokens expire in 60 seconds, are single-use, and bind the principal, operation, normalized
arguments, auth profile, and targets. Generate a new preview only after reviewing the exact intended
call. A changed argument or different principal correctly invalidates the token.

Blueprint previews additionally go stale when live guild state changes. Capture and plan again.

## Workflow validation/build fails

Inspect validation diagnostics for:

- missing default export or `Workflow.make`;
- invalid trigger definition;
- source over 256 KiB;
- more than 100 direct dependencies;
- missing/frozen lockfile incompatibility;
- lifecycle script required but not granted;
- build timeout;
- artifact over 20 MiB;
- package unavailable for the runner architecture.

Prefer a smaller pure-JavaScript dependency before enabling install scripts.

## Supervisor refuses to start

The daemon must be rootless and enforce cgroup v2 memory and PID limits. Check:

```sh
docker context inspect rootless
docker info
stat "$ROOTLESS_DOCKER_SOCKET"
docker compose logs --tail=200 supervisor
```

Confirm the socket group matches `ROOTLESS_DOCKER_GID`, the runtime paths are mounted at the same
absolute host path, and the daemon can pull the configured builder/runner images.

The rootful override is for isolated development, not a production fix.

## Runner cannot start or artifact digest mismatches

Do not edit `data/artifacts`. Restore the exact artifact from backup or publish a new revision.
Confirm server and supervisor share the same `data` host path and that builder/runner image tags match
the deployed release.

## Workflow route returns 401/403/404/413

- 401: API key/bearer/HMAC is absent or invalid.
- 403: public/CIDR/grant policy rejects the request.
- 404: slug/path/method is not registered by an enabled revision.
- 413: declared or actual body exceeds the route limit.

For HMAC, sign `timestamp + "." + exactRawBody`, send the lowercase hexadecimal digest and Unix
seconds, and do not replay a successful signature.

## Workflow queue grows

Inspect queue-depth, failure, timeout, and kill metrics plus recent executions. Disable a runaway
route/trigger, correct the workflow or dependency, and then let the durable queue drain. Increase
concurrency only after confirming the handler is idempotent and Discord/downstream limits allow it.

## OAuth callback or refresh fails

Check the exact redirect URI, state age, initiating principal, client secret, public base URL, and
master key. Refresh failures often mean the upstream grant was revoked or refresh token rotated;
reauthorize rather than editing ciphertext.

## Blob upload fails

Check `blob:write`, `Content-Length`, configured per-blob limit/quota, filename header, filesystem
ownership, and available disk space. A referenced blob cannot be deleted until its template/resource
reference is released.

## Compose paths work locally but runners cannot mount

The supervisor talks to a host daemon, so daemon-visible paths must be absolute host paths. Run
Compose from the repository/deployment directory and keep the duplicated `${PWD}/data` and
`${PWD}/run` mounts. Moving the project after enabling workflows breaks those path assumptions.

## Still unresolved

Collect:

- exact image/commit tag;
- redacted structured logs;
- `diagnostics` output;
- failing tool/operation and typed error;
- request, correlation, execution, and workflow revision IDs;
- relevant metric deltas;
- whether the issue reproduces in a disposable guild or workflow.

Never include tokens, named-secret values, message bodies, blob bytes, raw authorization headers, or
the master key.
