import { defineTool, McpRequestContext, ValidationError } from '@discord-mcp/core'
import {
  asciiLayout,
  encodePresentation,
  MessageTemplate,
  renderTemplate,
} from '@discord-mcp/discord-presentations'
import { AuditRepository, RevisionRepository } from '@discord-mcp/persistence'
import { Effect, Schema } from 'effect'

/**
 * Template lifecycle: draft → publish → render.
 *
 * The same draft/publish shape as blueprints, for the same reason. A published revision is
 * immutable, so a workflow that pins revision 3 keeps getting revision 3 no matter what anyone
 * does to the draft afterwards.
 */

type Deps = RevisionRepository | AuditRepository

const TemplateId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-z0-9][a-z0-9_-]{0,63}$/, { title: 'template id' })),
)

const TABLE = 'message_templates' as const

const UpdateDraftInput = Schema.Struct({
  templateId: TemplateId,
  name: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(100))),
  template: MessageTemplate,
})

export const templateUpdateDraft = defineTool<typeof UpdateDraftInput.Type, unknown, Deps>({
  name: 'discord_message_template_update_draft',
  title: 'Create or update a message template draft',
  description: [
    'Save a reusable message template: a declarative variable schema plus a presentation with',
    '{{placeholder}} substitutions.',
    '',
    'Templates hold data, never code — no expression language runs when one is rendered. Each',
    'variable declares the context it renders into (plainText, discordMarkdown, inlineCode,',
    'codeBlock, url, or a mention form) and rendering escapes for exactly that context. plainText is',
    'the default, so a value cannot carry markup or forge a mention unless the author opted in.',
    '',
    'Drafts are mutable; publish freezes a revision.',
  ].join('\n'),
  toolset: 'automation',
  risk: 'write',
  scopes: ['template:write'],
  annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  input: UpdateDraftInput,
  handler: (args) =>
    Effect.gen(function* () {
      const repo = yield* RevisionRepository
      yield* repo.saveDraft(TABLE, {
        id: args.templateId,
        name: args.name,
        draft: args.template,
      })
      return { templateId: args.templateId, saved: true }
    }),
})

const ValidateInput = Schema.Struct({
  template: MessageTemplate,
  sampleVariables: Schema.optionalKey(
    Schema.Unknown.annotate({
      description: 'Render the template with these to see the result before publishing.',
    }),
  ),
})

export const templateValidate = defineTool<typeof ValidateInput.Type, unknown, never>({
  name: 'discord_message_template_validate',
  title: 'Validate a template without saving it',
  description: [
    'Check a template’s structure, and optionally render it with sample variables to see exactly',
    'what it produces — including the ASCII layout preview.',
    '',
    'Costs no Discord request. Use this while authoring, before publishing a revision that cannot',
    'then be changed.',
  ].join('\n'),
  toolset: 'automation',
  risk: 'read',
  scopes: ['template:read'],
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: ValidateInput,
  handler: (args) =>
    Effect.gen(function* () {
      const declared = Object.entries(args.template.variables).map(([name, node]) => ({
        name,
        kind: (node as { kind: string }).kind,
        required: (node as { required?: boolean }).required ?? false,
        // Naming the default matters: an author who does not set this gets escaping, and should
        // know that rather than discover it when their markdown renders as literal asterisks.
        context: (node as { context?: string }).context ?? 'plainText',
      }))

      if (args.sampleVariables === undefined) {
        return { valid: true, variables: declared, rendered: null }
      }

      const presentation = yield* renderTemplate(args.template, args.sampleVariables)
      const encoded = yield* encodePresentation(presentation, {
        resolveCustomId: (_action, path) => `preview:${path}`,
        allowBroadMentions: true,
      })

      return {
        valid: true,
        variables: declared,
        rendered: {
          presentation,
          payload: encoded.payload,
          layout:
            presentation.type === 'components_v2'
              ? asciiLayout(presentation.components)
              : '(legacy message)',
          warnings: encoded.report.warnings,
        },
      }
    }),
})

const PublishInput = Schema.Struct({ templateId: TemplateId })

export const templatePublish = defineTool<typeof PublishInput.Type, unknown, Deps>({
  name: 'discord_message_template_publish',
  title: 'Freeze a template draft as an immutable revision',
  description: [
    'Publish the current draft as a numbered revision.',
    '',
    'Published revisions never change, which is what lets a workflow pin one and keep getting the',
    'same message. Editing afterwards updates the draft only.',
  ].join('\n'),
  toolset: 'automation',
  risk: 'write',
  scopes: ['template:write'],
  annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false },
  input: PublishInput,
  handler: (args) =>
    Effect.gen(function* () {
      const repo = yield* RevisionRepository
      const audit = yield* AuditRepository
      const { principal } = yield* McpRequestContext

      const draft = yield* repo.getDraft(TABLE, args.templateId)
      if (draft === undefined) {
        return yield* Effect.fail(
          new ValidationError({
            message: `Template "${args.templateId}" has no draft to publish.`,
            issues: ['templateId: call discord_message_template_update_draft first.'],
          }),
        )
      }

      // Validate before freezing: a revision is immutable, so an unrepresentable one would sit
      // there permanently unusable.
      const template = yield* Schema.decodeUnknownEffect(MessageTemplate, { errors: 'all' })(draft)

      const published = yield* repo.publish(TABLE, {
        id: args.templateId,
        name: args.templateId,
        body: template,
        publishedBy: principal.id,
      })

      yield* audit.record({
        principalId: principal.id,
        action: 'template.publish',
        subjectKind: 'template',
        subjectId: args.templateId,
        outcome: 'allowed',
        detail: published,
      })

      return { templateId: args.templateId, ...published }
    }),
})

const RenderInput = Schema.Struct({
  templateId: TemplateId,
  revision: Schema.optionalKey(
    Schema.Int.annotate({
      description:
        'Pin a specific published revision. Omit to follow the latest — explicitly, so a message that must never change should pin.',
    }),
  ),
  variables: Schema.Unknown,
})

export const templateRender = defineTool<typeof RenderInput.Type, unknown, Deps>({
  name: 'discord_message_template_render',
  title: 'Render a published template into a presentation',
  description: [
    'Render a published template revision with the supplied variables and return a presentation',
    'ready to pass to discord_message_send.',
    '',
    'Variables are validated against the template’s declared schema and escaped for the context',
    'each one declares. The result passes through the same validator as any hand-authored message,',
    'so a template cannot produce something you could not have sent directly.',
  ].join('\n'),
  toolset: 'automation',
  risk: 'read',
  scopes: ['template:read'],
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: RenderInput,
  handler: (args) =>
    Effect.gen(function* () {
      const repo = yield* RevisionRepository
      const latest = yield* repo.latestRevision(TABLE, args.templateId)
      const revision = args.revision ?? latest

      if (revision === 0) {
        return yield* Effect.fail(
          new ValidationError({
            message: `Template "${args.templateId}" has no published revision.`,
            issues: ['templateId: publish a draft with discord_message_template_publish first.'],
          }),
        )
      }

      const stored = yield* repo.getRevision(TABLE, args.templateId, revision)
      if (stored === undefined) {
        return yield* Effect.fail(
          new ValidationError({
            message: `Template "${args.templateId}" has no revision ${revision}.`,
            issues: [`revision: the latest published revision is ${latest}.`],
          }),
        )
      }

      const template = yield* Schema.decodeUnknownEffect(MessageTemplate, { errors: 'all' })(
        stored.body,
      )
      const presentation = yield* renderTemplate(template, args.variables)

      return {
        templateId: args.templateId,
        revision,
        pinned: args.revision !== undefined,
        digest: stored.digest,
        presentation,
      }
    }),
})

export const templateTools = [
  templateUpdateDraft,
  templateValidate,
  templatePublish,
  templateRender,
]
