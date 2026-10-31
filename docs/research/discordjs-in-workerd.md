# Which parts of discord.js run in workerd isolates

Answers [#16](https://github.com/mia-cx/discord-mcp/issues/16) for PRD [#15](https://github.com/mia-cx/discord-mcp/issues/15). Researched 2026-10-31 by `claude-sonnet-5.5`.

## Answer

Almost all of it runs unmodified. In a probe workerd, `discord.js@14.28.0` imported, built a `Client` at module top level (with two options changed), took a forwarded `MESSAGE_CREATE`, and `message.reply('pong')` reached a broker service as a plain `POST /channels/{id}/messages`. Slash-command replies (`deferReply`, `editReply`, `followUp`) did too. The adapter is about 40 lines. It is a subclass of `Client` that:

- switches off sweep timers,
- stubs `login()`,
- tracks listener promises,
- seeds a stub guild, channel and bot user before each dispatch.

Four things do not work as-is:

- **Gateway-sending calls.** `guild.members.fetch({query})`, `setPresence` and voice need a shard and cannot run in an isolate.
- **URL attachments.** `send({files: ['https://…']})` fails.
- **Event delivery.** Delivery needs a cache seed (below), because discord.js drops a guild-channel `messageCreate` that it has no channel for.
- **Dead weight.** `undici` and the `ws` stub add about 800 KB to the bundle.

Everything else is a package-level fact in the matrix.

## Method

- **Machine and tools.** Node v24.19.0, npm 11.17.0, wrangler 4.156.0, workerd `1.20261023.1` (the build wrangler's Miniflare uses) and `1.20261031.1` (top-level binary). All probes ran in a scratch dir outside the repo (`~/scratch/djs-workerd`) with `compatibility_date = "2026-10-01"` and the `nodejs_compat` flag. Per the docs, that date makes the flag redundant; see the matrix footnotes.
- **Packages.** `discord.js@14.28.0`, `@discordjs/rest@2.6.3`, `@discordjs/builders@1.15.0`, `@discordjs/collection@2.1.1`, `@discordjs/formatters@0.6.2`, `discord-api-types@0.38.57`.
- **Two build routes.**
  - **wrangler.** `wrangler deploy <entry> --dry-run --outdir out/<name> --compatibility-date 2026-10-01 --compatibility-flags nodejs_compat`.
  - **Plain esbuild**, no wrangler or unenv: conditions `workerd,worker,browser,import`, main fields `browser,module,main`, every Node builtin external, plus a `createRequire` banner. This is the route a workflow publisher would own.
- **Serving.** A hand-written capnp config passed to `workerd serve`. Egress tests (probe `pn`, harness `run2.mjs`) gave the main worker `globalOutbound = "broker"` (a second worker) and listened on `127.0.0.1:19999` to catch a leaked socket.
- **Probes.** `pc` (collection), `pt` (api-types), `pf` (formatters), `pb` (builders), `pr` (rest), `pd1` (import and construct), `pd2` and `pd3` (events, caches, interactions, login, URL attachment), `pg` (Gateway-sending calls), `pn` (egress), and the adapter prototype (appendix).
- **Reproducing.** The probe sources are not committed. The key one, the adapter, is in the appendix; the rest are small `fetch` handlers that exercise one API.
- **Fakes.** Discord payloads were hand-written. No bot token and no Discord endpoint were used, except one `GET /gateway` that probe `pr` sent by accident (see finding 4).

## Verified findings

### workerd's Node support

1. With `nodejs_compat`, these are native: `events`, `util`, `buffer`, `process`, `timers`, `path`, `url`, `zlib`, `http`, `https`, `net`, `fs`, `stream`, `crypto`, `async_hooks`. `tls`, `dns`, `os`, `perf_hooks` and `module` are partial. [Cloudflare docs, Node.js compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/) ([source](https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/docs/workers/runtime-apis/nodejs/index.mdx))
2. `worker_threads`, `child_process`, `tty`, `readline`, `v8` and others are import-only stubs: "A stub can be imported or required, but does not provide a working implementation". They auto-enable with `nodejs_compat` from compatibility date 2026-03-17 (older dates: wrangler/unenv polyfills). Same page.
3. On or after 2026-08-04, `nodejs_compat` is on by default. Same page. A bundle at `2026-10-01` with no flags ran fine. The same bundle at `2026-03-01` and `2025-06-01` with `nodejs_compat` also ran. At `2026-03-01` with no flag, wrangler warned that the Worker "may throw errors at runtime" and I did not run it. (`pd1`, `COMPAT_DATE` and `FLAGS` variants.)
4. With `nodejs_compat`, `process.versions.node` is `22.19.0`, so `@discordjs/rest` builds its User-Agent as `DiscordBot (https://discord.js.org, 2.6.3) Node.js/22.19.0`. (`pr`.) Probe `pr` also made one unauthenticated real `GET https://discord.com/api/v10/gateway`: its default strategy captures `fetch` at import time (`setDefaultStrategy(fetch)`, `@discordjs/rest/dist/web.mjs:1415`), so my attempt to patch `globalThis.fetch` afterwards did not take effect.

### Package matrix

| Package | Node APIs it needs | In workerd | Evidence |
|---|---|---|---|
| `discord-api-types` 0.38.57 | None. No dependencies. | Runs unmodified. | `pt`: `Routes`, enums, `PermissionFlagsBits` resolve. 220 KB bundle. |
| `@discordjs/collection` 2.1.1 | None. No dependencies. | Runs unmodified. | `pc`: `filter`, `map`, `first`, `sweep` work. 19 KB. |
| `@discordjs/formatters` 0.6.2 | None. Depends on `discord-api-types`. | Runs unmodified. | `pf`: `bold`, `userMention`, `time`, `codeBlock`, `hyperlink`. 14 KB. |
| `@discordjs/builders` 1.15.0 | None directly. Depends on `@sapphire/shapeshift`, `ts-mixer`, `fast-deep-equal`, `discord-api-types`, formatters, util. | Runs unmodified, validation included. | `pb`: `EmbedBuilder`, `SlashCommandBuilder`, `ActionRowBuilder`, `ButtonBuilder`, `ContainerBuilder`, `toJSON()`. An over-length embed title threw `CombinedError`. 557 KB (87 KB gzip). |
| `@discordjs/rest` 2.6.3 | The `web` build uses only `globalThis.fetch`, `process.emitWarning`, timers and `AbortController`. The `node` build imports `undici`, `util`, `url`, `http`, `buffer`. | The `web` build runs. | `pr`: see below. |
| `discord.js` 14.28.0 | `process`, `timers`, `events`, `util` (`deprecate`), `buffer`, `path`, `worker_threads` (`workerData` at `Client` construction), plus the rows below. Details after the table. | Imports and constructs. | `pd1`: `new Client(...)`, then `client.rest` and `client.ws` exist. 3.1 MB (580 KB gzip). |
| `discord.js` sharding code | `child_process`, `worker_threads` (`Worker`), `fs`, `path`, `timers/promises` (`ShardingManager`, `Shard`). | Imports fine and is never run. | Bundled in `pd1`; the stubs satisfy the imports. |
| `@discordjs/ws` 1.2.3 (via discord.js) | `ws`, `worker_threads`, `zlib`, `timers/promises`, `events`, `util`, `url`, `path`, `process`, `buffer`. | Imports; cannot connect. | Finding 8. |
| `undici` 6.29.1 (via discord.js) | `net`, `tls`, `http`, `stream`, `diagnostics_channel`, … | Bundles; its direct network path fails. | Finding 9. |

`@discordjs/rest`, in more detail (`pr`):
- **Build selection.** Its `package.json` exports map `node` to the `undici`-based build and everything else to `dist/web.mjs`. Bundlers using the `workerd`/`worker`/`browser` conditions get the `web` build.
- **What worked.** With a custom `makeRequest`, `rest.post(Routes.channelMessages(id), {body})`, `rest.get`, and multipart (`files: [...]`, delivered to `makeRequest` as `FormData`) all worked.
- **Errors and limits.** A 403 `{code: 50013}` mapped to `DiscordAPIError` with `code` 50013 and `status` 403. A 429 mapped to `RateLimitError` with `rejectOnRateLimit`.

`discord.js` details (rows above):
- **`worker_threads`.** `src/client/Client.js:48` does `require('node:worker_threads').workerData ?? process.env`. It works because `worker_threads` is a stub (finding 2).
- **Sweepers.** Calling `new Client(...)` or `new REST()` in global scope throws on a default `Client` (finding 5).
- **Gateway sends.** See finding 8.
- **URL attachments.** See finding 9.

### Behaviour of the discord.js client in an isolate

5. **Global-scope construction.** A workflow that does `const client = new Client(...)` at module top level (the idiomatic shape) crashes at load: "Disallowed operation called within global scope. Asynchronous I/O … setting a timeout … not allowed within global scope". Two timer sources cause it:
   - `REST#setupSweepers` calls `setInterval` for the hash and handler sweepers. Setting `rest.hashSweepInterval: 0` and `rest.handlerSweepInterval: 0` fixes this.
   - `Sweepers` calls `setInterval` for the default `threads` sweeper (`interval: 3600`, from `Options.DefaultSweeperSettings`). Setting `sweepers.<key>.interval` to `0` fixes this. Any sweeper a workflow configures must also be zeroed.

   (Adapter prototype; `util/Sweepers.js:478`, `Options.js:209`, `@discordjs/rest/dist/web.mjs:1141`.) The error text is workerd's [handlers documentation](https://developers.cloudflare.com/workers/runtime-apis/handlers/) rule. Calls made inside a handler are fine; `pd1`–`pd3` constructed clients inside `fetch`.
6. **Events without a cache are dropped silently.** With no guild or channel cache, `handlePacket({t:'MESSAGE_CREATE'})` emits nothing and sends nothing, with and without `partials: [Partials.Channel, Partials.Message]`. `MessageCreateAction` returns `{}` when `getChannel` finds nothing, and `Partials.Channel` only covers DMs. (`pd2` scenarios 1–2; `client/actions/MessageCreate.js`, `Action.js#getChannel`.) Three seeds worked in `pd2` and `pd3`, with `message.reply` and `react` as REST calls:
   - a full `GUILD_CREATE` packet;
   - a stub guild plus one channel: `client.guilds._add({id, unavailable: true})`, then `client.channels._add(channel, guild)`;
   - for `INTERACTION_CREATE`, nothing at all (the payload carries `channel`). `interaction.channel` and `interaction.guild` were `null`, but `reply`, `deferReply`, `editReply` and `followUp` worked.
7. **Where Gateway state matters.** `client.ws.handlePacket` queues packets until `client.ws.status === Status.Ready` (`WebSocketManager.js:336`). Setting `status = 0` bypasses the queue. A message arriving while `client.user` is `null` throws on the second delivery of the same id (`existing.author?.id !== this.client.user.id`). A seeded `ClientUser` fixed it (`MessageCreate.js`).
8. **`login()` and Gateway-sending calls.**
   - **`login()`.** `login()` calls `GET /gateway/bot` through REST (which the broker would see) and then hangs in `ws.connect()` (`pd3`). `@discordjs/ws` imports `ws`, which under the `browser` condition resolves to `ws/browser.js`, which throws "ws does not work in the browser".
   - **No-ops.** `client.user.setPresence()` did not throw and sent nothing, because `ws.broadcast` has no shards.
   - **`guild.members.fetch({query})`.** It threw `TypeError: Cannot read properties of undefined (reading 'send')` (`pg`). `GuildMemberManager.js:297`, `GuildManager.js:318`, `ClientPresence.js:25-31` and `Guild.js:1471` (voice adapter) all call `shard.send`.
9. **URL attachments.** `channel.send({files: ['https://…']})` goes through `DataResolver.resolveFile` in `util/DataResolver.js:113`, which uses `undici`'s own `fetch`. In `pd3` and `pn` it failed with `TypeError: fetch failed` and sent nothing through REST. Local paths would hit workerd's virtual `fs`.
10. **`@discordjs/collection` is duplicated.** `discord.js@14.28.0` pins `@discordjs/collection` to exactly `1.5.3` (`npm ls`); a workflow that imports `@discordjs/collection` directly gets `2.1.1`. The two `Collection` classes differ in `instanceof`. Also `discord.js` depends on `@discordjs/ws@^1.2.3`, while this repo's host-side gateway uses `@discordjs/ws` 2.0.4 (`PLAN.md`); only the host runs it.
11. **Listener promises are not awaited.** `EventEmitter#emit` ignores listener return values. The adapter prototype collects them via wrapped `on`/`once` and awaits them before the invocation ends. Without this, the isolate would finish before `await message.reply()` ran. (Standard Node `EventEmitter` semantics, which workerd implements natively per finding 1.)
12. **Isolates keep caches across events.** In the prototype, replaying a message id returned the cached `Message` (`existing`), and a stale cache grows without bound. The prototype clears `guilds`, `channels` and `users` caches after each dispatch.
13. **Bundle size.** With wrangler: `pd1` is 3.11 MB (580 KB gzip). With plain esbuild, `undici` accounts for 96 of 605 input files and the `ws` stub for one. Aliasing `undici` to a stub exporting `fetch` (delegating to `globalThis.fetch`) and `ws` to a throwing stub gave 2.22 MB (378 KB gzip) against 3.01 MB (543 KB gzip), and `pd2` still passed. A first request to the `pd1` worker took 8 ms, then 1 ms (loopback, one machine, not a benchmark).
14. **Plain esbuild works without wrangler.** `platform: 'neutral'`, conditions `workerd,worker,browser,import`, builtins external, and a `createRequire` banner ran `pd2` in workerd with native `node:*` modules and no unenv. Without the banner, load failed with "Dynamic require of "node:events" is not supported". `zlib-sync` appears as an optional external import (from `@discordjs/ws`) and never resolves.

### Egress

15. **With `globalOutbound` set to a service, every outbound path reaches that service.** Config: `globalOutbound = "broker"` on the main worker; broker is a plain worker. Probe `pn`, harness `run2.mjs`:
    - global `fetch('https://discord.com/…')` reached the broker;
    - `node:http` `http.get('http://example.com/')` reached the broker;
    - the default `@discordjs/rest` strategy (no `makeRequest`) reached the broker as `GET https://discord.com/api/v10/gateway`;
    - `node:net` `connect` to `127.0.0.1:19999` did not reach the local listener (0 sockets leaked) and failed with "proxy request failed, cannot connect to the specified address"; workerd logged "Handler does not export a connect() function" for the broker.

    Source: [`workerd.capnp`](https://github.com/cloudflare/workerd/blob/main/src/workerd/server/workerd.capnp) — `globalOutbound`: "Where should the global 'fetch' go to?"; `Network`: "To prevent SSRF, by default Workers will not be permitted to reach internal network addresses using global fetch()". My result extends that to `node:http` and `node:net`; the `capnp` comment names only fetch.
16. **Adapter prototype (appendix).** Unmodified workflow source, plus an alias of `discord.js` to the shim, produced these broker requests (`run3.mjs`):
    - `MESSAGE_CREATE` "ping": `POST https://discord.com/api/v10/channels/2000000000000000001/messages`, `authorization: Bot broker`, body `{"content":"pong","message_reference":{"message_id":…,"fail_if_not_exists":true}}`. 5–7 ms.
    - `MESSAGE_CREATE` "ignore me": no broker request.
    - `INTERACTION_CREATE` `/hello`: `POST /interactions/{id}/{token}/callback?with_response=false` and `PATCH /webhooks/{app}/{token}/messages/@original`, both with no `authorization` header.

## Recommended adapter design

Make the broker the isolate's `globalOutbound` service, and ship a small `discord.js` shim.

### What runs unmodified

- `discord-api-types`, `@discordjs/collection`, `@discordjs/formatters`, `@discordjs/builders`, `@discordjs/util`: bundled as they are.
- `@discordjs/rest` (`web` build, via bundler conditions) with its default strategy, which already uses global `fetch`.
- All of `discord.js`'s structures, managers, `MessagePayload`, interactions, collectors and permission math (probes `pd2`, `pd3`).

### What is shimmed (the ~40 lines in the appendix)

- **`Client` subclass.** Applied via a bundler alias of `discord.js` at publish time.
  - Zeroes sweeper intervals (finding 5).
  - Sets a placeholder token and `ws.status = 0`.
  - Replaces `login()` with a no-op.
  - Wraps `on`/`once` to await listener promises (finding 11).
- **`dispatch({t, d, ctx})`.** Seeds a stub guild, one channel and the bot user from `ctx`, calls `client.ws.handlePacket`, awaits handlers, then clears caches (findings 6, 7, 12).
- **Build-time aliases.** `undici` to a `fetch` stub that delegates to `globalThis.fetch`, and `ws` to a throwing stub (finding 13). URL attachments then go through the broker too.
- **Compatibility.** `nodejs_compat` on, or date 2026-08-04 or later.

### What is rewritten or unsupported

- **Gateway-sending calls.** `guild.members.fetch({query})`, `setPresence`, soundboard requests, voice adapters. They need a bot-host RPC: give the shim a fake `client.ws.shards` whose `send(payload)` calls the broker (e.g. a `gateway.send` capability, not a catalog operation). Until then they fail or no-op; `publish` should reject or warn.
- **`Client#login`, sharding, `ShardingManager`.** No-ops or unsupported by design.
- **Collectors, `awaitMessages`, `awaitMessageComponent`.** They need state across events, which per-event cache clearing discards (inference; see below).

### How `client.on(...)` and `message.reply(...)` map

```
bot host (shard) ──MESSAGE_CREATE──▶ dispatcher ──{t,d,ctx}──▶ runner: isolate.fetch
                                                                 │
   client.on('messageCreate', h)  ◀── handlePacket(MESSAGE_CREATE) ─ shim.dispatch
   message.reply('pong')  ──▶ channel.send ─▶ rest.post ─▶ fetch(POST /channels/…/messages)
                                                                 │ globalOutbound
                                                                 ▼
                                          broker service on the bot host (token, grants, rate limiter)
```

1. The bot host forwards a Gateway dispatch as `{t, d, ctx}`. `ctx` holds the guild stub, the event's channel object and the bot user. The host already holds that state.
2. The isolate's `fetch` calls `shim.dispatch`. discord.js builds a `Message` and emits `messageCreate`. Handler code is the agent's, unchanged.
3. `message.reply` produces a normal Discord REST request on `fetch`. `globalOutbound` delivers it to the broker unchanged: method, URL, headers, body (multipart as `FormData`).
4. The broker resolves `(method, path)` to a catalog operation by path template (the catalog stores `path` and `operationId`: `packages/discord-catalog/src/types.ts:58-61`), checks the revision's grants, swaps the placeholder token for the real one, runs the call through the bot's rate limiter, and returns Discord's response bytes. discord.js parses them as usual.
5. Interaction callbacks (`/interactions/{id}/{token}/callback`, `/webhooks/{app}/{token}/…`) carry no bot authorization. The broker should accept them only for the interaction the current event delivered.
6. Plain `fetch` to outside hosts reaches the same broker, which applies the declared-host grants and blocks private ranges (finding 15). One service covers PRD stories 13, 14, 17 and 24.

## Inferences and open risks (not verified)

- **Route matching.** Mapping every REST path to a catalog `operationId` needs a router over `path` templates and a per-method check. I did not read the catalog or `grants.ts` far enough to say how many discord.js calls fall outside it (including `/webhooks/…` and `/interactions/…`).
- **Rate-limit behaviour.** `@discordjs/rest` keeps its own bucket queue inside each isolate. With the broker as the authority, the broker should absorb waits and avoid returning 429s, and the shim could set `retries: 0`. Neither was exercised.
- **Cache seeding.** One stub guild and channel is enough for `messageCreate`, `reply`, `react`. Events touching members, roles, permissions (`message.member`, `guild.roles`) or threads will need more fields in `ctx` or an on-demand broker fetch. I tested `message`/`interaction` only. The sizing of `ctx` per event type is open.
- **Collectors.** Collectors, `awaitMessages` and anything that keeps listeners alive past the invocation assumes one long-lived `Client`. Whether to keep isolates warm per workflow, or to model them as separate triggers, is a PRD decision.
- **Listener errors.** `Promise.allSettled` in the prototype swallows rejections; the real shim should report them to the workflow log. `client.off(name, fn)` will not find the wrapped function; the real shim needs a `WeakMap`.
- **Version drift.** `discord.js` pins old copies of `@discordjs/collection` and `@discordjs/ws` (finding 10), and the unstable parts here (`handlePacket`, `guilds._add`, `channels._add`, `ClientUser`) are internal APIs. Pin one `discord.js` version per runner image and test the shim against each bump.
- **Node 22 identity.** `process.versions.node` reports `22.19.0` under `nodejs_compat`, which leaks into the REST User-Agent. The broker overwrites the header anyway.
- **PLAN.md.** `PLAN.md` ("Do not use the assembled `discord.js` package") describes the historical design, as `DIRECTION.md` says. This research does not change that: the host side keeps `@discordjs/rest`, `@discordjs/ws` and `discord-api-types`.

## Likely PRD changes

- The "discord.js adapter" module is a small shim plus an alias, not a port or rewrite.
- The broker takes raw Discord REST over `globalOutbound`. It needs a route-to-operation matcher, and it can be the single egress service.
- The adapter needs a `ctx` seed in each forwarded event, and Gateway-sending APIs need a host RPC.
- The publisher can bundle with plain esbuild, no wrangler needed.

## Appendix: adapter prototype

Workflow code, as an agent writes it:

```js
import { Client, Events, GatewayIntentBits } from 'discord.js'
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] })
client.on(Events.MessageCreate, async message => {
  if (message.content === 'ping') await message.reply('pong')
})
client.on(Events.InteractionCreate, async i => {
  if (i.isChatInputCommand() && i.commandName === 'hello') { await i.deferReply(); await i.editReply(`hello ${i.options.getString('who')}`) }
})
client.login(process.env.TOKEN)
```

Shim, bundled in place of `discord.js` (`alias: { "discord.js": "./shim.mjs", "discord.js-real": "<path>/node_modules/discord.js/src/index.js" }`):

```js
import * as real from 'discord.js-real'
export * from 'discord.js-real'

const pending = []           // promises returned by user listeners, awaited per invocation
export const clients = new Set()
const track = fn => function (...a) { const r = fn.apply(this, a); if (r && typeof r.then === 'function') pending.push(r); return r }

export class Client extends real.Client {
  constructor(options) {
    // workerd forbids setInterval in global scope, and the host owns rate limits anyway.
    const sweepers = Object.fromEntries(Object.entries({ threads: { lifetime: 0 }, ...options?.sweepers }).map(([k, v]) => [k, { lifetime: 0, ...v, interval: 0 }]))
    super({ ...options, sweepers, rest: { ...options?.rest, hashSweepInterval: 0, handlerSweepInterval: 0 } })
    this.token = 'broker'             // placeholder; the broker holds the real token
    this.rest.setToken('broker')
    this.ws.status = 0                // Status.Ready: skip discord.js' before-ready packet queue
    clients.add(this)
  }
  async login() { return 'broker' }   // never opens a Gateway
  on(name, fn) { return super.on(name, track(fn)) }
  once(name, fn) { return super.once(name, track(fn)) }
  addListener(name, fn) { return this.on(name, fn) }
}

export async function dispatch({ t, d, ctx }) {
  for (const client of clients) {
    if (ctx?.user && !client.user) { client.user = new real.ClientUser(client, ctx.user); client.users.cache.set(client.user.id, client.user) }
    if (ctx?.guild) {
      const g = client.guilds._add({ unavailable: true, ...ctx.guild })
      if (ctx.channel) client.channels._add(ctx.channel, g)
    }
    client.ws.handlePacket({ t, d }, { id: 0 })
  }
  let n
  do { n = pending.length; await Promise.allSettled(pending.splice(0)) } while (pending.length)
  for (const c of clients) { c.guilds.cache.clear(); c.channels.cache.clear(); c.users.cache.clear() }
}
```

Worker entry (`dispatch` is the shim's extra export):

```js
import './workflow.mjs'
import { dispatch } from 'discord.js'
export default { async fetch(req) { await dispatch(await req.json()); return new Response('ok') } }
```

The broker in the prototype logs each request it receives and answers with canned Discord payloads (`204` for `/callback`). The main worker's capnp service sets `globalOutbound = "broker"`.
