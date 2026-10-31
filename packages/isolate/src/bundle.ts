import { readFile } from 'node:fs/promises'
import { builtinModules, createRequire } from 'node:module'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type BuildOptions, build, type Message, type Plugin, transform } from 'esbuild'

const runtimeFile = (name: string) => fileURLToPath(new URL(`../runtime/${name}`, import.meta.url))

const NODE_BUILTINS = [...builtinModules, ...builtinModules.map((m) => `node:${m}`)]
/** A workflow's bundle, its dependencies included, is stored with every revision. */
const BUNDLE_LIMIT_BYTES = 10 * 1024 * 1024

/**
 * Packages that open their own connections, which an isolate can't. `undici` routes through the
 * global `fetch`, which the broker checks; `ws` refuses to connect. Without them, discord.js
 * bundles about 0.8 MB larger.
 */
const STUBS = { undici: runtimeFile('undici.js'), ws: runtimeFile('ws.js') }

/** How discord.js, and every package a workflow imports, is bundled for workerd. */
const WORKERD = {
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'neutral',
  target: 'es2023',
  conditions: ['workerd', 'worker', 'browser', 'require'],
  mainFields: ['browser', 'module', 'main'],
  logLevel: 'silent',
} satisfies BuildOptions

/** One module in an isolate's workerd config. */
export interface ScriptModule {
  readonly name: string
  readonly type: 'esModule' | 'commonJsModule'
  readonly source: string
}

/** Code that did not compile, with esbuild's messages as `file:line: text` lines. */
export class ScriptBuildError extends Error {
  constructor(
    readonly issues: ReadonlyArray<string>,
    message = 'The script did not build.',
  ) {
    super(message)
    this.name = 'ScriptBuildError'
  }
}

/** esbuild names the output format; an agent needs to know what to change instead. */
const TOP_LEVEL_AWAIT = /^Top-level await is currently not supported/

/** A bare import a workflow's own source makes that no dependency provides. */
const UNRESOLVED = /^Could not resolve "[^./]/

const describeMessage = ({ text, location }: Message) => {
  const reason = TOP_LEVEL_AWAIT.test(text)
    ? 'Top-level await is not supported; await inside the default export instead.'
    : location?.file === 'workflow.ts' && UNRESOLVED.test(text)
      ? `${text}; list it in dependencies.`
      : text
  return location === null
    ? reason
    : `${location.file}:${location.line}:${location.column + 1}: ${reason}`
}

const buildError =
  (message?: string) =>
  (error: { errors?: ReadonlyArray<Message> }): never => {
    if (error.errors === undefined) throw error
    throw new ScriptBuildError(error.errors.map(describeMessage), message)
  }

/**
 * discord.js with the shim's Client, bundled once per process as a CommonJS module. CommonJS, so a
 * script's named imports become property reads and need no static export list. `textile` holds
 * what a workflow has beyond discord.js, such as its KV store.
 */
let runtime: Promise<ReadonlyArray<ScriptModule>> | undefined
const loadRuntime = () => {
  runtime ??= Promise.all([
    readFile(runtimeFile('entry.js'), 'utf8'),
    readFile(runtimeFile('textile.js'), 'utf8'),
    build({
      ...WORKERD,
      entryPoints: [runtimeFile('shim.js')],
      // Keeps esbuild's source comments relative to runtime/, whatever the relay's cwd.
      absWorkingDir: runtimeFile(''),
      external: NODE_BUILTINS,
      alias: { 'discord.js-real': createRequire(import.meta.url).resolve('discord.js'), ...STUBS },
    }),
  ]).then(([entry, textile, shim]): ReadonlyArray<ScriptModule> => {
    const [output] = shim.outputFiles
    if (output === undefined) throw new Error('esbuild produced no output.')
    return [
      { name: 'entry.js', type: 'esModule', source: entry },
      { name: 'discord.js', type: 'commonJsModule', source: output.text },
      { name: 'textile', type: 'commonJsModule', source: textile },
    ]
  })
  return runtime
}

/** The modules an isolate runs agent code with: the entry, discord.js, and `script.js`. */
export const withRuntime = async (script: string): Promise<ReadonlyArray<ScriptModule>> => [
  ...(await loadRuntime()),
  { name: 'script.js', type: 'commonJsModule', source: script },
]

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
    sourcefile: 'script.ts',
    // Compiles `import()` to `require()` too, or a CommonJS module's namespace hides its names.
    supported: { 'dynamic-import': false },
    logLevel: 'silent',
  }).catch(buildError())
  return withRuntime(script.code)
}

const STUB_FILES = new Set([...Object.values(STUBS), runtimeFile('collection.js')])

/**
 * Every file the bundle reads must be an installed dependency or a stub, so neither agent code nor
 * a package can bundle a file from elsewhere on the relay, like `/proc/self/environ` or another
 * bot's install. Checked as each file loads, which glob imports reach without resolving. `root` is
 * a real path: esbuild resolves symlinks, so a link out of it loads from outside too.
 */
const confine = (root: string | undefined): Plugin => ({
  name: 'confine',
  setup(build) {
    const modules = root === undefined ? undefined : join(root, 'node_modules') + sep
    build.onLoad({ filter: /.*/, namespace: 'file' }, ({ path }) =>
      STUB_FILES.has(path) || (modules !== undefined && path.startsWith(modules))
        ? undefined
        : // The path is withheld: a glob import would list another directory's files in it.
          { errors: [{ text: "An import reaches a file outside the workflow's dependencies." }] },
    )
  },
})

const DEPENDENCY = /^node_modules\//
/** Modules every isolate already holds, which no bundle may replace. */
export const RUNTIME_MODULES = ['discord.js', 'textile']

/**
 * Bundle a workflow's source with the dependencies installed under `root`, into the CommonJS
 * module its isolates run as `script.js`. discord.js, `textile`, and Node built-ins stay imports,
 * resolved inside workerd to the runtime's own modules, whatever a package of the same name holds;
 * without `root`, nothing else resolves.
 */
export const bundleWorkflow = async (source: string, root?: string): Promise<string> => {
  const result = await build({
    ...WORKERD,
    stdin: {
      contents: source,
      loader: 'ts',
      sourcefile: 'workflow.ts',
      ...(root === undefined ? {} : { resolveDir: root }),
    },
    absWorkingDir: root ?? runtimeFile(''),
    external: [...NODE_BUILTINS, ...RUNTIME_MODULES],
    alias: { ...STUBS, '@discordjs/collection': runtimeFile('collection.js') },
    // Compiles `import()` to `require()` too, or a CommonJS module's namespace hides its names.
    supported: { 'dynamic-import': false },
    plugins: [confine(root)],
  }).catch((error: { errors?: ReadonlyArray<Message> }) =>
    buildError(
      error.errors?.some(({ location }) => DEPENDENCY.test(location?.file ?? ''))
        ? "A dependency can't run in a workflow."
        : 'The workflow did not build.',
    )(error),
  )
  const [output] = result.outputFiles
  if (output === undefined) throw new Error('esbuild produced no output.')
  if (Buffer.byteLength(output.text) > BUNDLE_LIMIT_BYTES) {
    throw new ScriptBuildError(
      ['dependencies: import fewer or smaller packages.'],
      `The workflow bundles to more than ${BUNDLE_LIMIT_BYTES / 1024 / 1024} MB.`,
    )
  }
  return output.text
}
