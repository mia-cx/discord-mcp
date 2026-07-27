# Discord permissions and Gateway intents

Discord enforces guild permissions, channel overwrites, role hierarchy, application authorization,
and Gateway intents after `discord-mcp` has applied local scopes and grants. A local authorization
success therefore does not guarantee Discord will accept the request.

## Install the application

Invite the application with:

- `bot`;
- `applications.commands` when workflows publish commands.

Grant only what deployed features need. Avoid `Administrator` as a shortcut; it removes useful
boundaries and makes permission failures harder to reproduce.

## Common bot permissions

| Feature | Typical Discord permissions |
| --- | --- |
| Read guild/channel state | View Channels, Read Message History |
| Send messages | View Channels, Send Messages |
| Rich messages/files | Embed Links, Attach Files |
| Edit/delete others' messages | Manage Messages |
| Reactions | Add Reactions; Read Message History where applicable |
| Create/manage threads | Create Public Threads, Create Private Threads, Send Messages in Threads, Manage Threads |
| Channels and overwrites | Manage Channels |
| Roles and member role assignments | Manage Roles |
| Kick/ban/timeout | Kick Members, Ban Members, Moderate Members |
| Guild configuration and AutoMod | Manage Guild and feature-specific permissions |
| Audit log | View Audit Log |
| Scheduled events | Manage Events |
| Expressions | Manage Guild Expressions where required |

Discord may rename or split permissions over time; use the pinned operation description and Discord's
current Developer Portal/client UI when granting them.

## Channel overwrites

Effective channel permission is computed from guild roles and the channel/category overwrite chain.
A bot can have a guild-level bit and still be denied in one channel.

When one target fails:

1. confirm the bot can view the channel;
2. inspect the category overwrite;
3. inspect `@everyone`, bot-role, other-role, and member-specific overwrites;
4. confirm a deny does not override the intended allow;
5. re-run `discord_permissions_explain` with the exact channel.

Do not broaden the bot's guild role before checking the target overwrite.

## Role hierarchy

Role hierarchy is separate from permission bits. Even with Manage Roles:

- the bot can manage only roles strictly below its highest role;
- it cannot move a role above its own highest role;
- it cannot grant permission bits it does not possess;
- member moderation can fail when the target's highest role is at or above the bot's.

Blueprint planning and curated role tools perform local prechecks where the required state is
available. Keep logical managed roles below the bot and leave integration-managed roles alone.

## Permission explanations

`discord_permissions_explain` performs a local ordered diagnosis for a planned operation or a Discord
403. It can identify:

- required local scope;
- likely guild permission bit;
- channel overwrite denial;
- role hierarchy conflict;
- missing privileged intent;
- credential-mode mismatch;
- remediation order.

Call it after the first 403 rather than trying argument variants. Repeated invalid requests count
toward RateGuard.

## Gateway intents

`DISCORD_MCP_GATEWAY_INTENTS` accepts comma-separated `GatewayIntentBits` names. `Guilds` is the safe
baseline:

```dotenv
DISCORD_MCP_GATEWAY_MODE=lazy
DISCORD_MCP_GATEWAY_INTENTS=Guilds
```

Add only the intents required by enabled event filters. In lazy mode, the Gateway connects on demand;
in eager mode it connects at startup; off disables event waits and workflow Gateway triggers.

Privileged intents require approval in two places:

| Intent | Developer Portal switch | Common need |
| --- | --- | --- |
| `GuildMembers` | Server Members Intent | member add/update/remove and complete member data |
| `GuildPresences` | Presence Intent | presence updates |
| `MessageContent` | Message Content Intent | message content, embeds, attachments, and components in many contexts |

Enable the switch under Developer Portal → Bot before adding the name to the environment.

Gateway close code 4014 normally means a configured privileged intent was not enabled for the
application. Close code 4013 means the intent bitset is invalid.

## Message Content behavior

The Message Content privileged intent affects more than Gateway events. Discord can return message
objects while blanking content-bearing fields when the application is not entitled to them.
`discord_message_list` recognizes the common pattern—non-empty messages whose content, embeds,
attachments, and components are empty—and adds a diagnostic warning.

Do not treat redacted fields as proof that the channel contains empty messages.

## Application commands

The application can manage its own commands when installed with `applications.commands`. Command
publication can still fail because of invalid definitions, global/guild grant policy, application ID
configuration, or propagation timing. Guild commands are recommended during development because they
propagate faster.

## RateGuard

RateGuard counts repeated invalid responses by credential profile and operation family. Its default
threshold is 25 in ten minutes, intentionally below Discord's invalid-request ban threshold. Once
tripped, outbound calls are stopped.

Fix the permission, hierarchy, credential, intent, or arguments before resuming. Clearing/restarting
without correcting the cause simply recreates the unsafe retry pattern.
