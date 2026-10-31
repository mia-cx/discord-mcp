import { builtinModules, createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, type Message, type Plugin } from 'esbuild'

const runtimeFile = (name: string) => fileURLToPath(new URL(`../runtime/${name}`, import.meta.url))

const DISCORD_JS = createRequire(import.meta.url).resolve('discord.js')
const NODE_MODULES = '/node_modules/'

/**
 * The only files a bundle may contain: the runtime shims and installed packages. esbuild expands a
 * glob import such as `import(\`./${name}.json\`)` without asking any plugin, so this is checked
 * on the result rather than at resolution.
 */
const ALLOWED_ROOTS = [
  runtimeFile(''),
  DISCORD_JS.slice(0, DISCORD_JS.indexOf(NODE_MODULES) + NODE_MODULES.length),
]

const SCRIPT_MODULE = 'textile:script'
const NODE_BUILTINS = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)])

/** A script that did not bundle, with esbuild's messages as `file:line: text` lines. */
export class ScriptBuildError extends Error {
  constructor(readonly issues: ReadonlyArray<string>) {
    super('The script did not build.')
    this.name = 'ScriptBuildError'
  }
}

const describeMessage = ({ text, location }: Message) =>
  location === null ? text : `script.ts:${location.line}:${location.column + 1}: ${text}`

/**
 * Serves the agent's source as `textile:script` and keeps its imports to `discord.js` and Node
 * built-ins, so a script cannot reach into whatever else is installed next to the relay.
 */
const scriptSource = (source: string): Plugin => ({
  name: 'textile-script',
  setup(build) {
    build.onResolve({ filter: /^textile:script$/ }, () => ({
      path: SCRIPT_MODULE,
      namespace: 'textile-script',
    }))
    build.onLoad({ filter: /.*/, namespace: 'textile-script' }, () => ({
      contents: source,
      loader: 'ts',
    }))
    build.onResolve({ filter: /.*/, namespace: 'textile-script' }, ({ path }) => {
      if (path === 'discord.js') return { path: runtimeFile('shim.js') }
      if (NODE_BUILTINS.has(path)) return { path, external: true }
      return {
        errors: [{ text: `Cannot import "${path}". Scripts can import discord.js and node:*.` }],
      }
    })
  },
})

/**
 * Bundle agent source with discord.js and the shim into one ES module for workerd.
 *
 * Plain esbuild, no wrangler: Node built-ins stay external and resolve to workerd's own
 * `nodejs_compat` modules; the banner gives discord.js's CommonJS `require` calls something to call.
 */
export const bundleScript = async (source: string): Promise<string> => {
  const result = await build({
    entryPoints: [runtimeFile('entry.js')],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    target: 'es2023',
    conditions: ['workerd', 'worker', 'browser', 'import'],
    mainFields: ['browser', 'module', 'main'],
    external: [...NODE_BUILTINS],
    alias: {
      'discord.js': runtimeFile('shim.js'),
      'discord.js-real': DISCORD_JS,
      undici: runtimeFile('undici.js'),
    },
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire('/');",
    },
    plugins: [scriptSource(source)],
    absWorkingDir: runtimeFile(''),
    metafile: true,
    logLevel: 'silent',
  }).catch((error: { errors?: ReadonlyArray<Message> }) => {
    if (error.errors === undefined) throw error
    throw new ScriptBuildError(error.errors.map(describeMessage))
  })
  const outside = Object.keys(result.metafile.inputs).filter((input) => {
    if (input.startsWith('textile-script:')) return false
    const file = resolve(runtimeFile(''), input)
    return !ALLOWED_ROOTS.some((root) => file.startsWith(root))
  })
  if (outside.length > 0) {
    throw new ScriptBuildError(
      outside.map((input) => `Cannot import "${input}". Scripts can import discord.js and node:*.`),
    )
  }
  const [output] = result.outputFiles
  if (output === undefined) throw new Error('esbuild produced no output.')
  return output.text
}
