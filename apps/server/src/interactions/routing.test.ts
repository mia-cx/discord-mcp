import { Database } from '@discord-mcp/persistence'
import { describe, expect, it } from 'vitest'
import { persistComponentEvent, resolveInteractionTarget } from './routing.js'

describe('interaction ownership routing', () => {
  it('routes commands by the registered Discord command id and guild, never by name alone', () => {
    const database = new Database(':memory:')
    database.migrate()
    const now = new Date().toISOString()
    database.run(
      "INSERT INTO principals(id, name, kind, created_at) VALUES ('owner', 'Owner', 'local', ?)",
      now,
    )
    for (const [id, slug] of [
      ['workflow-a', 'workflow-a'],
      ['workflow-b', 'workflow-b'],
    ] as const) {
      database.run(
        `INSERT INTO workflows
         (id, owner_principal_id, slug, name, enabled_revision, created_at, updated_at)
         VALUES (?, 'owner', ?, ?, 1, ?, ?)`,
        id,
        slug,
        slug,
        now,
        now,
      )
    }
    database.run(
      `INSERT INTO workflow_commands
       (workflow_id, revision, command_key, command_type, discord_command_id, guild_id)
       VALUES
       ('workflow-a', 1, 'deploy', 1, '12345678901234571', '12345678901234570'),
       ('workflow-b', 1, 'deploy', 1, '12345678901234572', '12345678901234570')`,
    )
    expect(
      resolveInteractionTarget(
        database,
        {
          id: '12345678901234573',
          application_id: '12345678901234574',
          guild_id: '12345678901234570',
          type: 2,
          data: { id: '12345678901234572', name: 'deploy' },
        },
        undefined,
      ),
    ).toEqual({
      kind: 'workflow',
      workflowId: 'workflow-b',
      triggerType: 'interactionCommand',
      triggerKey: 'deploy',
    })
    expect(() =>
      resolveInteractionTarget(
        database,
        {
          id: '12345678901234575',
          application_id: '12345678901234574',
          guild_id: '12345678901234576',
          type: 2,
          data: { id: '12345678901234572', name: 'deploy' },
        },
        undefined,
      ),
    ).toThrow(/not owned/)
    database.close()
  })

  it('persists a token-redacted component event in its owning inbox', () => {
    const database = new Database(':memory:')
    database.migrate()
    const now = new Date().toISOString()
    database.run(
      "INSERT INTO principals(id, name, kind, created_at) VALUES ('owner', 'Owner', 'local', ?)",
      now,
    )
    database.run(
      `INSERT INTO component_bindings
       (handle, owner_type, owner_id, action_type, action_key, created_at)
       VALUES ('opaque-handle', 'principal', 'owner', 'event', 'approve', ?)`,
      now,
    )
    const interaction = {
      id: '12345678901234573',
      application_id: '12345678901234574',
      type: 3,
      data: { custom_id: 'opaque-handle' },
    }
    const target = resolveInteractionTarget(database, interaction, {
      ownerType: 'principal',
      ownerId: 'owner',
      actionType: 'event',
      actionKey: 'approve',
    })
    expect(target.kind).toBe('event')
    if (target.kind !== 'event') throw new Error('expected event target')
    persistComponentEvent(database, interaction, target)
    const row = database.get<{
      owner_id: string
      action_key: string
      payload_json: string
    }>('SELECT owner_id, action_key, payload_json FROM component_events')
    expect(row).toMatchObject({ owner_id: 'owner', action_key: 'approve' })
    expect(row?.payload_json).not.toContain('token')
    database.close()
  })
})
