# Workflow authoring

A workflow is a TypeScript module built against `@discord-mcp/workflow-sdk`. It declares one or more
triggers and the capabilities it would like to use. The declaration is only a request: validation
builds the source, publishing freezes it, and an administrator must still approve a revision-specific
grant before the workflow can run.

For the lifecycle around the code, read [Workflow lifecycle](workflows.md). For the isolation boundary,
read [Sandbox and capability security](sandbox.md).

## Minimal workflow

Every module must default-export `Workflow.make(...)`:

```ts
import { Discord, Log, Schema, Trigger, Workflow } from '@discord-mcp/workflow-sdk'

const AnnouncementInput = Schema.Struct({
  requestedBy: Schema.String,
  message: Schema.String,
})

export default Workflow.make({
  requestedGrants: {
    discord: {
      operationIds: ['create_message'],
      channelIds: ['123456789012345678'],
    },
  },
  triggers: [
    Trigger.manual({
      key: 'announce',
      handler: async (raw) => {
        const input = Schema.decodeUnknownSync(AnnouncementInput)(raw)
        Log.info('Sending an announcement', { requestedBy: input.requestedBy })
        return Discord.sendMessage({
          channelId: '123456789012345678',
          presentation: {
            type: 'legacy',
            content: input.message,
            allowedMentions: { parse: [] },
          },
        })
      },
    }),
  ],
})
```

A handler receives its trigger input and an execution context. It may return a plain value, a
`Promise`, or an Effect program. Source can import `Effect` and `Schema` from the SDK so the sandboxed
build uses the exact versions supplied by the platform. Trigger payloads are `unknown` by default;
decode untrusted fields with a schema before using them, as the examples do.

## Trigger types

### Gateway events

Gateway triggers receive selected Discord dispatches after the control plane has persisted and
filtered them:

```ts
Trigger.gateway({
  eventTypes: ['MESSAGE_REACTION_ADD'],
  handler: async (raw, context) => {
    const event = Schema.decodeUnknownSync(
      Schema.Struct({
        payload: Schema.Struct({ channel_id: Schema.optionalKey(Schema.String) }),
      }),
    )(raw)
    Log.info('Reaction observed', {
      correlationId: context.correlationId,
      channelId: event.payload.channel_id,
    })
  },
})
```

The approved grant controls event types and whether bot-authored events are delivered. Configure the
required intents on both the application and control plane. Filter guild/channel IDs in the handler
when needed; the Discord-operation grant still independently constrains where the workflow may act.
Event dispatch is at-least-once, so make handlers idempotent and use `WorkflowKv` when a durable
deduplication marker is needed.

### Application commands

Chat-input, user, and message commands are published from an enabled revision:

```ts
Trigger.interactionCommand({
  name: 'status',
  commandType: 'chatInput',
  description: 'Show service status',
  options: [],
  global: false,
  handler: () =>
    Discord.respondToInteraction({
      type: 'legacy',
      content: 'Service is healthy.',
      allowedMentions: { parse: [] },
    }),
})
```

Guild commands propagate faster and are the better development default. Global publication must be
explicitly allowed by the grant. Chat-input commands require a description; user and message context
commands omit it.

The control plane acknowledges slow handlers before Discord's deadline and later edits the original
response. An interaction handler must return an SDK-authored response. Raw Discord callback objects
are rejected so workflow code cannot bypass presentation validation or component ownership.

### Components, modals, and autocomplete

Components use a logical `action`, not a hand-crafted `custom_id`:

```ts
Trigger.interactionComponent({
  action: 'approve',
  handler: async (raw) => {
    const interaction = Schema.decodeUnknownSync(
      Schema.Struct({
        member: Schema.Struct({ user: Schema.Struct({ id: Schema.String }) }),
      }),
    )(raw)
    return Discord.respondToInteraction({
      type: 'legacy',
      content: `Approved by <@${interaction.member.user.id}>`,
      allowedMentions: { parse: [] },
    })
  },
})
```

When a workflow sends a component that names `approve`, the control plane replaces it with an opaque,
durable handle bound to the owner and revision. Modal submissions use
`Trigger.interactionModal({ action, handler })` the same way.

Autocomplete is bound to a command name:

```ts
Trigger.interactionAutocomplete({
  command: 'status',
  handler: () =>
    Discord.respondToAutocomplete(
      ['production', 'staging', 'development'].map((name) => ({ name, value: name })),
    ),
})
```

Autocomplete accepts at most 25 choices. Each value must be a string or number.

### HTTP routes

HTTP triggers are published under `/workflows/{slug}/{relativePath}`:

```ts
const DeployBody = Schema.Struct({ ref: Schema.optionalKey(Schema.String) })
const HttpInvocation = Schema.Struct({
  method: Schema.String,
  path: Schema.String,
  headers: Schema.Record(Schema.String, Schema.String),
  body: Schema.String,
})

Trigger.http({
  method: 'POST',
  path: '/deploy',
  auth: { type: 'hmacSha256', secretRef: 'deploy-hook' },
  request: DeployBody,
  handler: (raw) => {
    const request = Schema.decodeUnknownSync(HttpInvocation)(raw)
    const body = Schema.decodeUnknownSync(DeployBody)(
      JSON.parse(Buffer.from(request.body, 'base64').toString('utf8')),
    )
    return Http.json({ accepted: true, ref: body.ref }, 202)
  },
})
```

The optional `request` Standard Schema is converted to JSON Schema and enforced against the incoming
JSON body before invocation. The handler receives `{ method, path, headers, body }`, where `body` is
the exact request bytes encoded as base64.

Available policies are:

| Policy | Client behavior |
| --- | --- |
| `apiKey` | Send the referenced secret in `X-Api-Key` |
| `bearer` | Send `Authorization: Bearer <secret>` |
| `hmacSha256` | Sign the timestamp and exact raw request body |
| `none` | No route credential; the administrator must explicitly grant public access |

For HMAC routes, send Unix seconds in `X-Discord-Mcp-Timestamp` and the lowercase hexadecimal result
of `HMAC-SHA256(secret, timestamp + "." + rawBody)` in `X-Discord-Mcp-Signature`. Timestamps older
than five minutes and repeated signatures are rejected. The Content-Length limit is checked before
the body is buffered.

HTTP handlers must return an `Http` response, normally `Http.json(value, status)`. Routes are removed
when their owning revision is disabled.

### Schedules

Schedules use a five-field cron expression:

```ts
Trigger.schedule({
  schedule: '0 9 * * 1',
  handler: () =>
    Discord.sendMessage({
      channelId: '123456789012345678',
      presentation: {
        type: 'legacy',
        content: 'Weekly status reminder',
        allowedMentions: { parse: [] },
      },
    }),
})
```

Treat scheduled delivery as at-least-once. Record a period key in `WorkflowKv` when a duplicate would
be harmful.

### Manual triggers

Manual triggers expose a named entry point to the workflow execution tool. They are useful for
operator-controlled jobs, testing a published revision, and composing workflows with an MCP client:

```ts
Trigger.manual({
  key: 'rebuild-summary',
  handler: async (raw) => {
    const { guildId } = Schema.decodeUnknownSync(
      Schema.Struct({ guildId: Schema.String }),
    )(raw)
    // ...
    return { accepted: true, guildId }
  },
})
```

## Capability APIs

Workflow code has no Discord token and no direct network. Its authority comes from brokered APIs:

| API | Purpose | Important limits |
| --- | --- | --- |
| `Discord.request(operationId, input)` | Call a pinned Discord operation | Operation, auth profile, targets, action count, and causal depth must match the grant |
| `Discord.sendMessage(input)` | Send a validated legacy or Components V2 presentation | Shared mention, component, attachment, and presentation policies apply |
| `Discord.respondToInteraction(input)` | Produce a message or modal interaction response | Only valid during the owning interaction execution |
| `Discord.respondToAutocomplete(choices)` | Produce autocomplete choices | Maximum 25 choices |
| `WorkflowKv.get/set/delete` | Store workflow-scoped durable JSON values | Each encoded value is limited to 64 KiB |
| `Http.fetch(url, init)` | Call a granted external host through the broker | HTTPS only, exact granted host, no redirects, response at most 1 MiB |
| `Http.json(value, status)` | Return a JSON response from an HTTP route | Must be returned by the HTTP handler |
| `Log.info/error` | Add structured execution logs | Logs are capped and later redacted/retained |
| `Execution.context()` | Read execution, correlation, causation, and depth IDs | Available only during an active execution |
| `Clock.now/sleep` | Read the runner clock or delay | Sleep must be between 0 and 300,000 ms and still fits the execution deadline |

`Discord.request` uses the catalog's exact operation ID. Use `discord_api_search` and
`discord_api_describe` before writing the workflow, then include only the needed IDs in the requested
and approved grants.

## Requested grants

The declaration should be narrow enough that an administrator can safely approve it:

```ts
requestedGrants: {
  discord: {
    operationIds: ['create_message', 'get_channel_messages'],
    guildIds: ['123456789012345678'],
    channelIds: ['234567890123456789'],
    oauthProfileIds: [],
  },
  gateway: {
    eventTypes: ['MESSAGE_REACTION_ADD'],
    includeBotAuthoredEvents: false,
  },
  network: {
    allowedOutboundHosts: ['status.example.com'],
  },
  routes: {
    public: false,
  },
}
```

Requested grants are documentation, not authority. `discord_workflow_grant` records a separate grant
for one immutable revision. Empty target lists mean no access, not unrestricted access. A new
revision must be reviewed and granted again.

## State, retries, and idempotency

Queues and executions are durable, but external effects cannot be made transactional with SQLite.
Write handlers so a retry after a crash does not duplicate harmful work:

1. Derive a stable key from the trigger or `correlationId`.
2. Check `WorkflowKv` before acting.
3. Perform the external action.
4. Store the completed marker and any result needed by later attempts.

Discord actions are also recorded with correlation and causation metadata. Causal depth is bounded to
stop a workflow from producing an event loop that invokes itself indefinitely.

## Dependency and build rules

- Source is limited to 256 KiB.
- A revision may declare at most 100 direct dependencies.
- The manifest is limited to 1 MiB and 1–1,000 triggers.
- The build deadline is five minutes.
- The artifact is limited to 20 MiB.
- Package lifecycle scripts are disabled by default. Enabling them requires `workflow:admin` during
  validation and a matching high-risk grant decision.
- The lockfile and artifact digest are frozen at publication.

Prefer small, pure JavaScript dependencies. Native packages increase build risk and do not turn a
container into a kernel-grade isolation boundary.

## Runtime limits and failures

The default execution timeout is 30 seconds; a manifest may request 1–300 seconds. Concurrency may be
1–8 and the per-workflow queue holds at most 1,000 entries. A runner is limited to 256 MiB of memory,
one CPU, and 128 processes. A timeout, crash, digest mismatch, queue overflow, invalid capability
request, or invalid response is recorded as a typed execution failure.

Use `discord_workflow_execution_get` for one execution and
`discord_workflow_executions_tail` for ongoing diagnostics. Disable a failing workflow before
changing it; then publish a corrected revision or roll back to a previously granted revision.
