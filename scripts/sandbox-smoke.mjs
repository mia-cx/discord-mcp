import { spawn } from 'node:child_process'
import { access, chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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

const capture = (command, args) =>
  new Promise((resolveCapture, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.once('error', reject)
    child.once('exit', (code) =>
      code === 0
        ? resolveCapture(stdout)
        : reject(new Error(`${command} exited with ${code}: ${stderr}`)),
    )
  })

const waitForPath = async (path, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      await access(path)
      return
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 25))
    }
  }
  throw new Error(`timed out waiting for ${path}`)
}

const temporary = await mkdtemp(join(tmpdir(), 'discord-mcp-sandbox-'))
const hostileContainer = `discord-mcp-hostile-${process.pid}`
const memoryContainer = `discord-mcp-memory-${process.pid}`
try {
  const source = join(temporary, 'source')
  const output = join(temporary, 'output')
  await cp(resolve('tests/fixtures/workflow-safe'), source, { recursive: true })
  await mkdir(output)
  await chmod(output, 0o777)
  await run('docker', [
    'run',
    '--rm',
    '--user',
    '65532:65532',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    '128',
    '--memory',
    '512m',
    '--cpus',
    '1',
    '--mount',
    `type=bind,src=${source},dst=/build/source,readonly`,
    '--mount',
    `type=bind,src=${output},dst=/build/output`,
    '--env',
    'DISCORD_MCP_ALLOW_INSTALL_SCRIPTS=false',
    'discord-mcp/workflow-builder:local',
  ])
  const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'))
  if (manifest.triggers?.[0]?.type !== 'manual' || manifest.triggers?.[0]?.key !== 'announce') {
    throw new Error('sandbox builder emitted an invalid manifest')
  }
  await Promise.all([readFile(join(output, 'index.mjs')), readFile(join(output, 'pnpm-lock.yaml'))])
  await readFile(join(output, 'LIFECYCLE_SCRIPT_RAN')).then(
    () => {
      throw new Error('dependency lifecycle script escaped the default-deny build policy')
    },
    (error) => {
      if (error?.code !== 'ENOENT') throw error
    },
  )

  const runner = JSON.parse(
    await capture('docker', ['image', 'inspect', 'discord-mcp/workflow-runner:local']),
  )[0]
  const user = runner?.Config?.User
  const environment = runner?.Config?.Env ?? []
  if (!user || user === '0' || user === 'root') throw new Error('runner image defaults to root')
  if (environment.some((entry) => /DISCORD_(?:TOKEN|CLIENT_SECRET|MCP_MASTER_KEY)=/.test(entry))) {
    throw new Error('runner image contains a Discord credential environment variable')
  }

  const runnerSocketDirectory = join(temporary, 'runner')
  const capabilitySocket = join(temporary, 'capability.sock')
  await mkdir(runnerSocketDirectory)
  await chmod(runnerSocketDirectory, 0o777)
  await writeFile(
    join(runnerSocketDirectory, 'bootstrap.json'),
    JSON.stringify({
      credential: 'sandbox-revision-credential',
      workflowId: 'abcdef12-3456-7890',
      revision: 1,
    }),
    // The smoke test writes as the host user; production writes as the same mapped
    // UID used by the runner and uses 0600.
    { mode: 0o644 },
  )
  await writeFile(capabilitySocket, '')
  await chmod(capabilitySocket, 0o666)
  await capture('docker', [
    'run',
    '--detach',
    '--name',
    hostileContainer,
    '--user',
    '65532:65532',
    '--read-only',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,size=32m',
    '--network',
    'none',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    '128',
    '--memory',
    '256m',
    '--cpus',
    '1',
    '--mount',
    `type=bind,src=${resolve('tests/fixtures/workflow-hostile')},dst=/workflow,readonly`,
    '--mount',
    `type=bind,src=${capabilitySocket},dst=/run/discord-mcp/capability.sock`,
    '--mount',
    `type=bind,src=${runnerSocketDirectory},dst=/run/runner`,
    'discord-mcp/workflow-runner:local',
  ])
  const runnerSocket = join(runnerSocketDirectory, 'runner.sock')
  await waitForPath(runnerSocket)
  const probe = `
    import { createConnection } from 'node:net'
    const socket = createConnection('/run/runner/runner.sock')
    let buffer = ''
    socket.setEncoding('utf8')
    socket.once('connect', () => socket.write(JSON.stringify({
      executionId: 'sandbox-hostile-probe',
      triggerIndex: 0,
      input: {},
      correlationId: 'sandbox-hostile-probe',
      causalDepth: 0
    }) + '\\n'))
    socket.on('data', (chunk) => {
      buffer += chunk
      const newline = buffer.indexOf('\\n')
      if (newline < 0) return
      process.stdout.write(buffer.slice(0, newline))
      socket.destroy()
    })
  `
  const hostileResponse = JSON.parse(
    await capture('docker', [
      'exec',
      hostileContainer,
      '/nodejs/bin/node',
      '--input-type=module',
      '--eval',
      probe,
    ]),
  )
  if (!hostileResponse.ok) {
    throw new Error(hostileResponse.error ?? 'hostile workflow probe failed')
  }
  const hostileResult = hostileResponse.result
  if (
    hostileResult?.discordSecrets?.token !== undefined ||
    hostileResult?.discordSecrets?.clientSecret !== undefined ||
    hostileResult?.discordSecrets?.masterKey !== undefined ||
    hostileResult?.discordSecrets?.capability !== undefined ||
    hostileResult?.discordEnvironmentKeys?.length !== 0 ||
    hostileResult?.initialDiscordEnvironmentKeys?.length !== 0 ||
    hostileResult?.bootstrapReadable !== false ||
    hostileResult?.hostDatabaseReadable !== false ||
    hostileResult?.dockerSocketReadable !== false ||
    hostileResult?.hostRootReadable !== false ||
    hostileResult?.unrestrictedNetwork !== false ||
    hostileResult?.workflowMountWritable !== false ||
    hostileResult?.applicationRootWritable !== false ||
    hostileResult?.pidLimitEnforced !== true
  ) {
    throw new Error(`hostile runtime escaped containment: ${JSON.stringify(hostileResult)}`)
  }
  const inspected = JSON.parse(await capture('docker', ['inspect', hostileContainer]))[0]
  if (
    inspected?.HostConfig?.ReadonlyRootfs !== true ||
    inspected?.HostConfig?.NetworkMode !== 'none' ||
    Object.keys(inspected?.HostConfig?.PortBindings ?? {}).length > 0 ||
    inspected?.HostConfig?.PidsLimit !== 128 ||
    inspected?.HostConfig?.Memory !== 256 * 1024 * 1024 ||
    inspected?.HostConfig?.CapDrop?.includes('ALL') !== true ||
    inspected?.HostConfig?.SecurityOpt?.includes('no-new-privileges') !== true
  ) {
    throw new Error('hostile runtime container policy does not match the required isolation')
  }

  await capture('docker', [
    'run',
    '--detach',
    '--name',
    memoryContainer,
    '--user',
    '65532:65532',
    '--read-only',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,size=8m',
    '--network',
    'none',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    '16',
    '--memory',
    '64m',
    '--cpus',
    '1',
    'discord-mcp/workflow-runner:local',
    '--eval',
    'const blocks=[]; while (true) blocks.push(Buffer.alloc(8*1024*1024, 0xff))',
  ])
  await capture('docker', ['wait', memoryContainer])
  const memoryInspection = JSON.parse(await capture('docker', ['inspect', memoryContainer]))[0]
  if (
    memoryInspection?.State?.OOMKilled !== true ||
    memoryInspection?.HostConfig?.Memory !== 64 * 1024 * 1024
  ) {
    throw new Error('memory-exhausting workflow was not terminated by its cgroup limit')
  }
  process.stderr.write(
    'sandbox smoke: hostile runtime contained; memory exhaustion killed; non-root builder/runner; install scripts denied\n',
  )
} finally {
  await capture('docker', ['rm', '--force', hostileContainer]).catch(() => undefined)
  await capture('docker', ['rm', '--force', memoryContainer]).catch(() => undefined)
  await rm(temporary, { recursive: true, force: true })
}
