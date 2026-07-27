# Message templates

Message templates are owned, versioned presentation documents. They separate reusable Discord layout
from per-send data and validate interpolation according to context. Drafts are mutable; published
revisions are immutable.

## Lifecycle

```text
create draft → update draft → validate with representative variables → publish → render or send
```

Archiving hides the template from the active list without deleting published revisions. Existing
references remain reproducible.

The tools are:

- `discord_message_template_list`
- `discord_message_template_get`
- `discord_message_template_create`
- `discord_message_template_update_draft`
- `discord_message_template_validate`
- `discord_message_template_publish`
- `discord_message_template_render`
- `discord_message_template_archive`

Reading requires `template:read`; mutation requires `template:write`.

## Document structure

A document has:

1. `variableSchema` — named, typed inputs;
2. `presentation` — a legacy or Components V2 presentation whose leaf values may contain variable
   references.

Example:

```json
{
  "variableSchema": {
    "title": {
      "type": "string",
      "minLength": 1,
      "maxLength": 80
    },
    "requester": {
      "type": "snowflake"
    },
    "environment": {
      "type": "enum",
      "values": ["staging", "production"],
      "default": "staging"
    },
    "detailsUrl": {
      "type": "url"
    }
  },
  "presentation": {
    "type": "components_v2",
    "components": [
      {
        "type": "container",
        "components": [
          {
            "type": "text",
            "content": {
              "$variable": "title",
              "context": "plainText"
            }
          },
          {
            "type": "text",
            "content": {
              "$variable": "requester",
              "context": "mentionUser"
            }
          },
          {
            "type": "text",
            "content": {
              "$variable": "environment",
              "context": "inlineCode"
            }
          },
          {
            "type": "actionRow",
            "components": [
              {
                "type": "button",
                "style": "link",
                "label": "Details",
                "url": {
                  "$variable": "detailsUrl",
                  "context": "discordMarkdown"
                }
              }
            ]
          }
        ]
      }
    ]
  }
}
```

## Variable types

| Type | Validation |
| --- | --- |
| `string` | Optional minimum, maximum, and default. |
| `number` | Finite number with optional minimum, maximum, and default. |
| `boolean` | Boolean with optional default. |
| `snowflake` | 17–21 digit Discord snowflake. |
| `url` | HTTPS URL only. |
| `timestamp` | Parseable ISO timestamp string. |
| `enum` | One of a declared non-empty value set. |
| `array` | Typed items, optional maximum item count and default. |
| `object` | Declared properties, explicit required keys, and optional default. |
| `optional` | Wrapped schema whose value may be omitted. |

Unknown variables and unknown object fields are rejected. Defaults are applied before interpolation.
Arrays have a default limit of 100 items; an explicit `maxItems` replaces that default.

## Interpolation contexts

Each variable reference must state where its string will be used:

| Context | Behavior |
| --- | --- |
| `plainText` | Escapes Discord Markdown punctuation. |
| `discordMarkdown` | Preserves the supplied Markdown. Use only for trusted or intentionally formatted input. |
| `inlineCode` | Escapes backticks and removes newlines. |
| `codeBlock` | Breaks triple-backtick delimiters safely. |
| `url` | Percent-encodes the value as a URL component. |
| `mentionUser` | Requires a snowflake and formats `<@id>`. |
| `mentionRole` | Requires a snowflake and formats `<@&id>`. |

Context is mandatory. A reference object must contain exactly `$variable` and `context`.
Dot-separated paths can read nested object variables, for example `deployment.environment`.

## Create, validate, and publish

Create:

```json
{
  "name": "Release announcement",
  "document": {
    "variableSchema": {},
    "presentation": {
      "type": "legacy",
      "content": "Release complete"
    }
  }
}
```

The create result contains the template ID. Update replaces only the draft document. Validate or
publish with representative variables:

```json
{
  "templateId": "TEMPLATE_ID",
  "variables": {
    "title": "Release 1.4.0",
    "requester": "12345678901234567",
    "environment": "production",
    "detailsUrl": "https://deploy.example/releases/1.4.0"
  }
}
```

Publish first renders and validates the current draft, then writes the next immutable revision. A
failed validation does not publish.

## Render and send

Render explicitly with `discord_message_template_render`, or pass a template presentation to
`discord_message_send`, `discord_message_edit`, a webhook, or a workflow capability:

```json
{
  "channelId": "12345678901234567",
  "presentation": {
    "type": "template",
    "templateId": "TEMPLATE_ID",
    "revision": 2,
    "variables": {
      "title": "Release 1.4.0",
      "requester": "12345678901234568",
      "detailsUrl": "https://deploy.example/releases/1.4.0"
    }
  }
}
```

Pin a revision for reproducibility. Omitting the revision means latest published, which is convenient
for an operator but less deterministic for automation.

The rendered output is validated again as a normal presentation and includes the document digest and
warnings. A template never evaluates JavaScript, expressions, conditionals, or arbitrary property
paths.

## Ownership and retention

Templates belong to the principal that created them. Another principal cannot read or mutate them
merely by knowing the ID. Published templates that reference blobs keep those blobs retained.

Back up templates with SQLite and their referenced blob directory. See [Backups](backups.md).
