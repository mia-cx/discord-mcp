# Server blueprints

Server blueprints declaratively reconcile a Discord guild. They manage state by logical keys instead
of rediscovering resources by name, produce an inspectable plan before mutation, bind approval to the
live guild state, and journal partial execution.

## What a blueprint can manage

- Guild name and moderation-related settings
- AFK, system, rules, public-updates, and safety-alert channel references
- Roles, permissions, colors, hoisting, mentionability, and order
- Categories, text, voice, stage, announcement, forum, and media channels
- Parent relationships, ordering, topics, slow mode, voice limits, forum tags, and defaults
- Role, member, and `@everyone` permission overwrites
- Welcome screen
- Community onboarding prompts, options, default channels, and role/channel assignments
- AutoMod keyword, spam, preset, mention-spam, and member-profile rules
- AutoMod block, alert, and timeout actions

It does not adopt arbitrary resources by matching names. A logical key is bound to the Discord ID
created or explicitly managed by that blueprint.

## Lifecycle

```text
create draft → update → validate → publish immutable revision
                                      ↓
capture live snapshot → plan → inspect preview → apply
```

Stored-document tools:

- `discord_server_blueprint_list`
- `discord_server_blueprint_get`
- `discord_server_blueprint_create`
- `discord_server_blueprint_update_draft`
- `discord_server_blueprint_validate`
- `discord_server_blueprint_publish`
- `discord_server_blueprint_archive`

Execution tools:

- `discord_server_snapshot`
- `discord_server_blueprint_plan`
- `discord_server_blueprint_apply`
- `discord_permissions_explain`

Planning requires `server:plan`. Apply requires `server:apply`. Applying managed deletions additionally
requires `mcp:destructive`.

## Logical keys

Role, channel, onboarding-prompt, option, forum-tag, and AutoMod keys use:

```text
^[a-z][a-z0-9_-]{0,63}$
```

References use keys:

- `parentKey` places a channel below a managed category;
- overwrite `roleKey` refers to a managed role;
- guild settings use channel keys;
- onboarding options use channel and role keys;
- AutoMod actions and exemptions use managed keys.

Use direct `roleId`, `channelId`, or `memberId` only for an external Discord resource that the
blueprint does not own.

## Example

The document passed to create or update omits the stored `id`, `revision`, and `guildId`; those are
attached by the versioned store:

```json
{
  "settings": {
    "verificationLevel": "medium",
    "defaultMessageNotifications": "onlyMentions",
    "rulesChannelKey": "rules"
  },
  "roles": [
    {
      "key": "moderator",
      "name": "Moderator",
      "permissions": ["ViewChannel", "ManageMessages", "ModerateMembers"],
      "hoist": true,
      "order": 10
    }
  ],
  "channels": [
    {
      "key": "community",
      "kind": "category",
      "name": "Community",
      "order": 1
    },
    {
      "key": "rules",
      "kind": "text",
      "name": "rules",
      "parentKey": "community",
      "order": 1,
      "overwrites": [
        {
          "target": { "type": "everyone" },
          "allow": ["ViewChannel", "ReadMessageHistory"],
          "deny": ["SendMessages"]
        }
      ]
    }
  ],
  "welcomeScreen": {
    "enabled": true,
    "description": "Start here",
    "channels": [
      {
        "channelKey": "rules",
        "description": "Read the server rules"
      }
    ]
  },
  "autoModerationRules": [
    {
      "key": "mention-spam",
      "name": "Mention spam",
      "enabled": true,
      "trigger": {
        "type": "mentionSpam",
        "mentionTotalLimit": 8,
        "mentionRaidProtectionEnabled": true
      },
      "actions": [
        {
          "type": "blockMessage",
          "customMessage": "Too many mentions"
        }
      ]
    }
  ]
}
```

Validation rejects duplicate keys, invalid references, kind-specific field mixtures, unknown
permission names, contradictory overwrites, and invalid onboarding or AutoMod structures.

## Capture and inspect

`discord_server_snapshot` reads the guild, its channels and roles, the bot member, welcome screen,
onboarding, and AutoMod rules. It also reports the bot's effective permissions. Capture may return
warnings when optional Discord features are unavailable.

Snapshots contain the state required to plan and explain permissions; they are not authoritative
approval by themselves.

## Plan

Pass the published `blueprintId`, optional revision, current snapshot, and optional
`deleteManaged`:

```json
{
  "blueprintId": "BLUEPRINT_ID",
  "revision": 2,
  "snapshot": {
    "guildId": "12345678901234567",
    "ownerId": "12345678901234568",
    "botMemberId": "12345678901234569",
    "botRoleIds": [],
    "roles": [],
    "channels": []
  },
  "deleteManaged": false
}
```

The abbreviated snapshot above shows the required envelope. In normal use, pass the complete
`snapshot` returned by `discord_server_snapshot`; do not reconstruct it manually.

The planner:

1. loads the immutable published document;
2. loads persisted logical bindings;
3. validates bot permissions and role hierarchy;
4. computes ordered create, update, overwrite, reorder, and optional delete actions;
5. returns warnings and whether the plan is destructive;
6. returns a 60-second preview token bound to the principal, guild, blueprint digest, snapshot
   digest, and action digest.

Planning never mutates Discord.

With `deleteManaged: false`, an absent key generally means “leave the existing managed resource
alone,” which protects against partial documents. Set `deleteManaged: true` only when the document is
the complete desired set and the missing managed bindings should be deleted.

## Apply and live-state binding

Apply accepts only:

```json
{
  "blueprintId": "BLUEPRINT_ID",
  "revision": 2,
  "deleteManaged": false,
  "previewToken": "TOKEN_FROM_PLAN"
}
```

It deliberately does not accept the caller's old snapshot. Immediately before applying, the server
captures Discord again, rebuilds the plan, and verifies the preview against that live state. Any
change to the guild, blueprint, bindings, deletion mode, or calculated actions invalidates the
preview.

This prevents an old snapshot from authorizing mutation of a guild that changed after review.

## Ordering and partial failure

Actions are ordered so dependencies exist before use:

1. guild settings that do not need new bindings;
2. role creation/update and role order;
3. channel creation/update, overwrites, and channel order;
4. welcome screen and onboarding;
5. AutoMod;
6. explicitly approved managed deletions.

Each action is recorded in a durable execution journal. Apply returns an execution ID and completed,
pending, and failed actions. On a transient or permission failure:

1. stop and correct the Discord condition;
2. capture and plan again;
3. confirm the exact digests still match;
4. call apply with `resumeExecutionId`.

Already completed actions are not repeated. If state no longer matches, start a new execution rather
than editing the journal.

## Permissions and hierarchy

Discord permission bits and role hierarchy are separate:

- the bot can manage only roles strictly below its highest role;
- it cannot grant a permission it does not hold;
- a member at or above the bot cannot be moderated;
- channel overwrites may remove an otherwise present guild permission.

`discord_permissions_explain` computes the effective named permissions and shows the contribution of
`@everyone`, roles, member-specific overwrites, and administrator behavior. Use it before changing
the blueprint when a plan reports a permission problem.

## Idempotency

After a successful apply, capture a new snapshot and plan the same revision again. A healthy
reconciliation produces no actions. Persistent churn usually means:

- an unmanaged actor is changing the same field;
- the blueprint order values are ambiguous;
- a direct Discord ID points at a changing external resource;
- the bot cannot observe an optional guild feature;
- bindings were lost or manually edited.

Do not fix churn by repeatedly applying. Diagnose ownership first.
