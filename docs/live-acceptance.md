# Live Discord acceptance

The live suite and human checklist validate boundaries that offline tests cannot: a real Discord
application and guild, public TLS/proxy behavior, normal Discord-client interactions, browser OAuth,
and cleanup.

Run only against a disposable guild and test application. Never point a development acceptance run at
a production community.

## Before the run

- record the application ID, deployment image/commit tags, and test date;
- create a disposable guild and channel;
- place the bot role above temporary roles it may manage;
- grant only the permissions under test;
- enable the exact Gateway intents under test;
- ensure no production workflows, commands, webhooks, or OAuth profiles share the application;
- take note of every pre-existing guild resource so cleanup can be verified.

## Automated harness

```sh
DISCORD_MCP_E2E=true \
DISCORD_TOKEN=... \
DISCORD_MCP_TEST_GUILD_ID=... \
DISCORD_MCP_TEST_CHANNEL_ID=... \
corepack pnpm test:e2e
```

It authenticates the application; inspects the guild/channel; exercises message
create/edit/read/react/delete; uploads a rich Components V2 announcement and typed template
rendering; creates, orders, protects, and removes temporary role/category/text/forum/voice resources;
and cleans every tracked object.

Optional cases:

- `DISCORD_MCP_TEST_MEMBER_ID`: timeout/clear and ban/unban a designated disposable member.
- `DISCORD_MCP_TEST_FORBIDDEN_CHANNEL_ID`: prove a genuine Discord 403.
- `DISCORD_MCP_TEST_OAUTH_TOKEN`: call `/users/@me` with a user token that is never logged.

If cleanup fails, preserve the returned IDs, remove those exact resources manually, and record the
failure. Do not rerun until the guild is back at baseline.

## Public deployment and MCP

1. Start the four-image Compose deployment behind documented HTTPS Traefik routing.
2. Confirm `/health/live` and `/health/ready`.
3. Confirm direct access around the proxy is unavailable.
4. Connect over `/mcp` with a narrow PAT.
5. Prove an invalid/revoked PAT fails.
6. Confirm wrong Host, forwarded-protocol, and untrusted-proxy cases are rejected.
7. Read `/metrics` with `audit:read` and prove a token without it is rejected.

## Presentations, templates, and blueprints

1. Validate/send one safe legacy message with explicit `allowedMentions`.
2. Publish/render/send a Components V2 template with a stored blob.
3. Click a template-owned button and verify the durable opaque binding.
4. Publish a disposable blueprint covering guild settings, roles, channel kinds/overwrites, AutoMod,
   welcome/rules/onboarding/system-channel settings.
5. Plan and apply.
6. Capture fresh state and re-plan to prove a zero-action diff.
7. Change live state after a preview and prove stale apply is refused.

Clean all blueprint-created resources by exact binding/ID.

## Gateway and interactions

1. Confirm the configured Gateway mode and intents.
2. Produce a filtered event and read it through cursor/tail.
3. Publish a guild slash-command workflow.
4. Invoke it from a normal Discord client.
5. Verify an initial response or defer arrives within Discord's deadline and a deferred response is
   edited within the interaction token lifetime.
6. Send a workflow-bound button, click it, and verify routing to the owning enabled revision.
7. Open/submit a workflow modal and exercise autocomplete with at most 25 choices.
8. Replay the same interaction delivery and prove the durable dedupe record prevents duplicate work.

These must use a normal client or Discord's delivery path; a bot cannot safely simulate the complete
user interaction boundary.

## Workflow routes and sandbox

1. Publish a namespaced HMAC route through the public proxy.
2. Verify the signature covers the exact body.
3. Verify stale timestamp, replay, wrong host, wrong Origin, wrong CIDR, and oversized body
   rejection.
4. Exercise API-key/bearer policy if used in production.
5. Enable a Gateway and scheduled workflow, inspect durable executions, publish a second revision,
   and roll back.
6. Restart server/supervisor with queued work and confirm recovery.
7. Inspect every runner container for non-root identity, read-only mounts/root, no network, bounded
   resources, no Docker socket, and no Discord/MCP/OAuth/master/supervisor/route credential.

Also run `corepack pnpm test:sandbox` on the deployment's daemon configuration.

## Discord OAuth profile

1. Start authorization as a principal with `oauth:manage`.
2. Complete consent in a browser.
3. Confirm list/get reveal metadata but no token material.
4. Call a permitted user-context operation by profile ID.
5. Trigger or wait for refresh when practical.
6. Revoke and confirm subsequent use fails and ciphertext is erased.

Never record the user token or callback code.

## Message Content negative check

With Message Content disabled for the test application, read a channel containing a non-empty message
and confirm the message-list diagnosis names the missing privileged intent. Re-enable the intent only
if the production feature requires it.

## Acceptance record

Record:

- application and guild IDs;
- commit and four image digests/tags;
- database migration version;
- workflow source/artifact digests and granted revision;
- automated and manual step results;
- timestamps and tester;
- cleanup result and remaining resource IDs, if any;
- any intentionally skipped optional case and why.

Never record Discord/MCP/OAuth tokens, client/master/supervisor/named secrets, message contents, blob
bytes, or raw authorization/signature headers.
