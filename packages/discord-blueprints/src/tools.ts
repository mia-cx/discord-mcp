import { defineTool, McpRequestContext, Snowflake, ValidationError } from '@discord-mcp/core'
import { type DiscordRest, hashArguments, PreviewTokens } from '@discord-mcp/discord-api'
import { AuditRepository, BlueprintRepository, RevisionRepository } from '@discord-mcp/persistence'
import { Effect, Schema } from 'effect'
import { applyBlueprint } from './apply.ts'
import { planBlueprint } from './plan.ts'
import { Blueprint } from './schema.ts'
import { describeSnapshot, readGuildSnapshot } from './snapshot.ts'

type Deps = DiscordRest | BlueprintRepository | RevisionRepository | AuditRepository | PreviewTokens

const BlueprintId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-z0-9][a-z0-9_-]{0,63}$/, { title: 'blueprint id' })),
)

// ---------------------------------------------------------------- snapshot

const SnapshotInput = Schema.Struct({ guildId: Snowflake })

export const serverSnapshot = defineTool<typeof SnapshotInput.Type, unknown, DiscordRest>({
  name: 'discord_server_snapshot',
  title: 'Read a guild’s current structure',
  description: [
    'Read the guild as it is now: roles with named permission flags, channels, positions, parents,',
    'and overwrites, plus the bot’s own ceiling (highest role position and effective permissions).',
    '',
    'Returns a snapshotDigest. A blueprint apply binds that digest, so an apply planned against one',
    'state cannot execute against another — the case where someone reorganises the guild in between.',
    'Read-only.',
  ].join('\n'),
  toolset: 'operator',
  risk: 'read',
  scopes: ['mcp:read'],
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: SnapshotInput,
  handler: (args) => Effect.map(readGuildSnapshot(args.guildId), describeSnapshot),
})

// ---------------------------------------------------------------- draft and publish

const DraftInput = Schema.Struct({
  blueprintId: BlueprintId,
  name: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(100))),
  blueprint: Blueprint,
})

export const blueprintUpdateDraft = defineTool<typeof DraftInput.Type, unknown, RevisionRepository>(
  {
    name: 'discord_server_blueprint_update_draft',
    title: 'Create or update a blueprint draft',
    description: [
      'Save a blueprint draft. Drafts are mutable and grant nothing; only a published revision can be',
      'planned or applied.',
      '',
      'Roles and channels carry stable logical keys rather than being matched by name — a rename then',
      'preserves identity instead of creating a duplicate. Permissions are named flags, never bitfields.',
    ].join('\n'),
    toolset: 'admin',
    risk: 'write',
    scopes: ['server:plan'],
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
    input: DraftInput,
    handler: (args) =>
      Effect.gen(function* () {
        const repo = yield* RevisionRepository
        yield* repo.saveDraft('server_blueprints', {
          id: args.blueprintId,
          name: args.name,
          draft: args.blueprint,
        })
        return { blueprintId: args.blueprintId, saved: true }
      }),
  },
)

const PublishInput = Schema.Struct({ blueprintId: BlueprintId })

export const blueprintPublish = defineTool<
  typeof PublishInput.Type,
  unknown,
  RevisionRepository | AuditRepository
>({
  name: 'discord_server_blueprint_publish',
  title: 'Freeze a blueprint draft as an immutable revision',
  description: [
    'Publish the current draft as a numbered revision.',
    '',
    'Published revisions are immutable, which is what lets a preview token bind a specific revision',
    'digest: an apply cannot silently target desired state that was edited after it was previewed.',
    'Editing after publishing creates a new draft; it never changes a published revision.',
  ].join('\n'),
  toolset: 'admin',
  risk: 'write',
  scopes: ['server:plan'],
  annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false },
  input: PublishInput,
  handler: (args) =>
    Effect.gen(function* () {
      const revisions = yield* RevisionRepository
      const audit = yield* AuditRepository
      const { principal } = yield* McpRequestContext

      const draft = yield* loadDraft(args.blueprintId)
      const published = yield* revisions.publish('server_blueprints', {
        id: args.blueprintId,
        name: args.blueprintId,
        body: draft,
        publishedBy: principal.id,
      })

      yield* audit.record({
        principalId: principal.id,
        action: 'blueprint.publish',
        subjectKind: 'blueprint',
        subjectId: args.blueprintId,
        outcome: 'allowed',
        detail: published,
      })

      return { blueprintId: args.blueprintId, ...published }
    }),
})

const loadDraft = (blueprintId: string) =>
  Effect.gen(function* () {
    const revisions = yield* RevisionRepository
    const draft = yield* revisions.getDraft('server_blueprints', blueprintId)
    if (draft === undefined) {
      return yield* Effect.fail(
        new ValidationError({
          message: `Blueprint "${blueprintId}" has no draft to publish.`,
          issues: ['blueprintId: call discord_server_blueprint_update_draft first.'],
        }),
      )
    }
    // Validate before freezing. A revision is immutable, so publishing something unrepresentable
    // would leave a permanently unusable revision behind.
    return yield* Schema.decodeUnknownEffect(Blueprint, { errors: 'all' })(draft)
  })

// ---------------------------------------------------------------- plan

const PlanInputSchema = Schema.Struct({
  blueprintId: BlueprintId,
  guildId: Snowflake,
  revision: Schema.optionalKey(
    Schema.Int.annotate({ description: 'Defaults to the latest published revision.' }),
  ),
  deleteManaged: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        'Allow deletion of objects this blueprint marks absent. Off by default; applying deletions also requires mcp:destructive.',
    }),
  ),
})

export const blueprintPlan = defineTool<typeof PlanInputSchema.Type, unknown, Deps>({
  name: 'discord_server_blueprint_plan',
  title: 'Plan a blueprint against a guild',
  description: [
    'Compare a published blueprint revision against a guild and return an ordered diff. This never',
    'mutates Discord.',
    '',
    'Reports blockers at plan time rather than mid-apply: a role at or above the bot’s highest, a',
    'permission the bot does not hold and so cannot grant, a channel whose type cannot be converted.',
    'Reapplying a converged blueprint yields zero actions. Unmanaged resources are never touched.',
    '',
    'Returns a preview token bound to the blueprint revision AND the current guild snapshot, so a',
    'stale plan cannot be applied. Requires server:plan.',
  ].join('\n'),
  toolset: 'admin',
  risk: 'read',
  scopes: ['server:plan'],
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: PlanInputSchema,
  handler: (args) =>
    Effect.gen(function* () {
      const { blueprint, revision } = yield* loadPublishedRevision(args.blueprintId, args.revision)
      const repo = yield* BlueprintRepository
      const tokens = yield* PreviewTokens
      const { principal } = yield* McpRequestContext

      const snapshot = yield* readGuildSnapshot(args.guildId)
      const bindings = yield* repo.bindings(args.blueprintId, args.guildId)

      const plan = planBlueprint({
        blueprint,
        snapshot: snapshot.snapshot,
        bindings,
        botPermissions: snapshot.botPermissions,
        botHighestRolePosition: snapshot.botHighestRolePosition,
        ...(args.deleteManaged === undefined ? {} : { deleteManaged: args.deleteManaged }),
      })

      // No token when the plan cannot run: issuing one would invite an apply that fails anyway.
      if (plan.blockers.length > 0 || plan.converged) {
        return {
          blueprintId: args.blueprintId,
          revision,
          guildId: args.guildId,
          converged: plan.converged,
          actions: plan.actions,
          blockers: plan.blockers,
          warnings: plan.warnings,
          ...(plan.converged
            ? { note: 'The guild already matches this blueprint. There is nothing to apply.' }
            : {
                note: 'Resolve the blockers before applying. No preview token was issued because this plan cannot succeed as it stands.',
              }),
        }
      }

      const { token, expiresAt } = yield* tokens.issue({
        principalId: principal.id,
        operationId: `blueprint.apply:${args.blueprintId}`,
        authProfile: 'bot',
        // Binding both digests is what makes a stale apply impossible: either the desired state or
        // the guild changing invalidates the token.
        argumentHash: hashArguments({
          blueprintId: args.blueprintId,
          revision,
          guildId: args.guildId,
          snapshotDigest: snapshot.digest,
          deleteManaged: args.deleteManaged ?? false,
        }),
        targets: [args.guildId],
      })

      return {
        blueprintId: args.blueprintId,
        revision,
        guildId: args.guildId,
        guildName: snapshot.guildName,
        snapshotDigest: snapshot.digest,
        converged: false,
        actions: plan.actions,
        blockers: [],
        warnings: plan.warnings,
        destructiveActions: plan.actions.filter((a) => a.destructive).length,
        previewToken: token,
        expiresAt: new Date(expiresAt).toISOString(),
        note: 'Show the user this action list before applying. The token expires in 60 seconds and is invalidated by any change to the guild.',
      }
    }),
})

const loadPublishedRevision = (blueprintId: string, requested: number | undefined) =>
  Effect.gen(function* () {
    const revisions = yield* RevisionRepository
    const latest = yield* revisions.latestRevision('server_blueprints', blueprintId)
    const revision = requested ?? latest

    if (revision === 0) {
      return yield* Effect.fail(
        new ValidationError({
          message: `Blueprint "${blueprintId}" has no published revision.`,
          issues: ['blueprintId: publish a draft with discord_server_blueprint_publish first.'],
        }),
      )
    }

    const stored = yield* revisions.getRevision('server_blueprints', blueprintId, revision)
    if (stored === undefined) {
      return yield* Effect.fail(
        new ValidationError({
          message: `Blueprint "${blueprintId}" has no revision ${revision}.`,
          issues: [`revision: the latest published revision is ${latest}.`],
        }),
      )
    }

    const blueprint = yield* Schema.decodeUnknownEffect(Blueprint, { errors: 'all' })(stored.body)
    return { blueprint, revision, digest: stored.digest }
  })

// ---------------------------------------------------------------- apply

const ApplyInputSchema = Schema.Struct({
  blueprintId: BlueprintId,
  guildId: Snowflake,
  revision: Schema.optionalKey(Schema.Int),
  deleteManaged: Schema.optionalKey(Schema.Boolean),
  previewToken: Schema.String,
  auditLogReason: Schema.optionalKey(Schema.String.pipe(Schema.check(Schema.isMaxLength(512)))),
})

export const blueprintApply = defineTool<typeof ApplyInputSchema.Type, unknown, Deps>({
  name: 'discord_server_blueprint_apply',
  title: 'Apply a blueprint to a guild',
  description: [
    'Execute a planned blueprint. Requires server:apply and an unexpired preview token from',
    'discord_server_blueprint_plan bound to this blueprint revision, guild, and guild snapshot.',
    '',
    'Discord has no transactions, so every action is journalled before it runs. A partial failure',
    'returns what completed, what failed and why, and what was not attempted — and already-created',
    'objects are bound immediately, so re-planning after a fix will not duplicate them.',
    'Deleting managed objects additionally requires mcp:destructive.',
  ].join('\n'),
  toolset: 'admin',
  risk: 'write',
  scopes: ['server:apply'],
  annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
  input: ApplyInputSchema,
  handler: (args) =>
    Effect.gen(function* () {
      const { blueprint, revision } = yield* loadPublishedRevision(args.blueprintId, args.revision)
      const repo = yield* BlueprintRepository
      const tokens = yield* PreviewTokens
      const audit = yield* AuditRepository
      const { principal } = yield* McpRequestContext

      if (args.deleteManaged === true && !principal.scopes.has('mcp:destructive')) {
        return yield* Effect.fail(
          new ValidationError({
            message: 'Deleting managed objects requires the mcp:destructive scope.',
            issues: ['deleteManaged: this principal does not hold mcp:destructive.'],
          }),
        )
      }

      // Re-read the guild. If anything changed since the plan, the digest differs and the token
      // will not redeem — which is the entire point of binding it.
      const snapshot = yield* readGuildSnapshot(args.guildId)

      yield* tokens.redeem(args.previewToken, {
        principalId: principal.id,
        operationId: `blueprint.apply:${args.blueprintId}`,
        authProfile: 'bot',
        argumentHash: hashArguments({
          blueprintId: args.blueprintId,
          revision,
          guildId: args.guildId,
          snapshotDigest: snapshot.digest,
          deleteManaged: args.deleteManaged ?? false,
        }),
        targets: [args.guildId],
      })

      const bindings = yield* repo.bindings(args.blueprintId, args.guildId)
      const plan = planBlueprint({
        blueprint,
        snapshot: snapshot.snapshot,
        bindings,
        botPermissions: snapshot.botPermissions,
        botHighestRolePosition: snapshot.botHighestRolePosition,
        ...(args.deleteManaged === undefined ? {} : { deleteManaged: args.deleteManaged }),
      })

      const outcome = yield* applyBlueprint({
        blueprintId: args.blueprintId,
        revision,
        guildId: args.guildId,
        blueprint,
        actions: plan.actions,
        snapshotDigest: snapshot.digest,
        principalId: principal.id,
        auditLogReason:
          args.auditLogReason ?? `discord-mcp blueprint ${args.blueprintId} r${revision}`,
      })

      yield* audit.record({
        principalId: principal.id,
        action: 'blueprint.apply',
        subjectKind: 'guild',
        subjectId: args.guildId,
        outcome: outcome.status === 'completed' ? 'allowed' : 'failed',
        detail: { blueprintId: args.blueprintId, revision, status: outcome.status },
      })

      return outcome
    }),
})

export const blueprintTools = [
  serverSnapshot,
  blueprintUpdateDraft,
  blueprintPublish,
  blueprintPlan,
  blueprintApply,
]
