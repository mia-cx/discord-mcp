# discord-mcp

A Discord HTTP API relay over MCP. Log in with Discord OAuth and supply your own
bot token. Every tool call acts as that bot under Discord's bot permissions.

## Connect

Ask your relay operator for its MCP URL and access. This repository does not
publish a hosted endpoint.

Follow [Agent setup and OAuth login](./docs/connecting.md) for Claude Code, Codex,
Devin, Cursor, and other stdio MCP clients. One browser login and private bot-token
file can serve all agents under the same OS account. The helpers need Node.js 24+
but no dependency installation. They are not published to npm.

### Authentication

Supply both credentials on **every HTTP MCP request**, including initialization and tool discovery:

```http
Authorization: Bearer YOUR_RELAY_OAUTH_ACCESS_TOKEN
X-Discord-Bot-Token: YOUR_DISCORD_BOT_TOKEN
```

Read `access_token` from the helper's credential file for the bearer header.
Do not append the bot token to it. The custom header has the same transport
protection as bearer auth over HTTPS. Redact both headers in clients and proxies.
Neither credential belongs in a URL, tool argument, or ordinary signed JWT.

The relay checks the OAuth grant with Discord's `GET /oauth2/@me` on every request.
It checks the bot with `GET /users/@me`, uses that token for the request,
and releases the request's client. Raw Discord OAuth tokens and user-account
tokens are not accepted as MCP bearer credentials.

OAuth requests only `identify`. Operators can restrict access with
`DISCORD_OAUTH_ALLOWED_USER_IDS`; unlisted accounts cannot finish login or use
previously issued credentials. Without that restriction, any Discord human may sign in.
Login does not prove bot ownership or restrict a bot to that human's guild permissions.
Possession of a valid bot token grants that bot's existing authority.

No local accounts, PATs, stored OAuth profiles, database, Gateway connection,
background jobs, or stored bot credentials are required. [Bot hosting](#bot-hosting)
adds a database and stored, encrypted bot tokens. The client holds an
encrypted, audience-bound relay credential enclosing its Discord login grant.
Authentication results and Discord responses are not cached. Responses use
`Cache-Control: no-store`. Revoking Discord authorization blocks the next request.

Access credentials expire with the Discord grant, capped at seven days. The
token response also carries a `refresh_token`: an encrypted envelope around
Discord's refresh token, bound to the human and the client ID. Refreshing at
`/token` rotates both credentials and revokes the previous access credential.
Discord rejects a reused refresh token, which the relay reports as `invalid_grant`:
sign in again. Refresh rechecks the allowlist, works after the client's 30-day
registration expires, and lapses after 30 days unused.

Refresh revokes every copy of the previous login, so each machine needs its own
sign-in. The stdio bridge refreshes a day before expiry and after a rejected
access credential, and bridges sharing one login file take turns through a lock.
Authorization codes also enclose Discord's refresh token, and redeeming one
rotates it, so Discord rejects a replayed code. No login state lives in memory:
any replica can finish any login, and restarts preserve logins in progress.

The executable serves MCP revision `2026-07-28` without an initialization handshake
or sessions. Older MCP clients can use the SDK's stateless compatibility path.
Both paths require OAuth and bot credentials on every HTTP request.

## Tools

| Tool | Purpose |
| --- | --- |
| `discord_api_search` | Find bot-authenticated operations and their Discord permission requirements. |
| `discord_api_describe` | Read an operation's parameters, request body schema, and permission requirements. |
| `discord_api_read` | Execute read operations. |
| `discord_api_write` | Execute create/update operations. |
| `discord_api_destructive` | Execute deletes and other destructive operations. |
| `discord_api_admin` | Change bot/application settings and commands. |
| `discord_guild_get` | Read a guild with a compact, typed result. |
| `discord_permissions_explain` | Diagnose effective guild/channel permissions. |
| `discord_script_run` | Run one-off discord.js code as the bot, checked against its grants. |
| `discord_workflow_publish` | Store a new revision of a workflow: discord.js code that runs on Gateway events and HTTP requests. |
| `discord_workflow_list` | List the bot's workflows, what each runs with, and who changed them. |
| `discord_workflow_enable` | Run a workflow revision on the bot's events and route, and show its grants. |
| `discord_workflow_disable` | Stop running a workflow. |
| `discord_workflow_delete` | Delete a workflow, its revisions, its state, and its logs. |
| `discord_workflow_logs` | Read the bot's recent workflow runs: outcomes, errors, and console output. |
| `discord_voice_join` | Join a voice channel to play audio there, and optionally hear it. [Bot hosting](#bot-hosting) only. |
| `discord_voice_leave` | Leave a server's voice channel. Bot hosting only. |

The catalog covers the vendored specification's 242 operations. The relay exposes
bot-authenticated, non-credential operations. OAuth-only endpoints and operations
requiring separate credentials are unavailable. Use search and describe to find
the supported operation and its input schema.

Arguments are validated locally before execution. Destructive and admin calls act
directly under the supplied bot's Discord permissions, with no preview-token
sessions; only [scripts](#scripts) and [workflows](#workflows) carry server-side grants. Voice
is relayed, never stored, and the relay runs no agent conversations.

Calls currently accept JSON payloads. Multipart file upload is not implemented.
Discord rate limits and API errors are returned to the caller; the HTTP relay
disables automatic retries and rate-limit waits.

## Scripts

`discord_script_run` batches many Discord calls into one tool call. The source is a
module whose default export receives a discord.js `Client`:

```ts
import { EmbedBuilder } from 'discord.js'

export default async ({ client }) => {
  const channel = await client.channels.fetch('123456789012345678')
  for (const title of ['One', 'Two', 'Three']) {
    await channel.send({ embeds: [new EmbedBuilder().setTitle(title)] })
  }
  return 'sent'
}
```

Pass `grants` with the call: `operations` lists catalog operation IDs, `families`
grants a family's read and write operations, and `hosts` lists hostnames the script
may `fetch()`. Destructive and admin operations must be named in `operations`. A
refused call fails inside the script with HTTP 403 and is listed in the result's `denied`.

Each script runs once in a fresh [workerd](https://github.com/cloudflare/workerd)
process with no Gateway connection and no bot token. Every request it makes, whatever
its URL, reaches a broker in the relay. The broker matches Discord calls to catalog
operations, checks the grants, and replays them with the request's bot token.
Outbound HTTP reaches granted hosts on public addresses only: the broker checks every
address a hostname resolves to and every redirect target, refuses private, loopback,
link-local, cloud metadata, and IPv4-mapped addresses, and connects to the address it
checked. One bot's scripts run one at a time.
A script is killed after `timeoutSeconds` (30 by default, 120 at most).

The HTTP relay offers the tool only when `DISCORD_OAUTH_ALLOWED_USER_IDS` is set.
Local stdio always offers it. workerd ships as an npm dependency for glibc Linux,
macOS, and Windows.

## Workflows

A workflow is discord.js code that runs as the bot on Gateway events, cron schedules, and
inbound HTTP requests, while no agent is connected. It is written like an ordinary bot:

```ts
import { Client, Events, GatewayIntentBits } from 'discord.js'

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
})

client.on(Events.MessageCreate, async (message) => {
  if (message.content === 'ping') await message.reply('pong')
})

client.login(process.env.DISCORD_TOKEN)
```

`discord_workflow_publish` bundles the source with esbuild and loads it once in workerd to
find the events its clients listen for and the intents and schedules they declare, then stores
the bundle as the workflow's next immutable revision.

A workflow may import npm packages listed in `dependencies`, with a version, range, or tag;
pass a `package-lock.json` as `lockfile` to pin every version. npm installs them from the
public registry with install scripts off, through a proxy that reaches only the registry.
Each revision records every package version it was built with. Publishing fails, before any
revision is stored, on a package that can't be bundled or loaded in workerd, such as a native
addon, and on code that can't work when each event runs in a fresh isolate: collectors,
`awaitMessages`, and URL attachments. These checks read the workflow's own syntax, so a call
built at runtime, or made inside a dependency, gets past them. Installs are capped at 256 MB
and two at a time per bot host. discord.js and `textile` always come from the platform, even
for a package that installs its own.

`discord_workflow_enable` runs a revision and returns its grants, intents, and schedules;
Discord's privileged intents must be on in the Developer Portal first. While any workflow is
enabled, the bot stays online without agent calls. After a restart, workflows also run the
events Discord replays.

Workflows listen for `messageCreate`, `messageUpdate`, `messageDelete`,
`messageReactionAdd`, `messageReactionRemove`, `guildMemberAdd`, `guildMemberRemove`, and
`interactionCreate`. Each event runs each listening workflow in its own fresh workerd
process for at most 30 seconds, so nothing in memory lasts between events, and listeners
may receive partial objects. Each workflow receives only the events its own intents cover.
A guild's events run in order; interactions run at once. The bot's own messages are not delivered. Grants work as for scripts. A
workflow may also answer the interaction it is handling (`reply`, `deferReply`, `editReply`,
`followUp`) with the `interaction` and `webhook` families, and set the bot's presence.

To run on a schedule, a client lists five-field cron expressions, in UTC, in a `schedules`
option and listens for `schedule`:

```ts
const client = new Client({ intents: [], schedules: ['0 9 * * *'] })

client.on('schedule', async ({ cron, scheduledAt }) => {
  const channel = await client.channels.fetch('123456789012345678')
  await channel.send(`Digest for ${scheduledAt.toISOString().slice(0, 10)}`)
})
```

A workflow declares at most ten schedules, which together fire at most every five minutes, and
each client hears only its own schedules. Each tick
runs once, however many bot hosts there are, and schedules start when the workflow is enabled.
A tick missed while the bot's host was down, or the bot was offline, runs once, late, when the
bot is back online: each schedule runs its most recent missed tick and skips the earlier ones,
and `scheduledAt` says when it was due.

A workflow answers webhooks when it default-exports a fetch handler. It needs no Gateway
listeners, but calls Discord through a client created at the top level:

```ts
import { Client } from 'discord.js'

const client = new Client({ intents: [] })

export default {
  async fetch(request: Request) {
    const { text } = await request.json()
    await client.rest.post('/channels/123456789012345678/messages', { body: { content: text } })
    return new Response('ok')
  },
}
```

Once enabled, any request to `/workflows/<bot ID>/<name>` on the relay, or to a path below it,
runs the handler in a fresh workerd process for at most 10 seconds. Built-in endpoints never
live under `/workflows/`, so a route can't shadow one. Routes need no login, so a handler
should verify its sender, for example by a signature over the exact body bytes it receives.
Request bodies are limited to 1 MiB, and a response body over about 700 KiB fails. The
response keeps only its status, body, and `Content-Type`, and is served with a sandbox
content security policy, since routes share the relay's origin. A disabled or deleted
workflow's route answers 404. While Discord has the bot offline, its routes answer 503 with
`Retry-After: 1`. Each bot may have eight route requests waiting or running; more get 503
too.

A workflow keeps state between runs in its own key-value store:

```ts
import { kv } from 'textile'

const count = ((await kv.get('count')) ?? 0) + 1
await kv.set('count', count)
```

Values are anything JSON can hold. State belongs to the workflow, not a revision: it lasts
across runs, revisions, and restarts, and goes when the workflow is deleted. A workflow's
keys and values take at most 1 MiB together, and a key at most 512 bytes; a `set` past
either throws and stores nothing. Only one guild's non-interaction events run in order:
interactions, route requests, direct messages from different channels, and other guilds'
events run at the same time, so their writes to one key can interleave, and the last one wins.

`discord_workflow_logs` shows the bot's recent runs, newest first: each run's event
(`schedule <cron>` for a tick, `HTTP` and the method for a route request), outcome, error, and console output, filtered by workflow or to failures only. A run keeps up
to 16,384 characters of output; one that timed out or crashed keeps none. Bot and interaction tokens in
logs and errors read `[redacted]`. Runs stay readable for 7 days, up to the newest 1,000 per
workflow. Bot hosts delete expired runs at startup, and at most hourly while workflows run.

Anyone with relay access and the bot's token manages its workflows. Every publish, enable,
disable, and delete is recorded with the acting human's Discord user ID, and
`discord_workflow_list` shows the latest changes. Workflow tools need [bot hosting](#bot-hosting).

## Permission metadata

Search and describe return each operation's `permissions`: the Discord permission
names it needs, whether Discord evaluates them for the guild or a channel, and the
path parameter or lookup that identifies it. Entries also record alternatives such
as message authorship, requirements that depend on the request, and role-hierarchy
rules. `none` means Discord requires no permission; `unknown` means Discord does not
document the route.

This relay reports the metadata but does not enforce it: Discord still checks every
call against the bot. A relay acting for a person can import the table with the
catalog and the effective-permission resolver, then re-check each call against that
person's permissions:

```ts
import { computeEffectivePermissions, requiredPermissions } from '@mia-cx/discord-catalog'
```

[`@mia-cx/discord-catalog`](./packages/discord-catalog) runs in Node and in Cloudflare
Workers without `nodejs_compat`; `pnpm package:verify` proves it from the packed
tarball. Read the evaluation rules
in [`required-permissions.ts`](./packages/discord-catalog/src/required-permissions.ts):
a consumer that skips a condition it cannot verify stays stricter than the rule.

The table and resolver are not a complete authorization engine for a person. The
consumer must also enforce timeouts, private-thread membership, and the `only` and
`when` conditions, and filter guild-wide responses, which return what the bot can
see. Rendering permissions such as `EmbedLinks` are not listed, so content renders
with the bot's permissions.

Discord's OpenAPI specification has no permission data, so the table is written by
hand from [Discord's developer documentation](https://docs.discord.com/developers).
Each entry cites its sources, and `permissionSources` records the documentation
commit last checked. `pnpm spec:check` fails until every cataloged operation has
a well-formed entry.

## Run from source

Requires Node.js 24.9+ and the pnpm version pinned in `package.json`.

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm build
corepack pnpm start
```

HTTP defaults to `127.0.0.1:3000`. It requires the OAuth settings below,
not a `DISCORD_TOKEN`: callers supply their own bot tokens.

For a local stdio client, supply its bot token in the child process environment:

```sh
MCP_TRANSPORT=stdio DISCORD_TOKEN=YOUR_DISCORD_BOT_TOKEN node apps/server/dist/bin.js
```

Local stdio does not require OAuth. It keeps the caller's token for the process
lifetime and uses the same tools, without a database or background processes.
Stdout is reserved for JSON-RPC; logs go to stderr.

## Deploy

Configure one Discord application for the hosted relay, not one per caller:

1. Create or reuse an application in the [Discord Developer Portal](https://discord.com/developers/applications).
2. Add `https://YOUR_HOST/auth/discord/callback` under OAuth2 redirects.
   Use `http://127.0.0.1:3000/auth/discord/callback` for local development.
3. Set `DISCORD_OAUTH_CLIENT_ID`, `DISCORD_OAUTH_CLIENT_SECRET`, and a stable
   `OAUTH_ENCRYPTION_KEY` generated with `openssl rand -base64 32`.

`docker/compose.yaml` runs one HTTP relay without data volumes.
Set these OAuth values, `PUBLIC_BASE_URL`, and `ALLOWED_HOSTS` using
[docker/.env.example](./docker/.env.example), then run Compose from `docker/`.
Keep the environment file private. Rotating the encryption key invalidates all logins.

| Setting | Default / purpose |
| --- | --- |
| `MCP_TRANSPORT` | `http`; also accepts `stdio`. |
| `MCP_HTTP_HOST` | `127.0.0.1` from source, `0.0.0.0` inside the image. |
| `MCP_HTTP_PORT` | `3000`. |
| `PUBLIC_BASE_URL` | Public HTTPS URL; required for non-loopback binds. |
| `DISCORD_OAUTH_CLIENT_ID` | Required for HTTP. The relay's Discord application ID. |
| `DISCORD_OAUTH_CLIENT_SECRET` | Required for HTTP. The application's OAuth client secret. |
| `DISCORD_OAUTH_ALLOWED_USER_IDS` | Optional comma-separated Discord user IDs. Unset or `*` allows any human; an empty value denies everyone. |
| `OAUTH_ENCRYPTION_KEY` | Required for HTTP. Stable random 32-byte base64 key for AES-256-GCM credentials. |
| `ALLOWED_HOSTS` | Comma-separated hostnames; required for non-loopback binds. |
| `ALLOWED_ORIGINS` | Optional additional browser origins. The request origin and configured public origin are accepted. |
| `DISCORD_MCP_REST_TIMEOUT_MS` | `15000`, applied to Discord requests. |
| `DATABASE_URL` | Optional Postgres URL. Turns on [bot hosting](#bot-hosting) when the allowlist names users. |
| `TOKEN_VAULT_KEY` | Required for bot hosting. Stable random 32-byte base64 key that encrypts stored bot tokens and Gateway sessions. |
| `DISCORD_TOKEN` | Stdio only. Ignored by the HTTP relay. |
| `DISCORD_MCP_TIER` | `all` runs both tiers in one process; `central` or `bot-host` runs one. See [Tiers](#tiers). |
| `BOT_HOSTS` | Split tiers only. Comma-separated base URL of every bot host. |
| `BOT_HOST_URL` | Bot hosts only. This host's URL, exactly as `BOT_HOSTS` lists it. |
| `BOT_HOST_SECRET` | Split tiers only. Shared random secret, at least 32 characters, that bot hosts require from central. |

`/health/live` and `/health/ready` return HTTP 200 when the process is serving.
They do not check Discord. `/mcp` returns 401 for missing, invalid, expired, or
revoked OAuth credentials. An unlisted human receives 403 `access_denied`;
invalid bot credentials receive 403 `invalid_bot_token`. Neither triggers another login.
Discord authentication rate limits return 429.

OAuth discovery lives at `/.well-known/oauth-protected-resource/mcp` and
`/.well-known/oauth-authorization-server`. The issuer supports dynamic public-client
registration at `/register`, authorization at `/authorize`, and code and refresh
exchange at `/token`. Both OAuth legs require S256 PKCE. The issuer validates exact redirects,
resource, issuer, browser state, and one-time codes. Registrations expire after
30 days. Client ID metadata documents are not implemented.

### Bot hosting

Bot hosting keeps agents' bots online. An agent's first call for a bot stores its token,
encrypted, in Postgres and connects the bot to Discord's Gateway with an online presence.
Each later call restarts a 24-hour timer; when it runs out, the bot disconnects and shows
offline, unless it has enabled [workflows](#workflows). Startup applies pending database
migrations and brings every bot with enabled workflows online.

A bot runs as many shards as Discord recommends, all in one process. Shards identify as fast
as Discord's `max_concurrency` allows, and spend at most half the Identifies Discord says the
bot has left today, leaving the rest for the bot's other clients. When Discord says the bot
needs more shards, it goes offline until the next agent call, which brings it back with
Discord's new count.

A restart keeps bots online. Each shard's Gateway session is stored encrypted alongside the
bot's token, and the next process resumes it, so Discord replays the events sent while the
server was down. If Discord no longer accepts a session, that shard connects afresh. A resumed
bot keeps its shard count and gets a new 24-hour timer.

Set `DATABASE_URL`, `TOKEN_VAULT_KEY` (generate it like `OAUTH_ENCRYPTION_KEY`), and a
`DISCORD_OAUTH_ALLOWED_USER_IDS` list. Without that list, the server logs a warning and
serves the plain relay. `DATABASE_URL` must reach the Postgres primary directly, with no
pooler such as PgBouncer in between: each bot's schedules fire only on the process holding
its session advisory lock, on a connection that sets its own TCP keepalives. Back up the
vault key apart from the database: without it, stored tokens cannot be decrypted.
Publishing a workflow with dependencies runs `npm` from `PATH` and needs HTTPS access to
`registry.npmjs.org`.

#### Voice

With bot hosting on, an agent can play audio in a voice channel, as music bots do, and hear
each person speaking. Discord encrypts the audio end to end with DAVE. Sending needs no notice to
the channel; receiving always posts one first.

1. Call `discord_voice_join` with `guildId` and `channelId`, and `receive: true` to hear the
   channel. The bot needs View Channel, Connect, and Speak. It returns the voice socket's path,
   `/voice?guild_id=…`, and whether it is `receiving`.
2. Open a WebSocket to that path on the relay's host (`wss:` for `https:`) with the same
   `Authorization` and `X-Discord-Bot-Token` headers as `/mcp`, adding the codec to the query:
   - `codec=opus`: each binary message is one Opus packet of 20 ms, 48 kHz stereo audio.
   - `codec=pcm16&sample_rate=R&channels=C`: little-endian 16-bit PCM, interleaved when stereo,
     at `R` of 8000, 12000, 16000, 24000, or 48000 Hz and `C` of 1 (default) or 2. Messages may
     split frames but not samples.
3. Send audio as binary messages. The bot speaks while audio arrives and stops when it pauses for
   more than 100 ms. Audio sent faster than real time waits: once a second of it is queued, the
   bot host stops reading the socket until it plays.

##### Receiving

With `receive: true`, the bot joins deafened and posts a notice in the voice channel's chat, which
needs Send Messages there. Its buttons let anyone opt out: **Opt out here** of this bot in this
server, or **Opt out of all Textile bots** of every bot Textile hosts. Each reply is visible only to the person who clicked, and offers an undo. Once
the notice is up the bot undeafens, and the socket sends:

- A binary message per packet: the speaker's user ID as 8 bytes, big-endian, then one packet in
  the socket's codec. `pcm16` decodes each speaker separately.
- JSON text events: `{"type":"join","user_id":"…"}` and `{"type":"leave","user_id":"…"}` as
  people come and go, and `{"type":"speaking","user_id":"…","speaking":true}` (or `false`).

When the notice can't be posted, `receiving` is false, `reason` says why, and the session only
sends audio. The same happens when the bot's application has an Interactions Endpoint URL, since
Discord would send the buttons' clicks there instead of to Textile. Joining the same channel again switches receiving on or off. If the bot is moved to
another channel, it stops receiving until it joins with `receive: true` there.

People who opted out never appear: their audio is dropped before it is decrypted. Opt-outs and
undos apply at once on every bot host, which Postgres notifies of each one. While a bot host's
notification connection is down, it relays nobody, and it checks everyone again once it reconnects.
Opt-outs are stored as user IDs only, with the bot and server for a per-bot opt-out. The buttons
answer while the bot is online.

Discord neither documents nor supports bots receiving voice, so receiving is best-effort and may
break without notice. A speaker is heard only once Discord names their audio stream, so their
first packets may be dropped. Packets carry no sequence numbers, so the agent can't detect loss or
reordering. Audio a slow agent hasn't read past about 1 MiB is dropped.

Before upgrading, the relay answers 401 or 403 for bad credentials, 400 for a bad query, and
409 when the bot is not in a voice channel in that server. The socket closes with:

| Code | Meaning |
| --- | --- |
| 1000 | The bot left the channel, through `discord_voice_leave` or because Discord disconnected it. |
| 1001 | The bot went offline, or the server is shutting down. |
| 1003 | A text message arrived; send audio as binary messages. |
| 1007 | A message was not valid audio for the codec. |
| 1009 | A message was larger than 256 KiB. |
| 4000 | A newer socket for the same server replaced this one. |

Closing the socket stops playback after any queued audio; the bot stays in the channel until it
leaves. Joining another channel in the same server moves the bot and closes its socket. An open
socket keeps the bot online past its 24-hour idle timeout. Voice outlasts a resumed Gateway
connection, but not a new Gateway session or a server restart: join again after a 1001 close.

### Tiers

The relay runs as one process by default. To scale, split it into two tiers, each with
as many replicas as it needs:

- **Central** serves MCP, OAuth, and workflow routes. It checks the login and the allowlist,
  reads the bot ID from the first segment of the bot token, and forwards the request to the
  bot host that owns that bot. It relays each [voice socket](#voice) to that bot host the same
  way. A workflow route names its bot in its path and is forwarded without a login. Central
  holds no bot tokens and calls Discord only to check logins.
- **Bot hosts** check each bot token with Discord and run its requests. All requests for one
  bot share one rate limiter, whichever central replica received them. `DATABASE_URL` and
  `TOKEN_VAULT_KEY` go on bot hosts, and scripts and workflows run there, sharing the bot's
  rate limiter. A bot host starts bot hosting and offers `discord_script_run` and the workflow
  tools by the same `DISCORD_OAUTH_ALLOWED_USER_IDS` rules as the single process. Central
  enforces that allowlist and tells the bot host which human made each request, for the
  workflow change log.

Give both tiers the same `BOT_HOSTS` and `BOT_HOST_SECRET`. Ownership comes from rendezvous
hashing over `BOT_HOSTS`, so every replica agrees on it, and adding or removing a host moves
only the bots that host gains or loses. A host answers 503 with `Retry-After: 1` for a bot
its list says it does not own, so a central still on an old list costs a retry, not a second
owner. Two hosts on different lists can both own a bot that moved, each with its own rate
limiter, so change `BOT_HOSTS` by stopping every bot host and then starting them all on the new
list. Centrals can update in any order. Each bot host resumes the stored sessions of the bots
it owns when it starts, and brings its bots with enabled workflows online, so a bot that moved
comes back online on its new host. Keep bot hosts off the public network: the hop from central is plain HTTP and
carries bot tokens.

Logins, refreshes, and MCP requests all work on any central replica, so no sticky routing is
needed.

For agent-operated clients, use the [curl example](./docs/operating.md#curl).
For a developer-Team-derived access list, follow
[the explicit membership sync procedure](./docs/operating.md#developer-team-allowlist).

Public routing lives in `mia-cx/yggdrasil-spec`. Consult
[DIRECTION.md](./DIRECTION.md) for the live deployment and migration state.

## Development

```sh
corepack pnpm check        # Formatting, TypeScript build, and ordinary tests
corepack pnpm spec:check   # Catalog coverage, classification, permissions, and determinism
```

After changing `packages/storage/src/schema.ts`, generate a migration with
`corepack pnpm --filter @discord-mcp/storage generate` and commit it.

Integration tests cover browser/CLI login, credential bindings, code and refresh replay,
concurrent bridge refreshes,
OAuth revocation and expiry, concurrent bot isolation, reads, writes, rate limits, and
routing across central and bot-host processes.

## Earlier implementation

The repository began on 25 July 2026. MCP removed protocol sessions and the
initialization handshake in its [28 July 2026 revision](https://modelcontextprotocol.io/specification/2026-07-28/changelog).
Stateless HTTP was already possible before that revision.

[PLAN.md](./PLAN.md) describes the earlier stateful control-plane design.
Its libraries and tests remain in the workspace, but the server executable no
longer starts that application. Persistent templates/blueprints and PAT/OIDC
administration are outside the relay. Its Docker sandbox supervisor has been
removed; [workflows](#workflows) now run in workerd.

## License

Copyright © 2026 Mia and the discord-mcp contributors.
Licensed under the [MCX License v1.0](./LICENSE).
Third-party code and specifications retain their original licenses.
