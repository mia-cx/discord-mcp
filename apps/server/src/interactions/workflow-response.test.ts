import { Database } from '@discord-mcp/persistence'
import { describe, expect, it } from 'vitest'
import { workflowInteractionCallback } from './workflow-response.js'

describe('workflow interaction responses', () => {
  it('accepts SDK autocomplete responses and rejects raw callback bypasses', () => {
    expect(
      workflowInteractionCallback({
        __autocompleteResponse: [
          { name: 'Production', value: 'production' },
          { name: 'Canary', value: 1 },
        ],
      }),
    ).toEqual({
      type: 8,
      data: {
        choices: [
          { name: 'Production', value: 'production' },
          { name: 'Canary', value: 1 },
        ],
      },
    })
    expect(() =>
      workflowInteractionCallback({ type: 4, data: { content: 'unvalidated bypass' } }),
    ).toThrow(/must return Discord/)
  })

  it('encodes presentations and binds components to the exact workflow revision', () => {
    const database = new Database(':memory:')
    database.migrate()
    const callback = workflowInteractionCallback(
      {
        __interactionResponse: {
          ephemeral: true,
          presentation: {
            type: 'components_v2',
            components: [
              {
                type: 'actionRow',
                components: [
                  {
                    type: 'button',
                    style: 'primary',
                    label: 'Approve',
                    action: { type: 'workflow', key: 'approve' },
                  },
                ],
              },
            ],
          },
        },
      },
      { database, workflowId: 'workflow-owner', revision: 7 },
    )
    expect(callback).toMatchObject({ type: 4, data: { flags: 32_768 | 64 } })
    expect(
      database.get<{
        owner_id: string
        owner_revision: number
        action_key: string
      }>('SELECT owner_id, owner_revision, action_key FROM component_bindings'),
    ).toEqual({
      owner_id: 'workflow-owner',
      owner_revision: 7,
      action_key: 'approve',
    })
    database.close()
  })
})
