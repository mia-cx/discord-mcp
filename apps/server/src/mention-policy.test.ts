import { describe, expect, it } from 'vitest'
import { enforceDispatchMentionPolicy } from './mention-policy.js'

describe('raw Discord dispatch mention policy', () => {
  it('injects safe mention defaults into message, forum, and interaction callback bodies', () => {
    expect(
      enforceDispatchMentionPolicy(
        { operationId: 'create_message', body: { content: '@everyone' } },
        false,
      ).body,
    ).toMatchObject({ allowed_mentions: { parse: [], replied_user: false } })
    expect(
      enforceDispatchMentionPolicy(
        {
          operationId: 'create_thread',
          body: { name: 'topic', message: { content: '@here' } },
        },
        false,
      ).body,
    ).toMatchObject({ message: { allowed_mentions: { parse: [] } } })
    expect(
      enforceDispatchMentionPolicy(
        {
          operationId: 'create_interaction_response',
          body: { type: 4, data: { content: '@everyone' } },
        },
        false,
      ).body,
    ).toMatchObject({ data: { allowed_mentions: { parse: [] } } })
  })

  it('rejects broad parsing unless explicitly authorized', () => {
    const input = {
      operationId: 'create_message',
      body: { content: '@everyone', allowed_mentions: { parse: ['everyone'] } },
    }
    expect(() => enforceDispatchMentionPolicy(input, false)).toThrow(/mentions:broad/)
    expect(enforceDispatchMentionPolicy(input, true).body).toMatchObject({
      allowed_mentions: { parse: ['everyone'], replied_user: false },
    })
  })
})
