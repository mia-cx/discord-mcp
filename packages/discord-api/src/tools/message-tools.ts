import { defineTool, Snowflake, ValidationError } from '@discord-mcp/core'
import {
  asciiLayout,
  type ComponentsV2TopLevel,
  encodeModal,
  encodePresentation,
  MessagePresentation,
  ModalPresentation,
  validateComponentsV2,
  validateModal,
} from '@discord-mcp/discord-presentations'
import { ComponentBindingRepository } from '@discord-mcp/persistence'
import { Effect, Schema } from 'effect'
import { DiscordRest } from '../rest.ts'

/**
 * Mint an opaque handle for each interactive component before sending.
 *
 * The handle carries no meaning. Discord round-trips `custom_id` through the client, so anything
 * encoded in one comes back as untrusted input; the interactions router resolves it through the
 * binding table instead.
 */
const bindComponents = (
  bindings: ReadonlyArray<{ path: string; action: unknown }>,
  ownerId: string,
) =>
  Effect.gen(function* () {
    if (bindings.length === 0) return new Map<string, string>()

    const repo = yield* ComponentBindingRepository
    const handles = new Map<string, string>()

    for (const binding of bindings) {
      const action = binding.action as { type?: string; key?: string }
      if (action?.key === undefined) continue

      const handle = yield* repo.create({
        kind: action.type === 'workflow' ? 'workflow' : 'inbox',
        actionKey: action.key,
        ownerKind: 'message',
        ownerId,
      })
      handles.set(binding.path, handle)
    }
    return handles
  })

/**
 * Encode twice: once to discover the bindings, then again with the real handles.
 *
 * Cheaper than threading a mutable handle table through the encoder, and it keeps the encoder a
 * pure function of its input — which is what makes `discord_message_validate` able to run the
 * exact same path without minting anything.
 */
const encodeWithHandles = (
  presentation: Exclude<MessagePresentation, { type: 'template' }>,
  ownerId: string,
  options: { upgradingFromLegacy?: boolean } = {},
) =>
  Effect.gen(function* () {
    const discovery = yield* encodePresentation(presentation, {
      resolveCustomId: (_action, path) => `pending:${path}`,
    })

    const handles = yield* bindComponents(discovery.bindings, ownerId)

    return yield* encodePresentation(presentation, {
      resolveCustomId: (_action, path) => handles.get(path) ?? `pending:${path}`,
      ...(options.upgradingFromLegacy === undefined
        ? {}
        : { upgradingFromLegacy: options.upgradingFromLegacy }),
    })
  })

// ------------------------------------------------------------------ validate

const ValidateInput = Schema.Struct({
  presentation: MessagePresentation,
})

export const messageValidate = defineTool<typeof ValidateInput.Type, unknown, never>({
  name: 'discord_message_validate',
  title: 'Validate a message presentation without sending it',
  description: [
    'Run the exact local validation and encoding path a send would, without contacting Discord.',
    '',
    'Returns the normalized Discord payload, an ASCII layout preview, the component count,',
    'attachment manifest, interactive bindings, and warnings. This is the preferred tool while',
    'authoring a complex Components V2 layout: it costs nothing and shows you the structure you',
    'just described.',
  ].join('\n'),
  toolset: 'operator',
  risk: 'read',
  scopes: ['mcp:read'],
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: ValidateInput,
  handler: (args) =>
    Effect.gen(function* () {
      const presentation = args.presentation

      if (presentation.type === 'template') {
        return yield* Effect.fail(
          new ValidationError({
            message: 'Render a template before validating it.',
            issues: ['presentation: call discord_message_template_render first.'],
          }),
        )
      }

      const encoded = yield* encodePresentation(presentation, {
        // A stable placeholder: validation must not consume real handles.
        resolveCustomId: (_action, path) => `preview:${path}`,
        allowBroadMentions: true,
      })

      const components =
        presentation.type === 'components_v2'
          ? presentation.components
          : ([] as ReadonlyArray<ComponentsV2TopLevel>)

      return {
        valid: true,
        payload: encoded.payload,
        layout:
          presentation.type === 'components_v2' ? asciiLayout(components) : '(legacy message)',
        componentCount: encoded.report.componentCount,
        maxDepth: encoded.report.maxDepth,
        totalTextChars: encoded.report.totalTextChars,
        attachments: encoded.attachments.map((a) => ({ filename: a.filename, kind: a.kind })),
        referencedAttachments: encoded.report.referencedAttachments,
        interactiveBindings: encoded.bindings.map((b) => ({ path: b.path, action: b.action })),
        warnings: encoded.report.warnings,
        requiredPermissions: ['ViewChannel', 'SendMessages'],
      }
    }),
})

// ------------------------------------------------------------------ modal validate

const ModalValidateInput = Schema.Struct({ modal: ModalPresentation })

export const modalValidate = defineTool<typeof ModalValidateInput.Type, unknown, never>({
  name: 'discord_modal_validate',
  title: 'Validate a modal presentation',
  description: [
    'Exercise the same encoder the interaction handlers use, without attempting to open a modal',
    'outside an interaction (which Discord does not permit).',
    '',
    'Message-only components cannot appear in a modal and modal-only inputs cannot appear in a',
    'message; both directions are rejected here.',
  ].join('\n'),
  toolset: 'operator',
  risk: 'read',
  scopes: ['mcp:read'],
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: ModalValidateInput,
  handler: (args) =>
    Effect.gen(function* () {
      const issues = validateModal(args.modal)
      if (issues.length > 0) {
        return yield* Effect.fail(
          new ValidationError({ message: 'The modal is not valid.', issues }),
        )
      }
      return {
        valid: true,
        payload: encodeModal(args.modal, (key) => `preview:${key}`),
        inputCount: args.modal.components.length,
      }
    }),
})

// ------------------------------------------------------------------ send

const SendInput = Schema.Struct({
  channelId: Snowflake,
  presentation: MessagePresentation,
  replyToMessageId: Schema.optionalKey(Snowflake),
})

export const messageSend = defineTool<
  typeof SendInput.Type,
  unknown,
  DiscordRest | ComponentBindingRepository
>({
  name: 'discord_message_send',
  title: 'Send a message',
  description: [
    'Send a legacy or Components V2 message to a channel.',
    '',
    'Requires ViewChannel and SendMessages in the target channel. Components V2 messages cannot',
    'carry content, embeds, stickers, or polls — Discord rejects the combination outright; express',
    'text as a text component instead.',
    'Mentions default to none; specific users and roles must be allowlisted explicitly.',
    'Validate first with discord_message_validate when the layout is complex.',
  ].join('\n'),
  toolset: 'operator',
  risk: 'write',
  scopes: ['mcp:write'],
  annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
  input: SendInput,
  handler: (args) =>
    Effect.gen(function* () {
      if (args.presentation.type === 'template') {
        return yield* Effect.fail(
          new ValidationError({
            message: 'Render a template before sending it.',
            issues: ['presentation: call discord_message_template_render first.'],
          }),
        )
      }

      // Handles are minted against the channel until the message id exists; the interactions
      // router only needs the handle to resolve, not the owner to be a message.
      const encoded = yield* encodeWithHandles(args.presentation, args.channelId)

      const rest = yield* DiscordRest
      const body: Record<string, unknown> = { ...encoded.payload }
      if (args.replyToMessageId !== undefined) {
        body.message_reference = { message_id: args.replyToMessageId }
      }

      const data = yield* rest.request({
        method: 'POST',
        route: `/channels/${args.channelId}/messages`,
        operationFamily: 'message',
        body,
      })

      return { message: data, warnings: encoded.report.warnings }
    }),
})

// ------------------------------------------------------------------ edit

const EditInput = Schema.Struct({
  channelId: Snowflake,
  messageId: Snowflake,
  presentation: MessagePresentation,
  upgradingFromLegacy: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        'Set when the existing message is legacy and this edit introduces Components V2. Discord requires content, poll, embeds, and sticker_ids to be cleared in the same request; this does that. A V2 message can never be edited back to legacy.',
    }),
  ),
})

export const messageEdit = defineTool<
  typeof EditInput.Type,
  unknown,
  DiscordRest | ComponentBindingRepository
>({
  name: 'discord_message_edit',
  title: 'Edit a message',
  description: [
    'Edit a message this bot authored.',
    '',
    'Upgrading a legacy message to Components V2 requires upgradingFromLegacy: true, which clears',
    'content, poll, embeds, and sticker_ids in the same request — Discord answers 400 otherwise.',
    'The upgrade is one-way: a Components V2 message can never be edited back to legacy.',
  ].join('\n'),
  toolset: 'operator',
  risk: 'write',
  scopes: ['mcp:write'],
  annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
  input: EditInput,
  handler: (args) =>
    Effect.gen(function* () {
      if (args.presentation.type === 'template') {
        return yield* Effect.fail(
          new ValidationError({
            message: 'Render a template before editing with it.',
            issues: ['presentation: call discord_message_template_render first.'],
          }),
        )
      }

      const encoded = yield* encodeWithHandles(args.presentation, args.messageId, {
        ...(args.upgradingFromLegacy === undefined
          ? {}
          : { upgradingFromLegacy: args.upgradingFromLegacy }),
      })

      const rest = yield* DiscordRest
      const data = yield* rest.request({
        method: 'PATCH',
        route: `/channels/${args.channelId}/messages/${args.messageId}`,
        operationFamily: 'message',
        body: encoded.payload,
      })

      return { message: data, warnings: encoded.report.warnings }
    }),
})

// ------------------------------------------------------------------ read

const GetInput = Schema.Struct({ channelId: Snowflake, messageId: Snowflake })

export const messageGet = defineTool<typeof GetInput.Type, unknown, DiscordRest>({
  name: 'discord_message_get',
  title: 'Read one message',
  description: [
    'Read a single message.',
    '',
    'Requires ViewChannel and ReadMessageHistory. Message content requires the MESSAGE_CONTENT',
    'privileged intent — over REST as well as the Gateway — and this server diagnoses the',
    'empty-content signature rather than returning silently blank fields.',
  ].join('\n'),
  toolset: 'operator',
  risk: 'read',
  scopes: ['mcp:read'],
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: GetInput,
  handler: (args) =>
    Effect.gen(function* () {
      const rest = yield* DiscordRest
      return yield* rest.request({
        method: 'GET',
        route: `/channels/${args.channelId}/messages/${args.messageId}`,
        operationFamily: 'message',
      })
    }),
})

const ListInput = Schema.Struct({
  channelId: Snowflake,
  limit: Schema.optionalKey(
    Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
  ),
  before: Schema.optionalKey(Snowflake),
  after: Schema.optionalKey(Snowflake),
  around: Schema.optionalKey(Snowflake),
})

export const messageList = defineTool<typeof ListInput.Type, unknown, DiscordRest>({
  name: 'discord_message_list',
  title: 'List messages in a channel',
  description: [
    'List recent messages, newest first. Pages by snowflake with before/after/around.',
    '',
    'Requires ViewChannel and ReadMessageHistory. If every message comes back with empty content,',
    'that is the MESSAGE_CONTENT intent signature, not empty messages — this server says so.',
  ].join('\n'),
  toolset: 'operator',
  risk: 'read',
  scopes: ['mcp:read'],
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: ListInput,
  handler: (args) =>
    Effect.gen(function* () {
      const rest = yield* DiscordRest
      const query = new URLSearchParams()
      if (args.limit !== undefined) query.set('limit', String(args.limit))
      if (args.before !== undefined) query.set('before', args.before)
      if (args.after !== undefined) query.set('after', args.after)
      if (args.around !== undefined) query.set('around', args.around)

      return yield* rest.request({
        method: 'GET',
        route: `/channels/${args.channelId}/messages`,
        operationFamily: 'message',
        ...(query.size > 0 ? { query } : {}),
      })
    }),
})

// ------------------------------------------------------------------ reactions and pins

const ReactionInput = Schema.Struct({
  channelId: Snowflake,
  messageId: Snowflake,
  emoji: Schema.String.pipe(Schema.check(Schema.isMinLength(1))).annotate({
    description: 'Unicode emoji, or "name:id" for a custom emoji.',
  }),
  action: Schema.Literals(['add', 'remove']),
})

export const messageReactionUpdate = defineTool<typeof ReactionInput.Type, unknown, DiscordRest>({
  name: 'discord_message_reaction_update',
  title: 'Add or remove the bot’s reaction',
  description: [
    'Add or remove this bot’s own reaction on a message.',
    '',
    'Requires AddReactions (and ReadMessageHistory) in the channel. Removing other users’',
    'reactions is a destructive operation and lives behind discord_api_destructive.',
  ].join('\n'),
  toolset: 'operator',
  risk: 'write',
  scopes: ['mcp:write'],
  annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
  input: ReactionInput,
  handler: (args) =>
    Effect.gen(function* () {
      const rest = yield* DiscordRest
      const emoji = encodeURIComponent(args.emoji)
      return yield* rest.request({
        method: args.action === 'add' ? 'PUT' : 'DELETE',
        route: `/channels/${args.channelId}/messages/${args.messageId}/reactions/${emoji}/@me`,
        operationFamily: 'message',
      })
    }),
})

const PinInput = Schema.Struct({
  channelId: Snowflake,
  messageId: Snowflake,
  action: Schema.Literals(['pin', 'unpin']),
})

export const messagePinUpdate = defineTool<typeof PinInput.Type, unknown, DiscordRest>({
  name: 'discord_message_pin_update',
  title: 'Pin or unpin a message',
  description: ['Pin or unpin a message. Requires ManageMessages in the channel.'].join('\n'),
  toolset: 'operator',
  risk: 'write',
  scopes: ['mcp:write'],
  annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
  input: PinInput,
  handler: (args) =>
    Effect.gen(function* () {
      const rest = yield* DiscordRest
      return yield* rest.request({
        method: args.action === 'pin' ? 'PUT' : 'DELETE',
        route: `/channels/${args.channelId}/messages/pins/${args.messageId}`,
        operationFamily: 'message',
      })
    }),
})

const CrosspostInput = Schema.Struct({ channelId: Snowflake, messageId: Snowflake })

export const messageCrosspost = defineTool<typeof CrosspostInput.Type, unknown, DiscordRest>({
  name: 'discord_message_crosspost',
  title: 'Publish a message to following channels',
  description: [
    'Publish an announcement-channel message to every channel that follows it.',
    '',
    'Only works in announcement channels. Requires SendMessages for the bot’s own messages, or',
    'ManageMessages for others’. This cannot be undone: followers keep the copy.',
  ].join('\n'),
  toolset: 'operator',
  risk: 'write',
  scopes: ['mcp:write'],
  annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
  input: CrosspostInput,
  handler: (args) =>
    Effect.gen(function* () {
      const rest = yield* DiscordRest
      return yield* rest.request({
        method: 'POST',
        route: `/channels/${args.channelId}/messages/${args.messageId}/crosspost`,
        operationFamily: 'message',
      })
    }),
})

export const messageTools = [
  messageValidate,
  modalValidate,
  messageSend,
  messageEdit,
  messageGet,
  messageList,
  messageReactionUpdate,
  messagePinUpdate,
  messageCrosspost,
]

export const presentationValidators = { validateComponentsV2 }
