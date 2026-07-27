import { Database } from '@discord-mcp/persistence'
import { describe, expect, it } from 'vitest'
import {
  AuditLog,
  MetricsRegistry,
  RetentionManager,
  structuredLogRecord,
} from './observability.js'

describe('control-plane observability', () => {
  it('emits initialized counters and duration count/sum pairs', () => {
    const metrics = new MetricsRegistry()
    metrics.initialize(['discord_mcp_gateway_reconnects_total'])
    metrics.observe('discord_mcp_workflow_duration_milliseconds', 125, {
      outcome: 'succeeded',
    })
    expect(metrics.render()).toContain('discord_mcp_gateway_reconnects_total 0')
    expect(metrics.render()).toContain(
      'discord_mcp_workflow_duration_milliseconds_count{outcome="succeeded"} 1',
    )
    expect(metrics.render()).toContain(
      'discord_mcp_workflow_duration_milliseconds_sum{outcome="succeeded"} 125',
    )
    expect(metrics.snapshot()).toEqual({
      counters: [
        { series: 'discord_mcp_gateway_reconnects_total', value: 0 },
        {
          series: 'discord_mcp_workflow_duration_milliseconds_count{outcome="succeeded"}',
          value: 1,
        },
        {
          series: 'discord_mcp_workflow_duration_milliseconds_sum{outcome="succeeded"}',
          value: 125,
        },
      ],
      gauges: [],
    })
  })

  it('records queryable audit events while recursively redacting credentials and content', () => {
    const database = new Database(':memory:')
    database.migrate()
    const id = new AuditLog(database).record({
      principalId: 'local-administrator',
      action: 'workflow.enable',
      targetType: 'workflow',
      targetId: 'workflow-id',
      requestId: 'request-id',
      detail: {
        nested: {
          authorization: 'Bearer very-secret-token-value',
          messageContent: 'private message',
        },
        safe: 'visible',
      },
      outcome: 'success',
    })
    const row = database.get<{
      action: string
      target_id: string
      request_id: string
      detail_json: string
    }>('SELECT action, target_id, request_id, detail_json FROM audit_log WHERE id = ?', id)
    expect(row).toMatchObject({
      action: 'workflow.enable',
      target_id: 'workflow-id',
      request_id: 'request-id',
    })
    expect(JSON.parse(row?.detail_json ?? '{}')).toEqual({
      nested: {
        authorization: '[redacted]',
        messageContent: '[redacted]',
      },
      safe: 'visible',
    })
    database.close()
  })

  it('builds structured, correlated, recursively redacted stderr records', () => {
    expect(
      structuredLogRecord(
        {
          level: 'info',
          event: 'workflow.execution',
          requestId: 'request-id',
          workflowId: 'workflow-id',
          revision: 2,
          executionId: 'execution-id',
          correlationId: 'correlation-id',
          durationMs: 12,
          outcome: 'success',
          detail: {
            safe: 'visible',
            nested: {
              authorization: `Bearer ${'x'.repeat(40)}`,
              messageContent: 'private',
            },
          },
        },
        new Date('2026-07-27T00:00:00.000Z'),
      ),
    ).toEqual({
      timestamp: '2026-07-27T00:00:00.000Z',
      level: 'info',
      event: 'workflow.execution',
      requestId: 'request-id',
      workflowId: 'workflow-id',
      revision: 2,
      executionId: 'execution-id',
      correlationId: 'correlation-id',
      durationMs: 12,
      outcome: 'success',
      detail: {
        safe: 'visible',
        nested: {
          authorization: '[redacted]',
          messageContent: '[redacted]',
        },
      },
    })
  })

  it('enforces time and per-workflow retention in one cleanup pass', () => {
    const database = new Database(':memory:')
    database.migrate()
    const now = Date.parse('2026-07-27T12:00:00.000Z')
    const old = new Date(now - 8 * 86_400_000).toISOString()
    database.run(
      `INSERT INTO workflows
       (id, owner_principal_id, slug, name, created_at, updated_at)
       VALUES ('workflow-retention', 'local-administrator', 'retention', 'Retention', ?, ?)`,
      old,
      old,
    )
    database.run(
      `INSERT INTO workflow_events
       (workflow_id, event_type, payload_json, correlation_id, received_at)
       VALUES ('workflow-retention', 'manual', '{}', 'old-event', ?)`,
      old,
    )
    database.run(
      `INSERT INTO audit_log
       (id, action, detail_json, outcome, created_at)
       VALUES ('old-audit', 'test', '{}', 'success', ?)`,
      new Date(now - 91 * 86_400_000).toISOString(),
    )
    const result = new RetentionManager(database).run(now)
    expect(result.workflowEvents).toBe(1)
    expect(result.auditEntries).toBe(1)
    database.close()
  })
})
