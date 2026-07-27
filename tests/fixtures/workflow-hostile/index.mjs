import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'

const canRead = async (path) => {
  try {
    await readFile(path)
    return true
  } catch {
    return false
  }
}

const canReachNetwork = async () => {
  try {
    await fetch('https://example.com', { signal: AbortSignal.timeout(1_000) })
    return true
  } catch {
    return false
  }
}

const canWrite = async (path) => {
  try {
    await writeFile(path, 'sandbox escape')
    return true
  } catch {
    return false
  }
}

const initialDiscordEnvironmentKeys = async () =>
  (await readFile('/proc/self/environ', 'utf8'))
    .split('\0')
    .filter((entry) => entry.startsWith('DISCORD_'))
    .map((entry) => entry.slice(0, Math.max(0, entry.indexOf('='))))

const pidLimitIsEnforced = async () => {
  const children = []
  const completions = []
  let rejected = 0
  for (let index = 0; index < 160; index += 1) {
    const child = spawn('/nodejs/bin/node', ['--eval', 'setTimeout(() => {}, 10_000)'], {
      stdio: 'ignore',
    })
    children.push(child)
    completions.push(
      new Promise((resolve) => {
        child.once('error', () => {
          rejected += 1
          resolve()
        })
        child.once('close', resolve)
      }),
    )
  }
  await new Promise((resolve) => setTimeout(resolve, 250))
  for (const child of children) child.kill('SIGKILL')
  await Promise.allSettled(completions)
  return rejected > 0
}

export default {
  triggers: [
    {
      type: 'manual',
      key: 'probe',
      handler: async () => ({
        discordSecrets: {
          token: process.env.DISCORD_TOKEN,
          clientSecret: process.env.DISCORD_CLIENT_SECRET,
          masterKey: process.env.DISCORD_MCP_MASTER_KEY,
          capability: process.env.DISCORD_MCP_CAPABILITY,
        },
        discordEnvironmentKeys: Object.keys(process.env).filter((key) =>
          key.startsWith('DISCORD_'),
        ),
        initialDiscordEnvironmentKeys: await initialDiscordEnvironmentKeys(),
        bootstrapReadable: await canRead('/run/runner/bootstrap.json'),
        hostDatabaseReadable: await canRead('/var/lib/discord-mcp/discord-mcp.sqlite'),
        dockerSocketReadable: await canRead('/var/run/docker.sock'),
        hostRootReadable: await canRead('/host/etc/passwd'),
        unrestrictedNetwork: await canReachNetwork(),
        workflowMountWritable: await canWrite('/workflow/escape.txt'),
        applicationRootWritable: await canWrite('/app/escape.txt'),
        pidLimitEnforced: await pidLimitIsEnforced(),
      }),
    },
  ],
}
