import { SandboxError } from '@discord-mcp/core'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { artifactDigest, checkDependencies, lastStage, workspaceFiles } from '../src/build.ts'
import { handleLine } from '../src/server.ts'
import type { Supervisor } from '../src/supervisor.ts'

/**
 * The supervisor's two gates: what it accepts on the socket, and what it accepts as a dependency.
 *
 * Both are trust boundaries — the socket faces the MCP server, and the dependency list faces the
 * open npm registry.
 */

const CREDENTIAL = 'service-credential'

const recorded: Array<Record<string, unknown>> = []

const supervisor: Supervisor['Service'] = {
  build: (request) => {
    recorded.push({ kind: 'build', ...request })
    return Effect.succeed({ artifactDigest: 'sha256:x', manifest: {} as never, logs: '' })
  },
  start: (request) => {
    recorded.push({ kind: 'start', ...request })
    return Effect.succeed({ containerId: 'c1', exitCode: 0, timedOut: false, logs: '' })
  },
  stop: () => Effect.void,
  inspect: () => Effect.succeed({}),
  destroy: () => Effect.void,
}

const send = (line: string) =>
  Effect.runPromise(handleLine({ supervisor, serviceCredential: CREDENTIAL, line }))

const request = (command: Record<string, unknown>, credential = CREDENTIAL) =>
  JSON.stringify({ id: 'r1', credential, command })

describe('the supervisor socket', () => {
  it('refuses a request with the wrong service credential', async () => {
    const response = await send(request({ kind: 'stop', workflowId: 'wf', revision: 1 }, 'wrong'))
    expect(response).toMatchObject({ ok: false, error: { message: 'Unauthorized.' } })
  })

  it('refuses a request with no credential at all', async () => {
    const response = await send(
      JSON.stringify({ id: 'r1', command: { kind: 'stop', workflowId: 'wf', revision: 1 } }),
    )
    expect(response).toMatchObject({ ok: false })
  })

  it('refuses a malformed request without echoing anything back', async () => {
    const response = await send('{not json')
    expect(response).toMatchObject({ ok: false, error: { message: 'Malformed request.' } })
  })

  it('accepts only its five commands', async () => {
    // `exec` would be the obvious thing to add and the obvious thing to abuse.
    const response = await send(request({ kind: 'exec', workflowId: 'wf', revision: 1 }))
    expect(response).toMatchObject({ ok: false, error: { phase: 'protocol' } })
  })

  it('has no field in which a container name, image, mount, or network can be sent', async () => {
    const response = await send(
      request({
        kind: 'start',
        workflowId: 'wf',
        revision: 1,
        executionId: 'e1',
        capabilityCredential: 'cap',
        payload: null,
        timeoutSeconds: 30,
        // All of these are excess and are stripped before the supervisor sees them.
        image: 'attacker/evil:latest',
        name: 'discord-mcp-run-other-1',
        mounts: ['/:/host'],
        networkMode: 'host',
      }),
    )

    expect(response).toMatchObject({ ok: true })
    const start = recorded.find((r) => r.kind === 'start')
    expect(start).not.toHaveProperty('image')
    expect(start).not.toHaveProperty('mounts')
    expect(start).not.toHaveProperty('networkMode')
  })

  it('rejects a workflow id that is not a plain identifier', async () => {
    const response = await send(
      request({ kind: 'stop', workflowId: '../../../etc/passwd', revision: 1 }),
    )
    expect(response).toMatchObject({ ok: false, error: { phase: 'protocol' } })
  })

  it('reports a sandbox failure with its phase intact', async () => {
    const failing: Supervisor['Service'] = {
      ...supervisor,
      stop: () =>
        Effect.fail(new SandboxError({ message: 'Docker is not running.', phase: 'engine' })),
    }
    const response = await Effect.runPromise(
      handleLine({
        supervisor: failing,
        serviceCredential: CREDENTIAL,
        line: request({ kind: 'stop', workflowId: 'wf', revision: 1 }),
      }),
    )
    expect(response).toMatchObject({ ok: false, error: { phase: 'engine' } })
  })
})

describe('dependency policy', () => {
  it('accepts ordinary registry version ranges', () => {
    expect(checkDependencies({ zod: '^3.23.0', 'date-fns': '4.1.0' })).toEqual([])
  })

  it('refuses specifiers that resolve outside the configured registry', () => {
    const rejected = checkDependencies({
      evil: 'git+ssh://git@github.com/attacker/evil.git',
      local: 'file:../../../etc',
      linked: 'link:/opt',
      tarball: 'https://attacker.example/pkg.tgz',
      shorthand: 'attacker/evil',
    })
    expect(rejected.map((r) => r.name).sort()).toEqual([
      'evil',
      'linked',
      'local',
      'shorthand',
      'tarball',
    ])
  })

  it('refuses a workflow that tries to shadow the SDK', () => {
    const rejected = checkDependencies({ '@discord-mcp/workflow-sdk': '99.0.0' })
    expect(rejected[0]?.reason).toContain('provided by the build environment')
  })

  it('refuses more direct dependencies than the limit', () => {
    const many = Object.fromEntries(
      Array.from({ length: 101 }, (_, i) => [`pkg-${i}`, '1.0.0'] as const),
    )
    expect(checkDependencies(many).some((r) => r.name === '(all)')).toBe(true)
  })
})

describe('the build workspace', () => {
  const files = workspaceFiles({
    workflowId: 'wf',
    revision: 1,
    source: 'export default {}',
    dependencies: { zod: '^3.23.0' },
    allowInstallScripts: false,
  })

  it('contains only the workflow source and generated metadata', () => {
    expect(files.map((f) => f.path).sort()).toEqual([
      '/build/build.sh',
      '/build/emit-manifest.js',
      '/build/package.json',
      // The artifact's entry point, built here rather than baked into the runtime image so a
      // revision's runner and the SDK it compiled against stay pinned together.
      '/build/runner.js',
      '/build/src/index.ts',
      '/build/tsconfig.json',
    ])
  })

  it('carries no control-plane source or configuration', () => {
    const all = files.map((f) => f.contents).join('\n')
    expect(all).not.toContain('DISCORD_TOKEN')
    expect(all).not.toContain('DATABASE_PATH')
    expect(all).not.toContain('MASTER_KEY')
  })

  it('produces a lockfile so a build is reproducible', () => {
    const script = files.find((f) => f.path === '/build/build.sh')?.contents ?? ''
    expect(script).toContain('--lockfile-only')
    expect(script).toContain('--frozen-lockfile')
  })
})

describe('artifact addressing', () => {
  const base = { source: 'a', lockfile: 'b', manifest: 'c' }

  it('is stable for identical inputs', () => {
    expect(artifactDigest(base)).toBe(artifactDigest(base))
  })

  it('changes when the resolved dependency tree changes, even if the source did not', () => {
    expect(artifactDigest({ ...base, lockfile: 'b2' })).not.toBe(artifactDigest(base))
  })

  it('cannot be forged by moving content between fields', () => {
    // Without a separator, {source: "ab", lockfile: ""} would hash the same as {source: "a",
    // lockfile: "b"} — two different builds sharing one address.
    expect(artifactDigest({ source: 'ab', lockfile: '', manifest: 'c' })).not.toBe(
      artifactDigest(base),
    )
  })
})

describe('build stage attribution', () => {
  it('names the last stage the build reached', () => {
    expect(lastStage('::stage::install\n::stage::compile\nerror TS2304')).toBe('compile')
    expect(lastStage('')).toBe('start')
  })
})

describe('the generated scripts', () => {
  const scripts = workspaceFiles({
    workflowId: 'wf',
    revision: 1,
    source: '',
    dependencies: {},
    allowInstallScripts: false,
  })

  it('contain no backtick, which would close the template literal that holds them', () => {
    // These are shell and JavaScript sources embedded in TypeScript template literals. A backtick
    // in a comment terminates the literal early and the file stops parsing — a failure that shows
    // up as a syntax error dozens of lines away from the cause.
    for (const file of scripts) {
      expect(file.contents.includes('`'), `${file.path} contains a backtick`).toBe(false)
    }
  })

  it('relink the SDK after installing, because installing recreates node_modules', () => {
    const build = scripts.find((f) => f.path === '/build/build.sh')?.contents ?? ''
    const install = build.indexOf('--frozen-lockfile')
    const relink = build.indexOf('node_modules/@discord-mcp/workflow-sdk')

    expect(install).toBeGreaterThan(-1)
    expect(relink).toBeGreaterThan(install)
  })

  it('emit a runner into the artifact, since the runtime image has none', () => {
    const build = scripts.find((f) => f.path === '/build/build.sh')?.contents ?? ''
    expect(build).toContain('/artifact/runner.js')
    // -L, or the artifact would carry a symlink to a path that exists only in the build image.
    expect(build).toContain('cp -RL')
  })
})
