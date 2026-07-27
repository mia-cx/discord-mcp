import { createHash } from 'node:crypto'
import { lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import { Schema } from 'effect'
import {
  type CompiledWorkflowManifest,
  validateCompiledManifest,
  type WorkflowBuilder,
  type WorkflowBuildResult,
} from './types.js'

interface SupervisorResponse {
  readonly ok: boolean
  readonly result?: unknown
  readonly error?:
    | string
    | {
        readonly tag: string
        readonly message: string
        readonly retryable: boolean
      }
}

export class SupervisorRpcError extends Schema.TaggedErrorClass<SupervisorRpcError>()(
  'SupervisorRpcError',
  {
    message: Schema.String,
    remoteTag: Schema.String,
    retryable: Schema.Boolean,
  },
) {
  constructor(message: string, remoteTag = 'SupervisorTransportError', retryable = true) {
    super({ message, remoteTag, retryable })
  }
}

export interface SupervisorClientObserver {
  readonly requestFinished?: (event: {
    readonly action: string
    readonly workflowId?: string
    readonly revision?: number
    readonly outcome: 'success' | 'failure'
    readonly durationMs: number
    readonly errorTag?: string
    readonly errorMessage?: string
  }) => void
}

export class SupervisorClient {
  constructor(
    readonly socketPath: string,
    readonly credential: string,
    readonly observer: SupervisorClientObserver = {},
    readonly timeoutMs = 6 * 60_000,
  ) {}

  request(input: Readonly<Record<string, unknown>>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const started = performance.now()
      const action = typeof input.action === 'string' ? input.action : 'unknown'
      const workflowId = typeof input.workflowId === 'string' ? input.workflowId : undefined
      const revision = typeof input.revision === 'number' ? input.revision : undefined
      const socket = createConnection(this.socketPath)
      let buffer = ''
      let settled = false
      const finish = (result: () => void): void => {
        if (settled) return
        settled = true
        socket.destroy()
        result()
      }
      const observe = (
        outcome: 'success' | 'failure',
        error?: { readonly tag: string; readonly message: string },
      ): void => {
        this.observer.requestFinished?.({
          action,
          ...(workflowId === undefined ? {} : { workflowId }),
          ...(revision === undefined ? {} : { revision }),
          outcome,
          durationMs: performance.now() - started,
          ...(error === undefined ? {} : { errorTag: error.tag, errorMessage: error.message }),
        })
      }
      const rejectTransport = (message: string): void => {
        if (settled) return
        const error = new SupervisorRpcError(message)
        observe('failure', { tag: error.remoteTag, message: error.message })
        finish(() => reject(error))
      }
      socket.setEncoding('utf8')
      socket.setTimeout(this.timeoutMs, () =>
        rejectTransport('sandbox supervisor request timed out'),
      )
      socket.once('connect', () => {
        socket.write(`${JSON.stringify({ credential: this.credential, ...input })}\n`)
      })
      socket.on('data', (chunk) => {
        buffer += chunk
        if (Buffer.byteLength(buffer) > 256 * 1024) {
          rejectTransport('sandbox supervisor response exceeds 256 KiB')
          return
        }
        const newline = buffer.indexOf('\n')
        if (newline < 0) return
        let response: SupervisorResponse
        try {
          response = JSON.parse(buffer.slice(0, newline)) as SupervisorResponse
        } catch {
          rejectTransport('sandbox supervisor returned invalid JSON')
          return
        }
        if (response.ok) {
          observe('success')
          finish(() => resolve(response.result))
        } else {
          const remote =
            typeof response.error === 'object' && response.error !== null
              ? response.error
              : {
                  tag: 'SandboxError',
                  message:
                    typeof response.error === 'string'
                      ? response.error
                      : 'sandbox supervisor request failed',
                  retryable: false,
                }
          const error = new SupervisorRpcError(remote.message, remote.tag, remote.retryable)
          observe('failure', { tag: error.remoteTag, message: error.message })
          finish(() => reject(error))
        }
      })
      socket.once('error', (error) => rejectTransport(error.message))
      socket.once('end', () => {
        if (!settled) rejectTransport('sandbox supervisor closed without a response')
      })
    })
  }
}

export class SupervisorWorkflowBuilder implements WorkflowBuilder {
  constructor(
    readonly supervisor: SupervisorClient,
    readonly artifactRoot: string,
    readonly observer: {
      readonly buildFinished?: (event: {
        readonly workflowId: string
        readonly revision: number
        readonly outcome: 'success' | 'failure'
        readonly durationMs: number
      }) => void
    } = {},
  ) {}

  async build(input: {
    readonly workflowId: string
    readonly revision: number
    readonly source: string
    readonly dependencies: Readonly<Record<string, string>>
    readonly allowNpmInstallScripts: boolean
  }): Promise<WorkflowBuildResult> {
    const started = performance.now()
    const root = join(this.artifactRoot, input.workflowId, String(input.revision))
    const sourceRoot = join(root, 'source')
    const outputRoot = join(root, 'output')
    await mkdir(sourceRoot, { recursive: true, mode: 0o700 })
    await rm(outputRoot, { recursive: true, force: true })
    await mkdir(outputRoot, { recursive: true, mode: 0o700 })
    await writeFile(join(sourceRoot, 'index.ts'), input.source, { mode: 0o600 })
    await writeFile(
      join(sourceRoot, 'package.json'),
      JSON.stringify({
        name: `discord-mcp-workflow-${input.workflowId}`,
        private: true,
        type: 'module',
        dependencies: input.dependencies,
      }),
      { mode: 0o600 },
    )
    try {
      await this.supervisor.request({
        action: 'build',
        workflowId: input.workflowId,
        revision: input.revision,
        allowNpmInstallScripts: input.allowNpmInstallScripts,
      })
      const manifest = validateCompiledManifest(
        JSON.parse(await readFile(join(outputRoot, 'manifest.json'), 'utf8')),
      ) as CompiledWorkflowManifest
      const lockfile = await readFile(join(outputRoot, 'pnpm-lock.yaml'), 'utf8')
      const files = await allFiles(outputRoot)
      let bytes = 0
      const hash = createHash('sha256')
      for (const file of files) {
        const contents = await readFile(file)
        bytes += contents.byteLength
        hash.update(file.slice(outputRoot.length)).update('\0').update(contents)
      }
      if (bytes > 20 * 1024 * 1024) throw new Error('workflow artifact exceeds 20 MiB')
      this.observer.buildFinished?.({
        workflowId: input.workflowId,
        revision: input.revision,
        outcome: 'success',
        durationMs: performance.now() - started,
      })
      return {
        artifactDigest: hash.digest('hex'),
        lockfile,
        manifest,
        diagnostics: [],
      }
    } catch (cause) {
      await rm(outputRoot, { recursive: true, force: true }).catch(() => undefined)
      this.observer.buildFinished?.({
        workflowId: input.workflowId,
        revision: input.revision,
        outcome: 'failure',
        durationMs: performance.now() - started,
      })
      throw cause
    }
  }
}

const allFiles = async (root: string): Promise<ReadonlyArray<string>> => {
  const output: Array<string> = []
  for (const entry of await readdir(root)) {
    const path = join(root, entry)
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink()) throw new Error('workflow artifacts cannot contain symlinks')
    if (metadata.isDirectory()) output.push(...(await allFiles(path)))
    else if (metadata.isFile()) output.push(path)
    else throw new Error('workflow artifact contains an unsupported filesystem entry')
  }
  return output.sort()
}
