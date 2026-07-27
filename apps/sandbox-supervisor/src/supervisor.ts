import { createHash, timingSafeEqual } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { access, lstat, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Schema } from 'effect'

export type SupervisorAction = 'build' | 'start' | 'stop' | 'inspect' | 'destroy'

export interface SupervisorRequest {
  readonly credential: string
  readonly action: SupervisorAction
  readonly workflowId: string
  readonly revision: number
  readonly capabilityCredential?: string
  readonly artifactDigest?: string
  readonly allowNpmInstallScripts?: boolean
}

export interface ContainerEngine {
  run(
    arguments_: ReadonlyArray<string>,
  ): Promise<{ readonly stdout: string; readonly stderr: string }>
}

export class SandboxError extends Schema.TaggedErrorClass<SandboxError>()('SandboxError', {
  message: Schema.String,
}) {
  constructor(message: string) {
    super({ message })
  }
}

const workflowId = /^[a-f0-9-]{16,64}$/

const equalCredential = (left: string, right: string): boolean => {
  const leftBytes = Buffer.from(left)
  const rightBytes = Buffer.from(right)
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}

export class SandboxSupervisor {
  constructor(
    readonly engine: ContainerEngine,
    readonly serviceCredential: string,
    readonly artifactRoot = '/var/lib/discord-mcp/artifacts',
    readonly runnerImage = 'discord-mcp/workflow-runner:local',
    readonly builderImage = 'discord-mcp/workflow-builder:local',
    readonly capabilitySocket = '/run/discord-mcp/capability.sock',
    readonly runnerSocketRoot = '/tmp/discord-mcp-runners',
    readonly runnerSocketHostRoot = runnerSocketRoot,
  ) {
    if (serviceCredential.length < 32) throw new SandboxError('supervisor credential is too short')
  }

  async handle(input: unknown): Promise<unknown> {
    const request = validateRequest(input)
    if (!equalCredential(request.credential, this.serviceCredential)) {
      throw new SandboxError('invalid supervisor service credential')
    }
    const name = `dcmcp-${request.workflowId}-${request.revision}`
    const artifact = `${this.artifactRoot}/${request.workflowId}/${request.revision}`
    switch (request.action) {
      case 'build':
        return this.engine.run([
          'run',
          '--rm',
          '--name',
          `${name}-build`,
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
          `type=bind,src=${artifact}/source,dst=/build/source,readonly`,
          '--mount',
          `type=bind,src=${artifact}/output,dst=/build/output`,
          '--env',
          `DISCORD_MCP_ALLOW_INSTALL_SCRIPTS=${request.allowNpmInstallScripts === true ? 'true' : 'false'}`,
          this.builderImage,
        ])
      case 'start': {
        if (!request.capabilityCredential) {
          throw new SandboxError('runtime start requires a revision capability credential')
        }
        if (!request.artifactDigest) {
          throw new SandboxError('runtime start requires the published artifact digest')
        }
        const actualDigest = await digestDirectory(`${artifact}/output`)
        if (!equalCredential(actualDigest, request.artifactDigest)) {
          throw new SandboxError('workflow artifact digest does not match the published revision')
        }
        const runnerSocketHostDirectory = `${this.runnerSocketHostRoot}/${request.workflowId}/${request.revision}`
        mkdirSync(runnerSocketHostDirectory, { recursive: true, mode: 0o700 })
        const bootstrapPath = `${runnerSocketHostDirectory}/bootstrap.json`
        rmSync(bootstrapPath, { force: true })
        writeFileSync(
          bootstrapPath,
          JSON.stringify({
            credential: request.capabilityCredential,
            workflowId: request.workflowId,
            revision: request.revision,
          }),
          { flag: 'wx', mode: 0o600 },
        )
        let started = false
        try {
          const result = await this.engine.run([
            'run',
            '--detach',
            '--name',
            name,
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
            `type=bind,src=${artifact}/output,dst=/workflow,readonly`,
            '--mount',
            `type=bind,src=${this.capabilitySocket},dst=/run/discord-mcp/capability.sock`,
            '--mount',
            `type=bind,src=${runnerSocketHostDirectory},dst=/run/runner`,
            this.runnerImage,
          ])
          started = true
          await waitForRemoval(bootstrapPath)
          return result
        } catch (error) {
          rmSync(bootstrapPath, { force: true })
          if (started) {
            await this.engine.run(['rm', '--force', name]).catch(() => undefined)
          }
          throw error
        }
      }
      case 'stop':
        return this.engine.run(['stop', '--time', '5', name])
      case 'inspect': {
        const result = await this.engine.run(['inspect', '--format', '{{.State.Running}}', name])
        if (result.stdout.trim() !== 'true') {
          throw new SandboxError('workflow runner is not running')
        }
        return { running: true }
      }
      case 'destroy':
        return this.engine.run(['rm', '--force', name])
    }
  }
}

const waitForRemoval = async (path: string): Promise<void> => {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    try {
      await access(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new SandboxError('workflow runner did not consume its one-use bootstrap')
}

const validateRequest = (input: unknown): SupervisorRequest => {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new SandboxError('supervisor request must be an object')
  }
  const record = input as Record<string, unknown>
  const allowed = new Set([
    'credential',
    'action',
    'workflowId',
    'revision',
    'capabilityCredential',
    'artifactDigest',
    'allowNpmInstallScripts',
  ])
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new SandboxError(`unsupported supervisor field: ${key}`)
  }
  if (typeof record.credential !== 'string') throw new SandboxError('credential is required')
  if (
    record.action !== 'build' &&
    record.action !== 'start' &&
    record.action !== 'stop' &&
    record.action !== 'inspect' &&
    record.action !== 'destroy'
  ) {
    throw new SandboxError('invalid supervisor action')
  }
  if (typeof record.workflowId !== 'string' || !workflowId.test(record.workflowId)) {
    throw new SandboxError('invalid workflow identifier')
  }
  if (
    typeof record.revision !== 'number' ||
    !Number.isInteger(record.revision) ||
    record.revision < 1
  ) {
    throw new SandboxError('invalid workflow revision')
  }
  if (
    record.capabilityCredential !== undefined &&
    typeof record.capabilityCredential !== 'string'
  ) {
    throw new SandboxError('invalid capability credential')
  }
  if (
    record.artifactDigest !== undefined &&
    (typeof record.artifactDigest !== 'string' || !/^[a-f0-9]{64}$/.test(record.artifactDigest))
  ) {
    throw new SandboxError('invalid artifact digest')
  }
  if (
    record.allowNpmInstallScripts !== undefined &&
    typeof record.allowNpmInstallScripts !== 'boolean'
  ) {
    throw new SandboxError('invalid install-script policy')
  }
  return {
    credential: record.credential,
    action: record.action,
    workflowId: record.workflowId,
    revision: record.revision,
    ...(record.capabilityCredential === undefined
      ? {}
      : { capabilityCredential: record.capabilityCredential }),
    ...(record.artifactDigest === undefined ? {} : { artifactDigest: record.artifactDigest }),
    ...(record.allowNpmInstallScripts === undefined
      ? {}
      : { allowNpmInstallScripts: record.allowNpmInstallScripts }),
  }
}

const digestDirectory = async (root: string): Promise<string> => {
  const files = await regularFiles(root)
  const hash = createHash('sha256')
  for (const file of files) {
    const contents = await readFile(file)
    hash.update(file.slice(root.length)).update('\0').update(contents)
  }
  return hash.digest('hex')
}

const regularFiles = async (root: string): Promise<ReadonlyArray<string>> => {
  const output: Array<string> = []
  for (const entry of await readdir(root)) {
    const path = join(root, entry)
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink()) throw new SandboxError('workflow artifact contains a symlink')
    if (metadata.isDirectory()) output.push(...(await regularFiles(path)))
    else if (metadata.isFile()) output.push(path)
    else throw new SandboxError('workflow artifact contains an unsupported filesystem entry')
  }
  return output.sort()
}
