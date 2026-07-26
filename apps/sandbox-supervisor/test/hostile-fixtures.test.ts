import { describe, expect, it } from 'vitest'
import {
  buildSpec,
  CAPABILITY_MOUNT,
  type ContainerSpec,
  containerName,
  DEFAULT_RUNTIME_LIMITS,
  FORBIDDEN_ENV_SUBSTRINGS,
  type Mount,
  runtimeSpec,
  validateRuntimeSpec,
} from '../src/container-spec.ts'
import { runArgs } from '../src/docker.ts'

/**
 * The hostile-fixture suite, container half.
 *
 * Each case is something a malicious workflow would actually try. These assert on the *derived
 * specification* rather than on a running container, so they run in ordinary CI and fail the moment
 * a restriction is dropped — which is when it matters, not months later when someone exploits it.
 */

const ref = { workflowId: 'wf-hostile', revision: 3 }

const spec = runtimeSpec({
  ref,
  image: 'discord-mcp/workflow-runner:latest',
  executionId: 'exec-1',
  capabilityCredential: 'cap-token',
})

/** Bypass the constructor to model a supervisor bug the validator has to catch. */
const tampered = (changes: Partial<ContainerSpec>): ContainerSpec => ({ ...spec, ...changes })

const reasons = (s: ContainerSpec) => validateRuntimeSpec(s).map((v) => `${v.field}: ${v.reason}`)

describe('a correctly derived runtime container', () => {
  it('passes its own safety checks', () => {
    expect(validateRuntimeSpec(spec)).toEqual([])
  })

  it('carries every restriction into the docker arguments', () => {
    const args = runArgs(spec).join(' ')

    expect(args).toContain('--network none')
    expect(args).toContain('--read-only')
    expect(args).toContain('--cap-drop ALL')
    expect(args).toContain('--security-opt no-new-privileges')
    expect(args).toContain('--pids-limit 128')
    expect(args).toContain(`--memory ${256 * 1024 * 1024}`)
    expect(args).toContain('--cpus 1')
    expect(args).toContain('--user 65534:65534')
  })

  it('never puts the capability credential in the supervisor argv', () => {
    // `--env KEY=VALUE` would expose it through /proc to anything on the host.
    const args = runArgs(spec)
    expect(args).toContain('--env')
    expect(args).toContain('DISCORD_MCP_CAPABILITY_TOKEN')
    expect(args.some((a) => a.includes('cap-token'))).toBe(false)
  })
})

describe('a fixture that tries to read the control plane’s environment', () => {
  it('finds no Discord credential, master key, or database path', () => {
    const serialised = JSON.stringify(spec.env)
    for (const forbidden of FORBIDDEN_ENV_SUBSTRINGS) {
      expect(serialised).not.toContain(forbidden)
    }
  })

  it('is refused if a supervisor bug ever tried to pass one', () => {
    const leaked = tampered({ env: { ...spec.env, DISCORD_TOKEN: 'Bot abc' } })
    expect(reasons(leaked).join('\n')).toContain('env: "DISCORD_TOKEN"')
  })
})

describe('a fixture that tries to reach the host', () => {
  it('cannot be given a Docker socket mount', () => {
    const withSocket = tampered({
      mounts: [
        ...spec.mounts,
        {
          source: '/var/run/docker.sock',
          target: '/var/run/docker.sock',
          readOnly: true,
          type: 'volume',
          purpose: 'artifact',
        } satisfies Mount,
      ],
    })
    expect(reasons(withSocket).join('\n')).toContain('The Docker socket must never be mounted')
  })

  it('cannot be given a writable mount other than the capability socket', () => {
    const writable = tampered({
      mounts: [
        {
          source: 'anything',
          target: '/artifact',
          readOnly: false,
          type: 'volume',
          purpose: 'artifact',
        } satisfies Mount,
      ],
    })
    expect(reasons(writable).join('\n')).toContain('must be read-only')
  })

  it('gets exactly one writable path, and it is the capability socket', () => {
    const writable = spec.mounts.filter((m) => !m.readOnly)
    expect(writable).toHaveLength(1)
    expect(writable[0]?.target).toBe(CAPABILITY_MOUNT)
  })

  it('has no host bind mount of any kind', () => {
    // Only named volumes exist in the spec type, so a host path cannot be expressed at all.
    expect(spec.mounts.every((m) => m.type === 'volume')).toBe(true)
  })

  it('writes only to an ephemeral tmpfs that does not survive the container', () => {
    expect(spec.tmpfs['/tmp']).toContain('noexec')
    expect(spec.tmpfs['/tmp']).toContain('nosuid')
  })
})

describe('a fixture that tries to exhaust the host', () => {
  it('cannot fork-bomb past the PID limit', () => {
    expect(spec.pidsLimit).toBe(128)
    expect(reasons(tampered({ pidsLimit: 0 })).join('\n')).toContain('fork bomb')
  })

  it('cannot exceed its memory allocation', () => {
    expect(spec.memoryBytes).toBe(256 * 1024 * 1024)
    expect(reasons(tampered({ memoryBytes: 0 })).join('\n')).toContain('memory limit')
  })

  it('cannot outlive its deadline', () => {
    expect(DEFAULT_RUNTIME_LIMITS.timeoutSeconds).toBeGreaterThan(0)
  })
})

describe('a fixture that tries to reach the network', () => {
  it('cannot bind a port or dial out, because it has no network at all', () => {
    expect(spec.networkMode).toBe('none')
    expect(reasons(tampered({ networkMode: 'bridge' })).join('\n')).toContain('no direct network')
  })
})

describe('a fixture that tries to escalate privilege', () => {
  it('cannot run as root', () => {
    expect(reasons(tampered({ user: 'root' })).join('\n')).toContain('Must not run as root')
    expect(reasons(tampered({ user: '0:0' })).join('\n')).toContain('Must not run as root')
  })

  it('cannot regain capabilities through a setuid binary', () => {
    expect(reasons(tampered({ securityOpt: [] })).join('\n')).toContain('no-new-privileges')
    expect(reasons(tampered({ capDrop: [] })).join('\n')).toContain('capabilities must be dropped')
  })

  it('cannot write to its own root filesystem', () => {
    expect(reasons(tampered({ readonlyRootfs: false })).join('\n')).toContain('read-only')
  })
})

describe('the build container', () => {
  const build = buildSpec({
    ref,
    image: 'discord-mcp/workflow-build:latest',
    registry: 'https://registry.npmjs.org/',
    allowInstallScripts: false,
  })

  it('refuses lifecycle scripts unless the grant allows them', () => {
    expect(build.env.NPM_CONFIG_IGNORE_SCRIPTS).toBe('true')

    const permitted = buildSpec({
      ref,
      image: 'discord-mcp/workflow-build:latest',
      registry: 'https://registry.npmjs.org/',
      allowInstallScripts: true,
    })
    expect(permitted.env.NPM_CONFIG_IGNORE_SCRIPTS).toBe('false')
  })

  it('receives no Discord credential, master key, or database even though it has a network', () => {
    expect(build.networkMode).toBe('bridge')
    const serialised = JSON.stringify(build.env)
    for (const forbidden of FORBIDDEN_ENV_SUBSTRINGS) {
      expect(serialised).not.toContain(forbidden)
    }
  })

  it('still drops capabilities and runs unprivileged', () => {
    expect(build.user).not.toBe('root')
    expect(build.capDrop).toContain('ALL')
    expect(build.securityOpt).toContain('no-new-privileges')
  })
})

describe('container naming', () => {
  it('is derived, never supplied', () => {
    // The protocol carries a workflow id and a revision; the name is a function of them, so there
    // is nothing for a caller to inject.
    expect(containerName(ref, 'run')).toBe('discord-mcp-run-wf-hostile-3')
    expect(containerName(ref, 'build')).toBe('discord-mcp-build-wf-hostile-3')
  })
})
