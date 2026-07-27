import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const environment = {
  ...process.env,
  DISCORD_MCP_HOST: process.env.DISCORD_MCP_HOST ?? 'discord-mcp.example.test',
  DISCORD_MCP_SUPERVISOR_CREDENTIAL:
    process.env.DISCORD_MCP_SUPERVISOR_CREDENTIAL ?? 'compose-check-only-credential-00000000',
  ROOTLESS_DOCKER_SOCKET: process.env.ROOTLESS_DOCKER_SOCKET ?? '/run/user/1000/docker.sock',
  ROOTLESS_DOCKER_GID: process.env.ROOTLESS_DOCKER_GID ?? '1000',
}

try {
  const { stdout } = await execute(
    'docker',
    ['compose', 'config', '--format', 'json', '--no-env-resolution'],
    { env: environment, maxBuffer: 4 * 1024 * 1024 },
  )
  const configuration = JSON.parse(stdout)
  const supervisor = configuration.services?.supervisor
  if (!supervisor || typeof supervisor !== 'object') {
    throw new Error('resolved Compose configuration has no supervisor service')
  }
  if (supervisor.env_file !== undefined) {
    throw new Error('sandbox supervisor must not inherit an env_file')
  }
  const forbidden = Object.keys(supervisor.environment ?? {}).filter((key) =>
    /^(?:DISCORD_TOKEN|DISCORD_PUBLIC_KEY|DISCORD_APPLICATION_ID|DISCORD_CLIENT_SECRET|DISCORD_MCP_MASTER_KEY|DISCORD_MCP_TEST_|OIDC_)/.test(
      key,
    ),
  )
  if (forbidden.length > 0) {
    throw new Error(`sandbox supervisor receives forbidden control-plane variables: ${forbidden}`)
  }
} catch (error) {
  process.stderr.write(
    `compose validation failed: ${error instanceof Error ? error.message : String(error)}\n`,
  )
  process.exitCode = 1
}
