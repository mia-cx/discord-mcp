import { execFile } from 'node:child_process'
import { chmod, chown, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { promisify } from 'node:util'
import { daemonPreflightProblems, parseDaemonCapabilities } from './daemon-preflight.js'
import { type ContainerEngine, SandboxSupervisor } from './supervisor.js'

const execute = promisify(execFile)

const log = (
  level: 'info' | 'error',
  event: string,
  detail: Readonly<Record<string, unknown>> = {},
): void => {
  process.stderr.write(
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      event,
      ...detail,
    })}\n`,
  )
}

const failure = (
  message: string,
  tag = 'SandboxError',
  retryable = false,
): Readonly<Record<string, unknown>> => ({
  ok: false,
  error: { tag, message, retryable },
})

const engine: ContainerEngine = {
  run: async (arguments_) => {
    const result = await execute('docker', [...arguments_], {
      timeout: 5 * 60_000,
      maxBuffer: 64 * 1024,
    })
    return { stdout: result.stdout, stderr: result.stderr }
  },
}

const credential = process.env.DISCORD_MCP_SUPERVISOR_CREDENTIAL
if (!credential) {
  log('error', 'configuration.failure', {
    outcome: 'failure',
    error: 'DISCORD_MCP_SUPERVISOR_CREDENTIAL is required',
  })
  process.exitCode = 1
} else {
  const socketPath = process.env.DISCORD_MCP_SUPERVISOR_SOCKET ?? '/run/discord-mcp/supervisor.sock'
  const information = await execute('docker', ['info', '--format', '{{json .}}'], {
    timeout: 10_000,
    maxBuffer: 64 * 1024,
  })
  const capabilities = parseDaemonCapabilities(information.stdout)
  const preflightProblems = daemonPreflightProblems(capabilities, {
    allowRootful: process.env.DISCORD_MCP_ALLOW_ROOTFUL_DOCKER === 'true',
  })
  if (preflightProblems.length > 0) {
    throw new Error(`sandbox Docker preflight failed:\n- ${preflightProblems.join('\n- ')}`)
  }
  log('info', 'sandbox.daemon.ready', {
    rootless: capabilities.rootless,
    cgroupVersion: capabilities.cgroupVersion,
    memoryLimit: capabilities.memoryLimit,
    pidsLimit: capabilities.pidsLimit,
    warnings: capabilities.warnings,
  })
  const supervisor = new SandboxSupervisor(
    engine,
    credential,
    process.env.DISCORD_MCP_ARTIFACT_DIR ?? '/var/lib/discord-mcp/artifacts',
    process.env.DISCORD_MCP_RUNNER_IMAGE ?? 'discord-mcp/workflow-runner:local',
    process.env.DISCORD_MCP_BUILDER_IMAGE ?? 'discord-mcp/workflow-builder:local',
    process.env.DISCORD_MCP_CAPABILITY_SOCKET ?? '/run/discord-mcp/capability.sock',
    process.env.DISCORD_MCP_RUNNER_SOCKET_ROOT ?? '/run/discord-mcp/runners',
    process.env.DISCORD_MCP_RUNNER_SOCKET_HOST_ROOT ??
      process.env.DISCORD_MCP_RUNNER_SOCKET_ROOT ??
      '/run/discord-mcp/runners',
  )
  await rm(socketPath, { force: true })
  const server = createServer((socket) => {
    let buffer = ''
    let handled = false
    socket.setEncoding('utf8')
    socket.on('data', (chunk) => {
      if (handled) return
      buffer += chunk
      if (Buffer.byteLength(buffer) > 64 * 1024) {
        handled = true
        socket.end(`${JSON.stringify(failure('supervisor request exceeds 64 KiB'))}\n`)
        return
      }
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      handled = true
      const line = buffer.slice(0, newline)
      let request: unknown
      try {
        request = JSON.parse(line)
      } catch {
        socket.end(`${JSON.stringify(failure('invalid JSON request'))}\n`)
        return
      }
      const started = performance.now()
      const identity =
        typeof request === 'object' && request !== null
          ? (request as {
              readonly action?: unknown
              readonly workflowId?: unknown
              readonly revision?: unknown
            })
          : {}
      void supervisor.handle(request).then(
        (result) => {
          log('info', 'sandbox.supervisor.request', {
            action: identity.action,
            workflowId: identity.workflowId,
            revision: identity.revision,
            durationMs: performance.now() - started,
            outcome: 'success',
          })
          socket.end(`${JSON.stringify({ ok: true, result })}\n`)
        },
        (error: unknown) => {
          log('error', 'sandbox.policy_or_runtime.failure', {
            action: identity.action,
            workflowId: identity.workflowId,
            revision: identity.revision,
            durationMs: performance.now() - started,
            outcome: 'failure',
            error: error instanceof Error ? error.message : String(error),
          })
          socket.end(
            `${JSON.stringify(
              failure(
                error instanceof Error ? error.message : String(error),
                typeof error === 'object' &&
                  error !== null &&
                  '_tag' in error &&
                  typeof error._tag === 'string'
                  ? error._tag
                  : 'SupervisorRuntimeError',
                !(
                  typeof error === 'object' &&
                  error !== null &&
                  '_tag' in error &&
                  error._tag === 'SandboxError'
                ),
              ),
            )}\n`,
          )
        },
      )
    })
  })
  server.listen(socketPath, async () => {
    const runtimeGid = Number(process.env.DISCORD_MCP_RUNTIME_GID ?? 65_532)
    if (!Number.isInteger(runtimeGid) || runtimeGid < 0) {
      throw new Error('DISCORD_MCP_RUNTIME_GID must be a non-negative integer')
    }
    await chown(socketPath, -1, runtimeGid)
    await chmod(socketPath, 0o660)
  })
}
