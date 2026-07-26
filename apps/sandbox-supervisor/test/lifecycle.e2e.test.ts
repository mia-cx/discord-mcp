import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

/**
 * The whole sandbox path against a real Docker daemon: build a workflow, run it, and read back what
 * its handler logged.
 *
 * Every other test in this package asserts on a derived specification. This one asserts the thing
 * an operator actually cares about — that a workflow someone wrote gets compiled, started, and
 * produces a result — and it is the only test that would have caught the container being started
 * before its files were copied in, or the artifact carrying a symlink to a path that exists only in
 * the build image.
 *
 *   DISCORD_MCP_E2E_STACK=1 pnpm exec vitest run --config vitest.e2e.config.ts
 *
 * Expects the compose stack from `docker/` to be running with locally built images.
 */

const enabled = process.env.DISCORD_MCP_E2E_STACK === '1'
const run = promisify(execFile)

const composeArgs = (): string[] => [
  'compose',
  '-p',
  process.env.DISCORD_MCP_E2E_PROJECT ?? 'dmtest',
  '--env-file',
  process.env.DISCORD_MCP_E2E_ENV ?? '/tmp/dm.env',
  '-f',
  'docker/compose.yaml',
  ...(process.env.DISCORD_MCP_E2E_OVERRIDE === undefined
    ? []
    : ['-f', process.env.DISCORD_MCP_E2E_OVERRIDE]),
]

const compose = (...args: string[]) =>
  run('docker', [...composeArgs(), ...args], {
    timeout: 600_000,
    cwd: process.cwd(),
    maxBuffer: 32 * 1024 * 1024,
  })

const SOURCE = `import { Workflow, Trigger } from '@discord-mcp/workflow-sdk'
import { Effect } from 'effect'

export default Workflow.make({
  triggers: [
    Trigger.manual({
      name: 'greet',
      handler: ({ input, Log }) =>
        Effect.as(Log.info('hello from inside the sandbox'), { greeted: input }),
    }),
  ],
})`

const GRANT = {
  discord: {
    operationIds: [],
    operationFamilies: [],
    guildIds: [],
    channelIds: [],
    oauthProfileIds: [],
    botAdmin: false,
    broadMentions: false,
    maxActionsPerMinute: 60,
  },
  gateway: { eventTypes: [], includeBotAuthoredEvents: false },
  interactions: { guildCommandPublishing: false, globalCommandPublishing: false },
  routes: {
    public: false,
    allowedHosts: [],
    allowedOrigins: [],
    allowedSourceCidrs: [],
    maxBodyBytes: 1048576,
  },
  network: { allowedOutboundHosts: [] },
  runtime: { allowNpmInstallScripts: false, timeoutSeconds: 120, concurrency: 1 },
}

/** Drive the running control plane over stdio, sharing its database and supervisor socket. */
const driveLifecycle = (slug: string) => {
  const calls = [
    ['workflow_create', { slug, name: 'Sandbox smoke' }],
    ['workflow_update_draft', { slug, source: SOURCE }],
    ['workflow_validate', { slug, revision: 1 }],
    ['workflow_publish', { slug, revision: 1 }],
    ['workflow_grant', { slug, revision: 1, grant: GRANT }],
    ['workflow_enable', { slug, revision: 1 }],
    ['workflow_invoke', { slug, payload: { name: 'mia' } }],
  ] as const

  const child = spawn('docker', [
    ...composeArgs(),
    'exec',
    '-T',
    '-e',
    'MCP_TRANSPORT=stdio',
    'server',
    'node',
    '/app/apps/server/dist/bin.js',
  ])

  const texts = new Map<number, string>()

  return new Promise<{ calls: typeof calls; textOf: (id: number) => string }>((resolve, reject) => {
    let buffer = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')

        try {
          const message = JSON.parse(line) as {
            id?: number
            result?: { content?: Array<{ text?: string }> }
          }
          if (typeof message.id !== 'number') continue
          texts.set(message.id, (message.result?.content ?? []).map((c) => c.text ?? '').join(''))

          if (message.id === 0) {
            // Initialized. Send the lifecycle one call at a time, in order: each step depends on
            // the one before it, so pipelining them would race.
            send(1)
          } else if (message.id < calls.length) {
            send(message.id + 1)
          } else {
            // The stdio server holds its scope open deliberately; nothing here ends it but a kill.
            child.kill()
            resolve({ calls, textOf: (id) => texts.get(id) ?? '' })
          }
        } catch {
          // Notifications and progress messages are not responses.
        }
      }
    })

    child.on('error', reject)

    const write = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`)
    const send = (index: number) => {
      const call = calls[index - 1]
      if (call === undefined) return
      write({
        jsonrpc: '2.0',
        id: index,
        method: 'tools/call',
        params: { name: call[0], arguments: call[1] },
      })
    }

    write({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'e2e', version: '0' },
      },
    })
  })
}

describe.skipIf(!enabled)('a workflow, end to end through real containers', () => {
  it('builds, publishes, enables, and runs, and its handler reaches the broker', async () => {
    const slug = `smoke${Date.now().toString(36)}`
    const { calls, textOf } = await driveLifecycle(slug)

    // Every lifecycle step answered.
    for (let index = 0; index < calls.length; index += 1) {
      expect(textOf(index + 1), `${calls[index]?.[0]} returned nothing`).not.toBe('')
    }

    // The build ran in a container: installed dependencies, compiled, imported the module, and
    // emitted a manifest. `workflow_validate` reports a build failure as data, not as a tool error,
    // so the status is what has to be checked.
    expect(textOf(3)).toContain('"status": "validated"')

    const invoked = textOf(7)
    expect(invoked).toContain('"status": "succeeded"')
    // The log line originated inside a container with no network and travelled out over the
    // capability socket. Nothing else in the suite proves that path end to end.
    expect(invoked).toContain('hello from inside the sandbox')
  }, 600_000)

  it('has a supervisor the control plane can actually reach', async () => {
    const { stdout } = await compose('exec', '-T', 'server', 'ls', '-l', '/run/discord-mcp/')
    // Different users in different containers, one shared group. Owner-only would mean the two
    // processes could never talk.
    expect(stdout).toContain('supervisor.sock')
    expect(stdout).toMatch(/srw-rw----/)
  }, 120_000)
})
