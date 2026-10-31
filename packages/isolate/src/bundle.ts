import { readFile } from 'node:fs/promises'
import { builtinModules, createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build, type Message, transform } from 'esbuild'

const runtimeFile = (name: string) => fileURLToPath(new URL(`../runtime/${name}`, import.meta.url))

const NODE_BUILTINS = [...builtinModules, ...builtinModules.map((m) => `node:${m}`)]

/** One module in an isolate's workerd config. */
export interface ScriptModule {
  readonly name: string
  readonly type: 'esModule' | 'commonJsModule'
  readonly source: string
}

/** A script that did not compile, with esbuild's messages as `file:line: text` lines. */
export class ScriptBuildError extends Error {
  constructor(readonly issues: ReadonlyArray<string>) {
    super('The script did not build.')
    this.name = 'ScriptBuildError'
  }
}

/** esbuild names the output format; an agent needs to know what to change instead. */
const TOP_LEVEL_AWAIT = /^Top-level await is currently not supported/

const describeMessage = ({ text, location }: Message) => {
  const reason = TOP_LEVEL_AWAIT.test(text)
    ? 'Top-level await is not supported; await inside the default export instead.'
    : text
  return location === null ? reason : `script.ts:${location.line}:${location.column + 1}: ${reason}`
}

/**
 * discord.js with the shim's Client, bundled once per process as a CommonJS module. CommonJS, so a
 * script's named imports become property reads and need no static export list.
 */
let runtime: Promise<ReadonlyArray<ScriptModule>> | undefined
const loadRuntime = () => {
  runtime ??= Promise.all([
    readFile(runtimeFile('entry.js'), 'utf8'),
    build({
      entryPoints: [runtimeFile('shim.js')],
      bundle: true,
      write: false,
      format: 'cjs',
      platform: 'neutral',
      target: 'es2023',
      conditions: ['workerd', 'worker', 'browser', 'require'],
      mainFields: ['browser', 'module', 'main'],
      external: NODE_BUILTINS,
      alias: {
        'discord.js-real': createRequire(import.meta.url).resolve('discord.js'),
        undici: runtimeFile('undici.js'),
      },
      logLevel: 'silent',
    }),
  ]).then(([entry, shim]): ReadonlyArray<ScriptModule> => {
    const [output] = shim.outputFiles
    if (output === undefined) throw new Error('esbuild produced no output.')
    return [
      { name: 'entry.js', type: 'esModule', source: entry },
      { name: 'discord.js', type: 'commonJsModule', source: output.text },
    ]
  })
  return runtime
}

/**
 * Compile agent source into the modules an isolate runs: the entry, discord.js, and the script.
 *
 * The script is only transformed, never bundled, so its imports never reach a filesystem: inside
 * workerd, `require` and `import()` resolve only these modules and Node built-ins.
 */
export const prepareScript = async (source: string): Promise<ReadonlyArray<ScriptModule>> => {
  const script = await transform(source, {
    loader: 'ts',
    format: 'cjs',
    target: 'es2023',
    // Compiles `import()` to `require()` too, or a CommonJS module's namespace hides its names.
    supported: { 'dynamic-import': false },
    logLevel: 'silent',
  }).catch((error: { errors?: ReadonlyArray<Message> }) => {
    if (error.errors === undefined) throw error
    throw new ScriptBuildError(error.errors.map(describeMessage))
  })
  return [
    ...(await loadRuntime()),
    { name: 'script.js', type: 'commonJsModule', source: script.code },
  ]
}
