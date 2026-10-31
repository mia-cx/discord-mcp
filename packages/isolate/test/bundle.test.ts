import { describe, expect, it } from 'vitest'
import { prepareScript, ScriptBuildError } from '../src/bundle.ts'

describe('preparing a script', () => {
  it('compiles TypeScript that imports discord.js', async () => {
    const modules = await prepareScript(`import { EmbedBuilder } from 'discord.js'
      export default (): unknown => new EmbedBuilder().setTitle('ok').toJSON()`)

    expect(modules.map((module) => module.name)).toEqual(['entry.js', 'discord.js', 'script.js'])
  })

  it('reports a syntax error with its location', async () => {
    const failure = prepareScript('export default async ( => 1')

    await expect(failure).rejects.toBeInstanceOf(ScriptBuildError)
    await expect(failure).rejects.toMatchObject({
      issues: [expect.stringMatching(/^script.ts:1:/)],
    })
  })
})
