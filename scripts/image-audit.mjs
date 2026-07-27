import { spawn } from 'node:child_process'

const run = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options })
    child.once('error', reject)
    child.once('exit', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${command} ${args.join(' ')} exited with ${code}`)),
    )
  })

const capture = (command, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'inherit'] })
    const chunks = []
    child.stdout.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    child.once('error', reject)
    child.once('exit', (code) =>
      code === 0
        ? resolve(Buffer.concat(chunks).toString('utf8'))
        : reject(new Error(`${command} ${args.join(' ')} exited with ${code}`)),
    )
  })

const images = [
  ['server', 'docker/server.Dockerfile'],
  ['supervisor', 'docker/supervisor.Dockerfile'],
  ['workflow-builder', 'docker/workflow-builder.Dockerfile'],
  ['workflow-runner', 'docker/workflow-runner.Dockerfile'],
]

const dockerHost = JSON.parse(
  await capture('docker', ['context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}']),
)
if (typeof dockerHost !== 'string' || !dockerHost.startsWith('unix://')) {
  throw new Error(`image audit requires a local Unix Docker socket; active host is ${dockerHost}`)
}
const dockerSocket = dockerHost.slice('unix://'.length)
const trivy =
  'aquasec/trivy:0.72.0@sha256:cffe3f5161a47a6823fbd23d985795b3ed72a4c806da4c4df16266c02accdd6f'

for (const [name, dockerfile] of images) {
  const image = `discord-mcp/${name}:local`
  await run('docker', ['build', '--pull', '--file', dockerfile, '--tag', image, '.'])
  const report = JSON.parse(
    await capture('docker', [
      'run',
      '--rm',
      '--volume',
      `${dockerSocket}:/var/run/docker.sock:ro`,
      '--env',
      'DOCKER_HOST=unix:///var/run/docker.sock',
      trivy,
      'image',
      '--quiet',
      '--scanners',
      'vuln',
      '--severity',
      'HIGH,CRITICAL',
      '--ignore-unfixed',
      '--format',
      'json',
      image,
    ]),
  )
  const findings = (report.Results ?? []).flatMap((result) => result.Vulnerabilities ?? [])
  if (findings.length > 0) {
    const summary = findings.map(
      ({ VulnerabilityID, PkgName, InstalledVersion, FixedVersion, Severity }) => ({
        id: VulnerabilityID,
        package: PkgName,
        installed: InstalledVersion,
        fixed: FixedVersion,
        severity: Severity,
      }),
    )
    throw new Error(`${image} has fixable HIGH/CRITICAL findings: ${JSON.stringify(summary)}`)
  }
  process.stderr.write(`image audit: ${image} has no fixable HIGH/CRITICAL findings\n`)
}
