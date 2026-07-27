# Messages, Components V2, modals, and files

The presentation layer gives MCP clients and workflows one semantic format for Discord messages. It
validates Discord limits before making a request, produces an ASCII preview, assigns stable component
IDs, stores opaque action bindings, handles attachments, and applies safe mention defaults.

## Choose a presentation type

### Legacy message

Use `legacy` for ordinary content, embeds, polls, attachments, and legacy component payloads:

```json
{
  "type": "legacy",
  "content": "Deployment complete.",
  "embeds": [
    {
      "title": "Production",
      "description": "Revision 42 is healthy",
      "color": 5763719
    }
  ],
  "allowedMentions": {
    "parse": []
  }
}
```

A legacy message must contain at least one meaningful payload. Content is limited to 2,000
characters. Embed and poll structures are passed through a JSON schema and Discord's own endpoint
rules.

### Components V2

Use `components_v2` for layout-first messages:

```json
{
  "type": "components_v2",
  "components": [
    {
      "type": "container",
      "accentColor": 5793266,
      "components": [
        {
          "type": "text",
          "content": "## Release ready\nAll checks passed."
        },
        {
          "type": "separator",
          "spacing": "small"
        },
        {
          "type": "actionRow",
          "components": [
            {
              "type": "button",
              "style": "success",
              "label": "Acknowledge",
              "action": {
                "type": "event",
                "key": "release.acknowledged"
              }
            }
          ]
        }
      ]
    }
  ],
  "allowedMentions": {
    "parse": []
  }
}
```

Supported semantic components:

| Component | Purpose |
| --- | --- |
| `text` | Markdown text display, up to 4,000 characters. |
| `section` | One to three text displays with a button or thumbnail accessory. |
| `container` | Grouped layout with optional accent color and spoiler state. |
| `actionRow` | Buttons or one select control. |
| `mediaGallery` | One to ten media items. |
| `file` | Display an uploaded attachment by `attachment://` URL. |
| `thumbnail` | Section accessory media. |
| `separator` | Optional divider and small or large spacing. |

Interactive buttons use `primary`, `secondary`, `success`, or `danger` and carry an action. Link
buttons carry a URL and no action. Premium buttons carry a SKU ID.

Select kinds are `string`, `user`, `role`, `mentionable`, and `channel`. String selects require one
to 25 options. Entity selects may restrict Discord channel types.

Converting an existing legacy message to Components V2 is irreversible in Discord. The edit tool
detects the existing flag, performs the required upgrade encoding, and refuses an attempt to convert
a V2 message back to legacy.

### Template reference

Use `template` to render a published revision:

```json
{
  "type": "template",
  "templateId": "release-announcement",
  "revision": 3,
  "variables": {
    "environment": "production",
    "version": "1.4.0"
  }
}
```

Omit `revision` to select the latest published revision. Drafts are never rendered by a send tool.
See [Message templates](templates.md).

## Safe mentions

Allowed mentions default to:

```json
{
  "users": [],
  "roles": [],
  "parse": [],
  "repliedUser": false
}
```

Explicit user or role snowflakes can be selected without enabling broad parse behavior. A non-empty
`parse` list requires `mentions:broad` for MCP callers or `broadMentions: true` in the approved
workflow grant. Source text containing `@everyone` is inert unless the encoded allowed-mentions
policy permits it.

The safe-mention policy also wraps raw catalog dispatch for message-like operations, so bypassing the
semantic tool does not restore permissive Discord defaults.

## Attachments and blobs

Inline attachment:

```json
{
  "source": "inline",
  "filename": "report.txt",
  "mimeType": "text/plain",
  "data": "Ym91bmRlZCBiYXNlNjQgYnl0ZXM="
}
```

Stored blob attachment:

```json
{
  "source": "blob",
  "blobId": "64-character-sha256-id",
  "filename": "report.pdf"
}
```

MCP inline data is bounded and base64-only. For a large local file, use:

```sh
corepack pnpm cli -- blob put PRINCIPAL_ID ./report.pdf application/pdf
```

For a remote client, stream bytes to `POST /blobs` with Bearer authentication,
`Content-Type`, and `X-Discord-Mcp-Filename`. MCP tools expose blob metadata, never the stored bytes.
Only the owner, an authorized workflow, or an administrator may resolve a blob for Discord.

## Interactive actions

An action is:

```json
{ "type": "workflow", "key": "deploy.approve" }
```

or:

```json
{ "type": "event", "key": "deploy.approve" }
```

The encoder replaces this logical action with an opaque custom ID and persists the binding.

- `workflow` routes directly to the published workflow revision that emitted the component.
- `event` appends to a durable component inbox, readable with `discord_events_tail`.

An MCP-authored message may create only `event` actions. It cannot claim ownership of a workflow
action. Workflow action bindings are valid only when emitted by the owning published revision.

## Modals

A modal has a title, an action, and one to five top-level text displays or labels:

```json
{
  "title": "Approve deployment",
  "action": {
    "type": "workflow",
    "key": "deploy.approve"
  },
  "components": [
    {
      "type": "text",
      "content": "Confirm the change ticket and environment."
    },
    {
      "type": "label",
      "label": "Change ticket",
      "component": {
        "type": "textInput",
        "key": "ticket",
        "style": "short",
        "required": true,
        "placeholder": "CHG-1234"
      }
    }
  ]
}
```

Label controls support:

- short or paragraph `textInput`;
- string or entity `select`;
- `fileUpload`;
- `radioGroup`;
- `checkboxGroup`;
- `checkbox`.

The semantic key becomes part of the normalized interaction input. Use
`discord_modal_validate` before returning a modal from a workflow.

## Validation workflow

Before sending a complex presentation, call:

- `discord_message_validate` for messages;
- `discord_modal_validate` for modals.

Validation reports Discord limit failures, component structure problems, attachment issues, action
bindings, calculated flags, and an ASCII layout preview. Validation is local and requires no Discord
write.

## Sending and editing

Use:

- `discord_message_send` for a channel message;
- `discord_message_edit` for an existing message;
- `discord_webhook_execute` for an encrypted named webhook token;
- `Discord.sendMessage` or `Discord.respondToInteraction` inside workflows.

The same encoder and mention rules apply to every route. This ensures an interaction response cannot
use a raw callback object to bypass presentation validation or component ownership.
