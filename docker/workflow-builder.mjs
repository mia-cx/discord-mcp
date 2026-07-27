import { spawn } from 'node:child_process'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const run = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options })
    child.once('error', reject)
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)),
    )
  })

const sourceRoot = '/build/source'
const workRoot = '/tmp/workflow-build'
const outputRoot = '/build/output'
await mkdir(workRoot, { recursive: true })
await mkdir(outputRoot, { recursive: true })
await cp(`${sourceRoot}/index.ts`, `${workRoot}/index.ts`)
await mkdir(`${workRoot}/sdk`)
await cp('/sdk/package.json', `${workRoot}/sdk/package.json`)
await cp('/sdk/dist', `${workRoot}/sdk/dist`, { recursive: true })
await mkdir(`${workRoot}/discord-presentations`)
await cp('/discord-presentations/package.json', `${workRoot}/discord-presentations/package.json`)
await cp('/discord-presentations/dist', `${workRoot}/discord-presentations/dist`, {
  recursive: true,
})
const sdkPackage = JSON.parse(await readFile(`${workRoot}/sdk/package.json`, 'utf8'))
sdkPackage.dependencies['@discord-mcp/discord-presentations'] = 'file:../discord-presentations'
await writeFile(`${workRoot}/sdk/package.json`, JSON.stringify(sdkPackage))
const supplied = JSON.parse(await readFile(`${sourceRoot}/package.json`, 'utf8'))
const packageJson = {
  ...supplied,
  dependencies: {
    ...(supplied.dependencies ?? {}),
    '@discord-mcp/workflow-sdk': 'file:./sdk',
  },
  devDependencies: { typescript: '7.0.2' },
}
await writeFile(`${workRoot}/package.json`, JSON.stringify(packageJson))
await writeFile(
  `${workRoot}/tsconfig.json`,
  JSON.stringify({
    compilerOptions: {
      target: 'ES2024',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      noEmit: true,
      skipLibCheck: true,
    },
    include: ['index.ts'],
  }),
)
const installArgs = ['install', '--frozen-lockfile=false']
if (process.env.DISCORD_MCP_ALLOW_INSTALL_SCRIPTS !== 'true') installArgs.push('--ignore-scripts')
await run('pnpm', installArgs, { cwd: workRoot })
await run('pnpm', ['exec', 'tsc', '--noEmit'], { cwd: workRoot })
await build({
  entryPoints: [`${workRoot}/index.ts`],
  outfile: `${outputRoot}/index.mjs`,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node24',
  packages: 'bundle',
  sourcemap: true,
})
const loaded = await import(`${pathToFileURL(`${outputRoot}/index.mjs`).href}?build=${Date.now()}`)
if (
  typeof loaded.default !== 'object' ||
  loaded.default === null ||
  !Array.isArray(loaded.default.triggers)
) {
  throw new Error('workflow must default-export Workflow.make({ triggers: [...] })')
}
const manifest = {
  triggers: loaded.default.triggers.map((trigger, index) => {
    const { handler: _handler, request, ...metadata } = trigger
    if (typeof trigger.handler !== 'function') throw new Error(`trigger ${index} has no handler`)
    const requestSchema =
      request?.['~standard']?.jsonSchema?.input === undefined
        ? undefined
        : request['~standard'].jsonSchema.input({ target: 'draft-2020-12' })
    return { ...metadata, ...(requestSchema === undefined ? {} : { requestSchema }), index }
  }),
  ...(loaded.default.requestedGrants === undefined
    ? {}
    : { requestedGrants: loaded.default.requestedGrants }),
}
await writeFile(`${outputRoot}/manifest.json`, JSON.stringify(manifest))
await cp(`${workRoot}/pnpm-lock.yaml`, `${outputRoot}/pnpm-lock.yaml`)
