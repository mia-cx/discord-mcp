import { describe, expect, it } from 'vitest'
import { bundleScript } from '../src/bundle.ts'
import { makeIsolateHost, type ScriptExecution } from '../src/isolate-host.ts'

const execution = async (
  botId: string,
  source: string,
  timeoutMs: number,
): Promise<ScriptExecution> => ({
  botId,
  botUser: { id: botId, username: `bot-${botId}`, discriminator: '0', bot: true },
  bundle: await bundleScript(source),
  timeoutMs,
  broker: async () => new Response(null, { status: 404 }),
})

describe('the isolate host', () => {
  it('kills a runaway script at its deadline while another bot keeps answering', async () => {
    const host = makeIsolateHost()
    const spin = await execution('1', 'export default () => { for (;;) {} }', 2000)
    const answer = await execution('2', 'export default ({ client }) => client.user.username', 2000)

    let spun = false
    const spinning = host.run(spin).finally(() => {
      spun = true
    })
    const answered = await host.run(answer)

    expect(answered).toEqual({ outcome: 'completed', result: 'bot-2', logs: [] })
    expect(spun).toBe(false)
    expect(await spinning).toEqual({ outcome: 'timed_out', timeoutMs: 2000 })

    // The same bot runs again: the killed process took nothing with it.
    const recovered = await host.run(await execution('1', 'export default () => "back"', 2000))
    expect(recovered).toEqual({ outcome: 'completed', result: 'back', logs: [] })
  })
})
