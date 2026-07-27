import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { type ContainerEngine, SandboxSupervisor } from './supervisor.js'

describe('sandbox supervisor policy', () => {
  it('derives the complete runtime isolation policy internally', async () => {
    const calls: Array<ReadonlyArray<string>> = []
    const root = await mkdtemp(join(tmpdir(), 'discord-mcp-supervisor-'))
    const artifactRoot = join(root, 'artifacts')
    const artifactOutput = join(artifactRoot, 'abcdef12-3456-7890', '2', 'output')
    await mkdir(artifactOutput, { recursive: true })
    await writeFile(join(artifactOutput, 'index.mjs'), 'export default {}')
    const artifactDigest = createHash('sha256')
      .update('/index.mjs')
      .update('\0')
      .update('export default {}')
      .digest('hex')
    let bootstrap: unknown
    const engine: ContainerEngine = {
      run: async (arguments_) => {
        calls.push(arguments_)
        bootstrap = JSON.parse(
          await readFile(join(root, 'abcdef12-3456-7890', '2', 'bootstrap.json'), 'utf8'),
        )
        await rm(join(root, 'abcdef12-3456-7890', '2', 'bootstrap.json'))
        return { stdout: 'container', stderr: '' }
      },
    }
    const supervisor = new SandboxSupervisor(
      engine,
      's'.repeat(32),
      artifactRoot,
      'safe-runner',
      'safe-builder',
      '/safe/capability.sock',
      '/container/runners',
      root,
    )
    await supervisor.handle({
      credential: 's'.repeat(32),
      action: 'start',
      workflowId: 'abcdef12-3456-7890',
      revision: 2,
      capabilityCredential: 'revision-only',
      artifactDigest,
    })
    const arguments_ = calls[0] ?? []
    expect(arguments_).toEqual([
      'run',
      '--detach',
      '--name',
      'dcmcp-abcdef12-3456-7890-2',
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
      `type=bind,src=${artifactOutput},dst=/workflow,readonly`,
      '--mount',
      'type=bind,src=/safe/capability.sock,dst=/run/discord-mcp/capability.sock',
      '--mount',
      `type=bind,src=${root}/abcdef12-3456-7890/2,dst=/run/runner`,
      'safe-runner',
    ])
    expect(bootstrap).toEqual({
      credential: 'revision-only',
      workflowId: 'abcdef12-3456-7890',
      revision: 2,
    })
    await expect(
      access(join(root, 'abcdef12-3456-7890', '2', 'bootstrap.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await stat(join(root, 'abcdef12-3456-7890', '2'))).isDirectory()).toBe(true)
    const command = arguments_.join(' ')
    expect(command).not.toMatch(/DISCORD_(?:TOKEN|CLIENT_SECRET)|MCP_MASTER_KEY/)
    expect(command).not.toContain('revision-only')
    expect(command).not.toContain('/var/run/docker.sock')
    expect(command).not.toContain('/var/lib/discord-mcp/discord-mcp.sqlite')
  })

  it('refuses a runtime artifact changed after validation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'discord-mcp-supervisor-tamper-'))
    const output = join(root, 'abcdef12-3456-7890', '1', 'output')
    await mkdir(output, { recursive: true })
    await writeFile(join(output, 'index.mjs'), 'tampered')
    const supervisor = new SandboxSupervisor(
      { run: async () => ({ stdout: '', stderr: '' }) },
      's'.repeat(32),
      root,
    )
    await expect(
      supervisor.handle({
        credential: 's'.repeat(32),
        action: 'start',
        workflowId: 'abcdef12-3456-7890',
        revision: 1,
        capabilityCredential: 'revision-only',
        artifactDigest: '0'.repeat(64),
      }),
    ).rejects.toThrow(/digest/)
  })

  it('treats an exited container as unavailable so the manager can replace it', async () => {
    const supervisor = new SandboxSupervisor(
      { run: async () => ({ stdout: 'false\n', stderr: '' }) },
      's'.repeat(32),
    )
    await expect(
      supervisor.handle({
        credential: 's'.repeat(32),
        action: 'inspect',
        workflowId: 'abcdef12-3456-7890',
        revision: 1,
      }),
    ).rejects.toThrow(/not running/)
  })

  it('applies a bounded, credential-free build policy and gates install scripts', async () => {
    const calls: Array<ReadonlyArray<string>> = []
    const supervisor = new SandboxSupervisor(
      {
        run: async (arguments_) => {
          calls.push(arguments_)
          return { stdout: '', stderr: '' }
        },
      },
      's'.repeat(32),
      '/safe/artifacts',
      'safe-runner',
      'safe-builder',
    )
    await supervisor.handle({
      credential: 's'.repeat(32),
      action: 'build',
      workflowId: 'abcdef12-3456-7890',
      revision: 3,
    })
    expect(calls[0]).toEqual([
      'run',
      '--rm',
      '--name',
      'dcmcp-abcdef12-3456-7890-3-build',
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
      'type=bind,src=/safe/artifacts/abcdef12-3456-7890/3/source,dst=/build/source,readonly',
      '--mount',
      'type=bind,src=/safe/artifacts/abcdef12-3456-7890/3/output,dst=/build/output',
      '--env',
      'DISCORD_MCP_ALLOW_INSTALL_SCRIPTS=false',
      'safe-builder',
    ])
  })

  it.each([
    'image',
    'mount',
    'name',
    'network',
    'memory',
    'cpus',
    'environment',
    'command',
  ])('rejects caller-controlled %s fields', async (field) => {
    const supervisor = new SandboxSupervisor(
      { run: async () => ({ stdout: '', stderr: '' }) },
      's'.repeat(32),
    )
    await expect(
      supervisor.handle({
        credential: 's'.repeat(32),
        action: 'start',
        workflowId: 'abcdef12-3456-7890',
        revision: 1,
        capabilityCredential: 'revision-only',
        [field]: 'attacker-controlled',
      }),
    ).rejects.toThrow(/unsupported supervisor field/)
  })

  it('rejects malformed identities, policies, missing capability credentials, and bad credentials', async () => {
    const supervisor = new SandboxSupervisor(
      { run: async () => ({ stdout: '', stderr: '' }) },
      's'.repeat(32),
    )
    await expect(
      supervisor.handle({
        credential: 's'.repeat(32),
        action: 'start',
        workflowId: 'abcdef12-3456-7890',
        revision: 1,
        capabilityCredential: 'revision-only',
        artifactDigest: '0'.repeat(64),
        image: 'attacker/image',
      }),
    ).rejects.toThrow(/unsupported supervisor field/)
    await expect(
      supervisor.handle({
        credential: 'wrong',
        action: 'inspect',
        workflowId: 'abcdef12-3456-7890',
        revision: 1,
      }),
    ).rejects.toThrow(/credential/)
    await expect(
      supervisor.handle({
        credential: 's'.repeat(32),
        action: 'start',
        workflowId: '../../escape',
        revision: 1,
      }),
    ).rejects.toThrow(/workflow identifier/)
    await expect(
      supervisor.handle({
        credential: 's'.repeat(32),
        action: 'start',
        workflowId: 'abcdef12-3456-7890',
        revision: 0,
      }),
    ).rejects.toThrow(/workflow revision/)
    await expect(
      supervisor.handle({
        credential: 's'.repeat(32),
        action: 'start',
        workflowId: 'abcdef12-3456-7890',
        revision: 1,
        artifactDigest: '0'.repeat(64),
      }),
    ).rejects.toThrow(/capability credential/)
  })
})
