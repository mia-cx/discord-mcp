import { describe, expect, it } from 'vitest'
import {
  type BlueprintActionExecutor,
  BlueprintApplier,
  BlueprintApplyError,
  MemoryBlueprintJournal,
} from './apply.js'
import type { BlueprintPlan } from './types.js'

const plan: BlueprintPlan = {
  blueprintDigest: 'blueprint',
  snapshotDigest: 'snapshot',
  destructive: false,
  warnings: [],
  actions: [
    { type: 'role.create', key: 'member', desired: { key: 'member', name: 'Member' } },
    {
      type: 'channel.create',
      key: 'general',
      desired: { key: 'general', kind: 'text', name: 'general' },
    },
  ],
}

describe('blueprint apply journal', () => {
  it('persists partial progress and resumes without replaying completed mutations', async () => {
    const calls: Array<string> = []
    let fail = true
    const executor: BlueprintActionExecutor = {
      execute: async (action) => {
        calls.push(action.type)
        if (action.type === 'channel.create' && fail) {
          fail = false
          throw new Error('temporary Discord failure')
        }
        return { id: `${action.type}-id` }
      },
    }
    const journal = new MemoryBlueprintJournal()
    const applier = new BlueprintApplier(journal, executor)
    let executionId = ''
    try {
      await applier.apply(plan)
    } catch (cause) {
      expect(cause).toBeInstanceOf(BlueprintApplyError)
      executionId = (cause as BlueprintApplyError).execution.id
    }
    const resumed = await applier.apply(plan, executionId)
    expect(resumed.status).toBe('completed')
    expect(calls).toEqual(['role.create', 'channel.create', 'channel.create'])
    expect(resumed.actions.every(({ status }) => status === 'completed')).toBe(true)
  })

  it('refuses to resume a changed action list', async () => {
    const journal = new MemoryBlueprintJournal()
    const execution = journal.create(plan)
    const applier = new BlueprintApplier(journal, { execute: async () => ({}) })
    await expect(applier.apply({ ...plan, actions: [] }, execution.id)).rejects.toThrow(
      /plan changed/,
    )
  })
})
