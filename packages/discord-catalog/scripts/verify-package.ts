/**
 * `pnpm package:verify` — prove the packed package works outside this workspace.
 *
 * Packs `@mia-cx/discord-catalog`, checks the tarball's contents and manifest, then installs it into
 * a throwaway pnpm workspace that knows nothing of this one. There it typechecks `smoke/worker.ts`,
 * bundles it with Wrangler with `nodejs_compat` off, and runs it in workerd.
 *
 * The peer is pinned to one Effect beta because the betas and 4.0 rename APIs this package uses,
 * such as `Schema.TaggedErrorClass`. Widen it only after this script passes on the new version.
 */
import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE = join(dirname(fileURLToPath(import.meta.url)), '..')
const SMOKE = join(PACKAGE, 'smoke')
const SMOKE_FILES = ['worker.ts', 'run.mjs', 'tsconfig.json', 'wrangler.json']

/** Consumer tooling, pinned so a verification failure is about this package, not a new release. */
const TOOLING = {
  typescript: '7.0.2',
  wrangler: '4.151.3',
  miniflare: '4.20260730.0',
  '@cloudflare/workers-types': '5.20261021.1',
}

const manifest = JSON.parse(readFileSync(join(PACKAGE, 'package.json'), 'utf8')) as {
  readonly name: string
  readonly version: string
  readonly peerDependencies: { readonly effect: string }
}

const run = (cwd: string, command: string, args: ReadonlyArray<string>) =>
  execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
  })

const fail = (message: string): never => {
  process.stderr.write(`package:verify failed: ${message}\n`)
  process.exit(1)
}

const work = mkdtempSync(join(tmpdir(), 'discord-catalog-'))
run(PACKAGE, 'pnpm', ['pack', '--pack-destination', work])
const tarball = join(work, `mia-cx-discord-catalog-${manifest.version}.tgz`)

const files = run(work, 'tar', ['-tzf', tarball]).trim().split('\n')
for (const required of ['package/LICENSE', 'package/README.md', 'package/dist/index.js']) {
  if (!files.includes(required)) fail(`the tarball lacks ${required}`)
}
const strays = files.filter((f) => !/^package\/(dist\/.*\.(js|d\.ts)|[^/]+)$/.test(f))
if (strays.length > 0) fail(`the tarball ships more than dist: ${strays.join(', ')}`)

const packed = run(work, 'tar', ['-xzOf', tarball, 'package/package.json'])
if (packed.includes('workspace:')) fail('the packed manifest still names a workspace: protocol')

const consumer = join(work, 'consumer')
for (const file of SMOKE_FILES) cpSync(join(SMOKE, file), join(consumer, file))
writeFileSync(
  join(consumer, 'package.json'),
  JSON.stringify({
    name: 'discord-catalog-consumer',
    private: true,
    type: 'module',
    dependencies: {
      [manifest.name]: `file:${tarball}`,
      effect: manifest.peerDependencies.effect,
    },
    devDependencies: TOOLING,
  }),
)
// Its own workspace root, so pnpm cannot resolve anything from this repository.
writeFileSync(
  join(consumer, 'pnpm-workspace.yaml'),
  'packages: []\nallowBuilds:\n  esbuild: true\n  workerd: true\n  msgpackr-extract: false\n',
)

run(consumer, 'pnpm', ['install', '--no-frozen-lockfile'])
run(consumer, 'pnpm', ['exec', 'tsc', '--project', 'tsconfig.json'])
run(consumer, 'pnpm', ['exec', 'wrangler', 'deploy', '--dry-run', '--outdir', 'out'])

// Wrangler already fails on a bare builtin it cannot resolve; a `node:` specifier it may leave
// external. Effect's guarded `process.getBuiltinModule?.('node:…')` probe is neither.
const bundle = readFileSync(join(consumer, 'out/worker.js'), 'utf8')
const imports = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["'](node:[\w/]+)["']/g
const builtins = [...bundle.matchAll(imports)].map((m) => m[1])
if (builtins.length > 0) fail(`the Worker bundle imports ${[...new Set(builtins)].join(', ')}`)

process.stdout.write(run(consumer, 'node', ['run.mjs']))
