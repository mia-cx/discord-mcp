import { describe, expect, it } from 'vitest'
import { prepareScript, ScriptBuildError } from '../src/bundle.ts'

describe('preparing a script', () => {
  it('compiles TypeScript that imports discord.js', async () => {
    const modules = await prepareScript(`import { EmbedBuilder } from 'discord.js'
      export default (): unknown => new EmbedBuilder().setTitle('ok').toJSON()`)

    expect(modules.map((module) => module.name)).toEqual([
      'entry.js',
      'discord.js',
      'textile',
      'script.js',
    ])
  })

  it.each([
    ['a syntax error', 'export default async ( => 1', /^script\.ts:1:\d+: /],
    [
      'top-level await',
      "const value = await Promise.resolve('ok')\nexport default () => value",
      /await inside the default export/,
    ],
  ])('refuses %s with a reason an agent can act on', async (_, source, issue) => {
    const failure = prepareScript(source)

    await expect(failure).rejects.toBeInstanceOf(ScriptBuildError)
    await expect(failure).rejects.toMatchObject({ issues: [expect.stringMatching(issue)] })
  })
})
