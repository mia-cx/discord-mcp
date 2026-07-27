# Workflow authoring

Workflows depend on `@discord-mcp/workflow-sdk` and default-export `Workflow.make(...)`. Supported
triggers are Gateway, interaction command/component/modal/autocomplete, HTTP, schedule, and manual.

```ts
import { Discord, Http, Trigger, Workflow } from '@discord-mcp/workflow-sdk'

export default Workflow.make({
  requestedGrants: {
    discord: { operationIds: ['create_message'], channelIds: ['12345678901234567'] },
    routes: { public: true },
  },
  triggers: [
    Trigger.schedule({
      schedule: '0 9 * * 1',
      handler: () =>
        Discord.sendMessage({
          channelId: '12345678901234567',
          presentation: { type: 'legacy', content: 'Weekly status', allowedMentions: { parse: [] } },
        }),
    }),
    Trigger.http({
      method: 'POST',
      path: '/deploy',
      auth: { type: 'hmacSha256', secretRef: 'deploy-hook' },
      handler: ({ ref }) => Http.json({ accepted: true, ref }, 202),
    }),
  ],
})
```

Requested grants are informational. An administrator approves a concrete, revision-specific grant
separately; empty target lists mean no access. The lifecycle is:

```text
create/update draft → validate (sandbox build) → publish → grant → enable
```

Publishing freezes source, dependencies, lockfile, manifest, and artifact digest. Rollback switches to
an already published and granted artifact without rebuilding. Disablement rejects new capability
calls, drains active handlers to their deadline, stops the runner, and removes its routes/commands.

Use only `Discord`, `WorkflowKv`, brokered `Http`, `Log`, `Execution`, and `Clock`. Direct network is
disabled at runtime. `Http` permits HTTPS hosts named in the grant. Components use logical workflow
actions; the control plane replaces them with opaque persisted handles.

Interaction handlers must return an SDK-authored response. Use
`Discord.respondToInteraction(...)` for messages and modals, and
`Discord.respondToAutocomplete([{ name, value }, ...])` for autocomplete. Autocomplete accepts at
most 25 choices; the control plane validates the response and rejects raw Discord callback objects so
workflow responses cannot bypass the shared presentation encoder or component-ownership checks.

Build limits are 256 KiB source, 100 direct dependencies, 20 MiB artifact, and five minutes.
Install scripts default off. Runtime defaults are 30 seconds, concurrency one, 1,000 queued events,
64 KiB logs, 256 MiB memory, one CPU, and 128 processes. A workflow receives a credential scoped to
one enabled revision; it contains no Discord secret and is checked on every broker call.

Public routes are always `/workflows/{slug}/{relativePath}`. Choose `apiKey`, `bearer`, `hmacSha256`,
or explicitly granted `none`; route secrets are encrypted named references. HMAC is
`hex(HMAC-SHA256(secret, timestamp + "." + rawBody))` in
`X-Discord-Mcp-Signature`, with Unix seconds in `X-Discord-Mcp-Timestamp`. Requests older than five
minutes or replays are rejected.
