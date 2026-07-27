# Discord Gateway and interactions

The Gateway provides real-time Discord events and outbound presence or voice-state control.
Interactions provide authenticated inbound commands, components, modals, and autocomplete over HTTP.
They share workflow ownership and causality, but they are different Discord transports.

## Gateway lifecycle

Configure:

```dotenv
DISCORD_MCP_GATEWAY_MODE=lazy
DISCORD_MCP_GATEWAY_INTENTS=Guilds
```

Modes:

| Mode | Behavior |
| --- | --- |
| `off` | No Gateway connection. Gateway tools and triggers are unavailable. |
| `lazy` | Connect on the first Gateway-dependent tool or enabled trigger. This is the default. |
| `eager` | Connect during server startup; startup fails if the initial connection cannot be established. |

Concurrent requests share one connection attempt. A failed attempt resets the connection state so a
later call can retry when the error is retryable.

Inspect with `discord_gateway_status`. Do not loop on a failed connection without reading the close
code:

- 4004 — invalid bot token; rotate or correct `DISCORD_TOKEN`;
- 4013 — invalid intent bit or name;
- 4014 — a privileged intent is configured but not enabled in the Developer Portal.

## Intents

`DISCORD_MCP_GATEWAY_INTENTS` accepts comma-separated `GatewayIntentBits` names. `Guilds` is the safe
baseline. Typical event requirements:

| Event family | Intent |
| --- | --- |
| Guild/channel/thread lifecycle | `Guilds` |
| Member add/remove/update | `GuildMembers` |
| Presence update | `GuildPresences` |
| Guild messages | `GuildMessages` |
| Message content fields | `MessageContent` |
| Reactions | `GuildMessageReactions` |
| Voice states | `GuildVoiceStates` |
| Scheduled events | `GuildScheduledEvents` |
| AutoMod rules/actions | `AutoModerationConfiguration`, `AutoModerationExecution` |

`GuildMembers`, `GuildPresences`, and `MessageContent` are privileged. Enable them under Developer
Portal → Bot before adding them to the environment. Workflow publication checks that its requested
Gateway event types are possible with the configured intents.

`MESSAGE_CONTENT` also affects REST reads. Discord may return a message object with empty
content-bearing fields when the intent is absent. `discord_message_list` detects the common
redaction shape and adds a warning.

## Durable events

Gateway dispatches are normalized into:

```json
{
  "sequence": 42,
  "eventType": "MESSAGE_CREATE",
  "payload": {},
  "correlationId": "uuid",
  "causalDepth": 0,
  "receivedAt": "2026-07-27T12:00:00.000Z"
}
```

An event may also include `discordEventId` and `causationId`.

The SQLite sequence is the durable ordering key. Entity IDs such as message IDs are not event IDs
and are never used for generic deduplication. The store retains a bounded recent window and exposes
opaque base64url cursors.

Use:

- `discord_gateway_recent_events` to drain events after a cursor;
- `discord_gateway_wait_for_event` for a bounded long poll.

Wait subscribes before reading persistence, closing the race where an event arrives between “perform
an action” and “begin waiting.” Limits are bounded to 200 events per read and
`DISCORD_MCP_GATEWAY_MAX_WAIT_MS` per wait.

When a workflow Discord action creates an entity and a matching Gateway event arrives, the control
plane carries forward the root correlation ID, records the workflow execution as causation, and
increments causal depth. The broker uses that lineage to prevent infinite event-action loops.

## Workflow Gateway triggers

A workflow trigger declares event types:

```ts
Trigger.gateway({
  eventTypes: ['MESSAGE_CREATE', 'GUILD_MEMBER_ADD'],
  handler: (event) => {
    // ...
  },
})
```

The approved grant must separately allow those event types. By default, bot-authored events are
filtered to reduce loops. Set `includeBotAuthoredEvents: true` only when the workflow also has a safe
causal design.

## Presence and voice state

`discord_presence_set` sends Gateway opcode 3 and requires `bot:admin`. It supports status,
activities, AFK, and `since`.

`discord_voice_state_set` sends Gateway opcode 4 and requires `bot:admin`. It can join, move, mute,
deafen, or leave by setting the channel ID to null.

These tools control Gateway state only. Voice media capture, playback, and transcoding are outside
the product.

## Interaction endpoint

Set:

```dotenv
DISCORD_PUBLIC_KEY=...
```

Then configure:

```text
https://your-host.example/discord/interactions
```

For every request the server:

1. caps the raw body at 1 MiB;
2. checks timestamp freshness within five minutes;
3. verifies Ed25519 over `timestamp + exact raw body`;
4. parses JSON only after signature verification;
5. answers Discord PING immediately;
6. deduplicates by interaction ID for 24 hours.

Changing any body byte invalidates the signature. The interaction token is removed before the event
is passed to workflow code.

## Commands

Workflow command triggers may be:

- chat-input commands with description and options;
- user context commands;
- message context commands;
- guild commands;
- global commands.

Guild command publication requires `guildCommandPublishing` in the revision grant. Global command
publication requires the stronger `globalCommandPublishing`. Development guilds may be named in
`DISCORD_MCP_DEVELOPMENT_GUILDS`.

The control plane records the Discord command ID and owning workflow revision. An inbound command is
accepted only when that ID belongs to the currently enabled revision. Disable, rollback, and delete
remove or replace registrations as part of lifecycle management.

## Components and modals

Semantic presentations use logical actions. The encoder stores an opaque custom-ID handle that binds:

- owner type and ID;
- workflow revision when applicable;
- action type;
- action key;
- optional expiry.

An unknown, expired, disabled-revision, or mismatched handle is rejected. A caller cannot forge a
workflow route by choosing a custom ID.

`workflow` actions invoke the matching `interactionComponent` or `interactionModal` trigger.
`event` actions enter the durable component inbox and return a Discord update acknowledgement.

## Autocomplete

Autocomplete triggers return:

```ts
Discord.respondToAutocomplete([
  { name: 'Production', value: 'production' },
  { name: 'Staging', value: 'staging' },
])
```

The response is limited to 25 choices and validated by the control plane. Autocomplete is not
deferred; if it misses the deadline, Discord receives an empty choice list.

## Deadlines and deferred completion

The interaction handler waits up to 2.5 seconds for a workflow result.

- If a valid result arrives, it is returned immediately.
- If an ordinary interaction is still running, the server returns a deferred callback and later
  edits the original interaction response.
- If the workflow fails immediately, the user receives a safe ephemeral failure response.
- If deferred work later fails, the original response is completed with a non-ephemeral failure.

Workflow callbacks must use SDK-authored responses. Raw Discord callback objects cannot bypass the
shared presentation encoder, Components V2 restrictions, or action ownership checks.

## Troubleshooting

- **401 invalid signature** — verify the public key, HTTPS body preservation, and system clock.
- **401 stale timestamp** — fix clock skew at the reverse proxy or host.
- **unknown component handle** — the message predates the database, the binding expired, or the
  wrong installation received the callback.
- **revision no longer enabled** — edit or replace messages from the new revision.
- **commands not found** — check application ID, publication grant, installation scope, and guild
  registration.
- **interaction timed out** — inspect workflow duration, queue depth, runner health, and deferral
  metrics.
