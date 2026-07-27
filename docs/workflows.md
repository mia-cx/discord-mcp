# Workflow authoring

Workflows depend on `@discord-mcp/workflow-sdk` and default-export `Workflow.make(...)`. Supported
triggers are Gateway events, commands, components, modals, autocomplete, HTTP, schedules, and manual
invocation. Use `Discord`, `WorkflowKv`, brokered `Http`, structured `Log`, `Execution`, and `Clock`.

```ts
import { Discord, Trigger, Workflow } from '@discord-mcp/workflow-sdk'

export default Workflow.make({
  requestedGrants: { discord: { operationIds: ['create_message'] } },
  triggers: [
    Trigger.manual({
      key: 'announce',
      handler: ({ channelId, text }) =>
        Discord.sendMessage({
          channelId,
          presentation: {
            type: 'components_v2',
            components: [{ type: 'text', content: text }],
          },
        }),
    }),
  ],
})
```

Lifecycle is create/update draft → validate/build → publish → grant → enable. Requested grants are
advisory; an administrator approves a concrete revision-specific grant separately. Empty target lists
mean no access. Publishing freezes source, dependencies, lockfile, artifact, and manifest. Rollback
switches to an existing published, granted artifact without rebuilding.

Interactive actions use opaque handles. A `workflow` action dispatches only to the enabled revision
that created it. An `event` action is appended to the durable component inbox and can be long-polled
with `discord_events_tail` using `inbox: "component"`; interaction tokens are never stored there.

HTTP routes always live below `/workflows/{slug}/...`. Prefer HMAC or API-key authentication. HMAC is
`hex(HMAC-SHA256(secret, timestamp + "." + rawBody))` in
`x-discord-mcp-signature`, with Unix seconds in `x-discord-mcp-timestamp`; requests expire after five
minutes and cannot replay.

The build allows arbitrary npm dependencies but disables lifecycle scripts unless the approved grant
allows them. Runtime networking is disabled; outbound HTTPS goes through `Http` and an allowlisted
host grant. Source is limited to 256 KiB, direct dependencies to 100, artifacts to 20 MiB, queued
events to 1,000, concurrency to 8, and handler timeouts to five minutes.
