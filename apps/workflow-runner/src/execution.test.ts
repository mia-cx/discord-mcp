import { Effect } from '@discord-mcp/workflow-sdk'
import { describe, expect, it } from 'vitest'
import { resolveWorkflowResult, serializeWorkflowFailure } from './execution.js'

describe('workflow result execution', () => {
  it('executes Effect handlers rather than serializing the Effect value', async () => {
    let ran = false
    const result = await resolveWorkflowResult(
      Effect.sync(() => {
        ran = true
        return { accepted: true }
      }),
    )
    expect(ran).toBe(true)
    expect(result).toEqual({ accepted: true })
  })

  it('supports Promise and plain-value handlers', async () => {
    await expect(resolveWorkflowResult(Promise.resolve('async'))).resolves.toBe('async')
    await expect(resolveWorkflowResult('sync')).resolves.toBe('sync')
  })

  it('propagates Effect failures to the runner response boundary', async () => {
    await expect(resolveWorkflowResult(Effect.fail(new Error('effect failed')))).rejects.toThrow(
      /effect failed/,
    )
  })

  it('serializes tagged capability failures without losing retryability', () => {
    expect(
      serializeWorkflowFailure(
        Object.assign(new Error('grant denied'), {
          name: 'CapabilityDenied',
          tag: 'CapabilityDenied',
          retryable: false,
        }),
      ),
    ).toEqual({
      tag: 'CapabilityDenied',
      message: 'grant denied',
      retryable: false,
    })
  })
})
