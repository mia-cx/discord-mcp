import { describe, expect, it } from 'vitest'
import { bundleScript, ScriptBuildError } from '../src/bundle.ts'

describe('bundling a script', () => {
  it('bundles discord.js imports', async () => {
    await expect(
      bundleScript(`import { EmbedBuilder } from 'discord.js'
        export default () => new EmbedBuilder().setTitle('ok').toJSON()`),
    ).resolves.toContain('EmbedBuilder')
  })

  it.each([
    ['an installed package', `import x from 'esbuild'; export default () => x`],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: script source; the isolate interpolates it.
    ['a glob import of host files', 'export default () => import(`../${String()}package.json`)'],
  ])('refuses %s', async (_, source) => {
    await expect(bundleScript(source)).rejects.toBeInstanceOf(ScriptBuildError)
  })
})
