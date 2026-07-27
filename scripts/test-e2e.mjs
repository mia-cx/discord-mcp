import { spawn } from 'node:child_process'

if (process.env.DISCORD_MCP_E2E !== 'true') {
  process.stdout.write(
    'Live test-guild suite skipped; set DISCORD_MCP_E2E=true and the documented test credentials.\n',
  )
  process.exit(0)
}
for (const variable of [
  'DISCORD_TOKEN',
  'DISCORD_MCP_TEST_GUILD_ID',
  'DISCORD_MCP_TEST_CHANNEL_ID',
]) {
  if (!process.env[variable]) throw new Error(`${variable} is required for the live suite`)
}
const child = spawn(
  'corepack',
  ['pnpm', 'exec', 'vitest', 'run', '--config', 'vitest.e2e.config.ts'],
  {
    stdio: 'inherit',
    env: process.env,
  },
)
child.once('exit', (code) => {
  process.exitCode = code ?? 1
})
