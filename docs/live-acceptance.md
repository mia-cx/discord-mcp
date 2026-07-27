# Live Discord acceptance

The live suite is deliberately excluded from ordinary CI. Run it only against a disposable guild:

```sh
DISCORD_MCP_E2E=true \
DISCORD_TOKEN=... \
DISCORD_MCP_TEST_GUILD_ID=... \
DISCORD_MCP_TEST_CHANNEL_ID=... \
corepack pnpm test:e2e
```

The automated harness authenticates the application; inspects the guild and channel; exercises the
message create/edit/read/react/delete lifecycle; uploads a rich Components V2 announcement and typed
template rendering; creates, orders, protects, and removes temporary role/category/text/forum/voice
resources; and cleans up every tracked object. The following opt-ins add destructive or negative
coverage:

- `DISCORD_MCP_TEST_MEMBER_ID`: timeout/clear and ban/unban a designated disposable member.
- `DISCORD_MCP_TEST_FORBIDDEN_CHANNEL_ID`: prove a genuine Discord 403.
- `DISCORD_MCP_TEST_OAUTH_TOKEN`: call `/users/@me` with a bearer token without logging it.

The remaining checks cross a human Discord-client or public-Traefik boundary and therefore use this
release checklist rather than pretending to automate a user account:

1. Start the Compose deployment behind the documented HTTPS Traefik route and confirm
   `/health/live`, `/health/ready`, and protected MCP access.
2. Through MCP, publish and render a stored Components V2 template, then plan/apply the disposable
   blueprint and re-plan to prove a zero-action diff.
3. Publish a guild slash-command workflow. Invoke it from a normal Discord client and verify the
   initial defer arrives under three seconds and the original response is edited within 15 minutes.
4. Send a workflow-bound button, click it, verify the opaque binding routes to the expected workflow
   revision, and edit the response.
5. Publish a namespaced HMAC route through Traefik; verify valid authentication, replay rejection,
   host/origin/CIDR enforcement, and bounded request bodies.
6. Complete the OAuth profile flow in a browser, call a permitted user endpoint by profile ID, then
   revoke it and confirm token material is erased.
7. Enable a filtered Gateway workflow, produce the event, observe it through
   `discord_workflow_executions_tail`, publish a second revision, and roll back.
8. Inspect every workflow runner container and confirm no Discord bot, OAuth, webhook, interaction,
   HMAC, or API-key credential is present in its environment or mounted filesystem.
9. With `MESSAGE_CONTENT` disabled for the test application, read a non-empty message result and
   confirm the tool warning names the missing privileged intent.

Record the application ID, guild ID, tested revision digests, timestamps, and cleanup result in the
release record. Never record tokens or message contents.
