import { defineTool, Metrics } from '@discord-mcp/core'
import { AuditRepository } from '@discord-mcp/persistence'
import { Effect, Schema } from 'effect'
import { EventLog } from './event-log.ts'
import { WorkflowQueues } from './queue.ts'

/**
 * Diagnostics: what the system has been doing, for when something is wrong and nobody knows where.
 *
 * These answer the two questions an operator actually has during an incident — "is anything
 * happening" and "who did this" — without needing a metrics backend to be running.
 */

export const metricsSnapshot = defineTool<Record<string, never>, unknown, Metrics>({
  name: 'metrics_snapshot',
  title: 'Read operational counters',
  description: [
    'Counters and timings since the server started: Discord requests and failures, rate-limit',
    'waits, RateGuard trips, Gateway events and reconnects, interaction deadlines, workflow queue',
    'and execution outcomes, sandbox builds, and route authentication failures.',
    '',
    'Read this before guessing. A workflow that looks stuck is usually either not being triggered',
    'at all or failing every execution, and those two look identical from the outside.',
  ].join('\n'),
  toolset: 'operator',
  risk: 'read',
  scopes: ['mcp:read'],
  annotations: { readOnlyHint: true, openWorldHint: false },
  input: Schema.Struct({}),
  handler: () =>
    Effect.flatMap(Metrics, (metrics) =>
      Effect.map(metrics.snapshot, (snapshot) => ({
        ...snapshot,
        // Averages computed here rather than stored, so the raw totals stay honest.
        timings: Object.fromEntries(
          Object.entries(snapshot.timings).map(([name, timing]) => [
            name,
            {
              ...timing,
              averageMs: timing.count === 0 ? 0 : Math.round(timing.totalMs / timing.count),
            },
          ]),
        ),
      })),
    ),
})

const QueueInput = Schema.Struct({
  workflowId: Schema.String.annotate({
    description: 'The workflow’s ID, not its slug. Read it from workflow_get.',
  }),
})

export const workflowQueueDepth = defineTool<typeof QueueInput.Type, unknown, WorkflowQueues>({
  name: 'workflow_queue_depth',
  title: 'Inspect a workflow’s queue',
  description: [
    'How many events are waiting, how many handlers are running, and how many events were dropped',
    'because the queue was full.',
    '',
    'A non-zero drop count means the workflow is not keeping up: raise runtime.concurrency, make',
    'the handler faster, or narrow the events it subscribes to.',
  ].join('\n'),
  toolset: 'automation',
  gate: 'workflows',
  risk: 'read',
  scopes: ['workflow:read'],
  annotations: { readOnlyHint: true, openWorldHint: false },
  input: QueueInput,
  handler: (args) => Effect.flatMap(WorkflowQueues, (queues) => queues.depth(args.workflowId)),
})

const AuditInput = Schema.Struct({
  limit: Schema.optionalKey(
    Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 200 }))),
  ).annotate({ description: 'Defaults to 50.' }),
  since: Schema.optionalKey(Schema.Int).annotate({
    description: 'Epoch milliseconds. Entries recorded at or after this time.',
  }),
})

export const auditTail = defineTool<typeof AuditInput.Type, unknown, AuditRepository>({
  name: 'audit_tail',
  title: 'Read the audit log',
  description: [
    'Recent audited actions: authentication and token administration, OAuth profile changes,',
    'destructive previews and calls, bot-administration changes, every workflow lifecycle',
    'transition, blueprint plan and apply, template publication, and sandbox policy violations.',
    '',
    'Each entry records the principal, the subject, and the outcome. Retained for 90 days.',
  ].join('\n'),
  toolset: 'admin',
  risk: 'read',
  scopes: ['audit:read'],
  annotations: { readOnlyHint: true, openWorldHint: false },
  input: AuditInput,
  handler: (args) =>
    Effect.flatMap(AuditRepository, (repository) =>
      repository.list({
        limit: args.limit ?? 50,
        ...(args.since === undefined ? {} : { since: args.since }),
      }),
    ),
})

const EventsInput = Schema.Struct({
  cursor: Schema.optionalKey(Schema.Int).annotate({
    description:
      'Return events after this sequence. Pass back the cursor from the previous call; it survives a restart.',
  }),
  eventTypes: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
    description: 'Gateway event type names, such as MESSAGE_CREATE. Omit for every type.',
  }),
  guildId: Schema.optionalKey(Schema.String),
  limit: Schema.optionalKey(
    Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 200 }))),
  ).annotate({ description: 'Defaults to 50.' }),
})

export const eventsTail = defineTool<typeof EventsInput.Type, unknown, EventLog>({
  name: 'events_tail',
  title: 'Tail the persistent event log',
  description: [
    'Gateway events this server recorded, after a cursor. Records are durable, so a cursor still',
    'means something after a restart and nothing is lost if the connection drops.',
    '',
    'This is the durable log; discord_gateway_recent_events reads the in-memory ring, which is',
    'bounded and does not survive a restart. Events are retained for seven days.',
    '',
    'An event here never starts a new turn on its own — read it when the user asks.',
  ].join('\n'),
  toolset: 'automation',
  gate: 'gateway',
  risk: 'read',
  scopes: ['mcp:read'],
  annotations: { readOnlyHint: true, openWorldHint: false },
  input: EventsInput,
  handler: (args) =>
    Effect.flatMap(EventLog, (log) =>
      log.read({
        limit: args.limit ?? 50,
        ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
        ...(args.eventTypes === undefined ? {} : { eventTypes: args.eventTypes }),
        ...(args.guildId === undefined ? {} : { guildId: args.guildId }),
      }),
    ),
})

export const diagnosticsTools = [metricsSnapshot, workflowQueueDepth, auditTail, eventsTail]
