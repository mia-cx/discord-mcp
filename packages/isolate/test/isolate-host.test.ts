import { describe, expect, it } from 'vitest'
import { prepareScript } from '../src/bundle.ts'
import { makeIsolateHost, type ScriptExecution } from '../src/isolate-host.ts'

const execution = async (
  botId: string,
  source: string,
  timeoutMs: number,
): Promise<ScriptExecution> => ({
  botId,
  botUser: { id: botId, username: `bot-${botId}`, discriminator: '0', bot: true },
  modules: await prepareScript(source),
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

  it('reports a script that never settles, or exhausts its heap, as crashed', async () => {
    const host = makeIsolateHost()
    const waiting = await execution('1', 'export default () => new Promise(() => {})', 5000)
    const hog = await execution(
      '2',
      'export default () => { const a = []; for (;;) a.push(new Array(1e6).fill(1)) }',
      20_000,
    )

    const [never, oom] = await Promise.all([host.run(waiting), host.run(hog)])

    expect(never.outcome).toBe('crashed')
    expect(oom.outcome).toBe('crashed')
  })

  it('gives a script no way to read host files', async () => {
    const run = await makeIsolateHost().run(
      await execution(
        '1',
        `import { readFileSync } from 'node:fs'
        const attempt = async (read) => { try { return JSON.stringify(await read()) } catch (error) { return 'refused' } }
        export default async () => [
          await attempt(() => import('../../' + String() + 'package.json', { with: { type: 'json' } })),
          await attempt(() => require('../../../package.json')),
          await attempt(() => readFileSync('${process.cwd()}/package.json', 'utf8')),
        ]`,
        5000,
      ),
    )

    expect(run).toEqual({
      outcome: 'completed',
      result: ['refused', 'refused', 'refused'],
      logs: [],
    })
  })

  it('gives a dynamic import of discord.js its named exports', async () => {
    const run = await makeIsolateHost().run(
      await execution(
        '1',
        `export default async () => {
          const { EmbedBuilder } = await import('discord.js')
          return new EmbedBuilder().setTitle('dynamic').toJSON()
        }`,
        5000,
      ),
    )

    expect(run).toEqual({ outcome: 'completed', result: { title: 'dynamic' }, logs: [] })
  })

  it('returns a large result with multi-byte characters intact', async () => {
    const run = await makeIsolateHost().run(
      await execution('1', `export default () => '€'.repeat(200000)`, 5000),
    )

    expect(run).toEqual({ outcome: 'completed', result: '€'.repeat(200000), logs: [] })
  })
})
