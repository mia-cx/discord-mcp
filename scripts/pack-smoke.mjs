import { spawn } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const run = (command, args, options = {}) =>
  new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options })
    child.once('error', reject)
    child.once('exit', (code) =>
      code === 0
        ? resolveRun()
        : reject(new Error(`${command} ${args.join(' ')} exited with ${code}`)),
    )
  })

const temporary = await mkdtemp(join(tmpdir(), 'discord-mcp-pack-'))
try {
  await run('corepack', ['pnpm', 'build'])
  for (const packageName of [
    '@discord-mcp/persistence',
    '@discord-mcp/auth',
    '@discord-mcp/cli',
    '@discord-mcp/discord-presentations',
    '@discord-mcp/workflow-sdk',
  ]) {
    await run('corepack', [
      'pnpm',
      '--filter',
      packageName,
      'pack',
      '--pack-destination',
      temporary,
    ])
  }
  const tarballs = (await readdir(temporary))
    .filter((name) => name.endsWith('.tgz'))
    .map((name) => resolve(temporary, name))
  if (tarballs.length !== 5) throw new Error('expected five workspace tarballs')
  const names = {}
  for (const tarball of tarballs) {
    const filename = tarball.split('/').at(-1)
    if (!filename) continue
    if (filename.includes('persistence')) names['@discord-mcp/persistence'] = `file:${tarball}`
    else if (filename.includes('discord-presentations'))
      names['@discord-mcp/discord-presentations'] = `file:${tarball}`
    else if (filename.includes('workflow-sdk'))
      names['@discord-mcp/workflow-sdk'] = `file:${tarball}`
    else if (filename.includes('auth')) names['@discord-mcp/auth'] = `file:${tarball}`
    else if (filename.includes('cli')) names['@discord-mcp/cli'] = `file:${tarball}`
  }
  await writeFile(
    join(temporary, 'package.json'),
    JSON.stringify({ private: true, dependencies: names }),
  )
  await run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: temporary,
  })
  const database = join(temporary, 'smoke.sqlite')
  await run('node', ['node_modules/@discord-mcp/cli/dist/main.js', 'diagnostics'], {
    cwd: temporary,
    env: { ...process.env, DATABASE_PATH: database },
  })
  const manifest = JSON.parse(
    await readFile(join(temporary, 'node_modules/@discord-mcp/cli/package.json'), 'utf8'),
  )
  if (manifest.bin?.['discord-mcp'] !== './dist/main.js') {
    throw new Error('packed CLI has no discord-mcp binary')
  }
  await run(
    'node',
    [
      '--input-type=module',
      '--eval',
      "import { Workflow, Trigger } from '@discord-mcp/workflow-sdk'; const value = Workflow.make({ triggers: [Trigger.manual({ key: 'smoke', handler: () => undefined })] }); if (value.triggers[0]?.type !== 'manual') process.exit(1)",
    ],
    {
      cwd: temporary,
    },
  )
} finally {
  await rm(temporary, { recursive: true, force: true })
}
