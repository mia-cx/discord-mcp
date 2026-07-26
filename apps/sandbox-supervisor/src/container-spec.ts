/**
 * Container specifications.
 *
 * The supervisor is the only process holding the rootless Docker socket, and it accepts **no**
 * arbitrary strings: names, images, mounts, networks, and limits are all derived from a workflow
 * revision identifier. A supervisor that took a container name from its caller would be a remote
 * code execution primitive wearing a narrow API.
 */

export interface RevisionRef {
  readonly workflowId: string
  readonly revision: number
}

/** Deterministic and namespaced, so a stray container is identifiable and never collides. */
export const containerName = (ref: RevisionRef, purpose: 'build' | 'run'): string =>
  `discord-mcp-${purpose}-${ref.workflowId}-${ref.revision}`

export const artifactVolume = (ref: RevisionRef): string =>
  `discord-mcp-artifact-${ref.workflowId}-${ref.revision}`

/**
 * Where the capability RPC socket appears inside the container.
 *
 * A workflow has no network, so this socket is its only channel to anything.
 *
 * One shared volume, one subdirectory per execution. The control plane serves the socket, because
 * that is where the grants and the Discord credentials already are — the supervisor holds neither
 * and does not become a relay for them. The subpath is what keeps one execution's socket out of
 * another's reach: a container sees its own directory and no sibling's.
 */
export const CAPABILITY_MOUNT = '/run/capability'
export const CAPABILITY_SOCKET = `${CAPABILITY_MOUNT}/broker.sock`
export const CAPABILITY_VOLUME = 'discord-mcp-capability'

export interface RuntimeLimits {
  readonly memoryBytes: number
  readonly cpus: number
  readonly pidsLimit: number
  readonly timeoutSeconds: number
}

export const DEFAULT_RUNTIME_LIMITS: RuntimeLimits = {
  memoryBytes: 256 * 1024 * 1024,
  cpus: 1,
  // A fork bomb is the cheapest denial-of-service available to arbitrary code, and it is stopped
  // by a number rather than by anything clever.
  pidsLimit: 128,
  timeoutSeconds: 30,
}

export interface ContainerSpec {
  readonly name: string
  readonly image: string
  readonly cmd: ReadonlyArray<string>
  readonly env: Readonly<Record<string, string>>
  readonly readonlyRootfs: boolean
  readonly networkMode: string
  readonly user: string
  readonly capDrop: ReadonlyArray<string>
  readonly securityOpt: ReadonlyArray<string>
  readonly pidsLimit: number
  readonly memoryBytes: number
  readonly nanoCpus: number
  readonly tmpfs: Readonly<Record<string, string>>
  readonly mounts: ReadonlyArray<Mount>
}

export interface Mount {
  readonly source: string
  readonly target: string
  readonly readOnly: boolean
  readonly type: 'volume'
  /**
   * Why this mount exists. The capability socket is the one place a runtime container needs write
   * access — `connect(2)` on a Unix socket requires it — so the purpose is recorded rather than
   * inferred from a path, and the validator permits writability for exactly this one.
   */
  readonly purpose: 'artifact' | 'capability'
  /** Restricts the mount to one subdirectory of a shared volume. */
  readonly subpath?: string
}

/**
 * The runtime container.
 *
 * Every field here is a control the hostile-fixture suite tries to defeat. `network: 'none'` is
 * the load-bearing one: without direct networking, a workflow cannot reach Discord, the control
 * plane's database, a metadata service, or anything else except through the capability RPC socket,
 * which checks grants on every call.
 */
export const runtimeSpec = (input: {
  readonly ref: RevisionRef
  readonly image: string
  readonly executionId: string
  readonly capabilityCredential: string
  readonly limits?: RuntimeLimits
}): ContainerSpec => {
  const limits = input.limits ?? DEFAULT_RUNTIME_LIMITS

  return {
    name: containerName(input.ref, 'run'),
    image: input.image,
    cmd: ['node', '/artifact/runner.js'],
    env: {
      // The one credential a workflow gets. It is useless against anything but the broker, and
      // only within this revision's grants.
      DISCORD_MCP_CAPABILITY_TOKEN: input.capabilityCredential,
      DISCORD_MCP_CAPABILITY_SOCKET: CAPABILITY_SOCKET,
      DISCORD_MCP_WORKFLOW_ID: input.ref.workflowId,
      DISCORD_MCP_REVISION: String(input.ref.revision),
      DISCORD_MCP_EXECUTION_ID: input.executionId,
      NODE_ENV: 'production',
    },
    readonlyRootfs: true,
    // No direct network. Everything goes through the broker's Unix socket.
    networkMode: 'none',
    // Non-root, and a UID with nothing on the host.
    user: '65534:65534',
    capDrop: ['ALL'],
    // Stops a setuid binary regaining privilege even if one somehow exists in the image.
    securityOpt: ['no-new-privileges'],
    pidsLimit: limits.pidsLimit,
    memoryBytes: limits.memoryBytes,
    nanoCpus: limits.cpus * 1_000_000_000,
    // The only writable path, and it does not survive the container.
    tmpfs: { '/tmp': 'rw,noexec,nosuid,size=16m' },
    mounts: [
      {
        source: artifactVolume(input.ref),
        target: '/artifact',
        readOnly: true,
        type: 'volume',
        purpose: 'artifact',
      },
      {
        source: CAPABILITY_VOLUME,
        target: CAPABILITY_MOUNT,
        readOnly: false,
        type: 'volume',
        purpose: 'capability',
        // Scoped to this execution's directory, so one workflow cannot reach another's socket even
        // though the volume is shared.
        subpath: input.executionId,
      },
    ],
  }
}

/**
 * The build container.
 *
 * Networked, because resolving arbitrary npm is the point — but it receives no Discord credential,
 * no database, no control-plane source, and no production route secrets. A malicious package's
 * install script runs here or not at all, and only when the grant says so.
 */
export const buildSpec = (input: {
  readonly ref: RevisionRef
  readonly image: string
  readonly registry: string
  readonly allowInstallScripts: boolean
}): ContainerSpec => ({
  name: containerName(input.ref, 'build'),
  image: input.image,
  cmd: ['/bin/sh', '/build/build.sh'],
  env: {
    NPM_CONFIG_REGISTRY: input.registry,
    // Off by default. A lifecycle script is arbitrary code from a third party, running with
    // whatever the build container has.
    NPM_CONFIG_IGNORE_SCRIPTS: input.allowInstallScripts ? 'false' : 'true',
    NODE_ENV: 'production',
    CI: 'true',
  },
  readonlyRootfs: false,
  networkMode: 'bridge',
  user: '65534:65534',
  capDrop: ['ALL'],
  securityOpt: ['no-new-privileges'],
  pidsLimit: 512,
  memoryBytes: 1024 * 1024 * 1024,
  nanoCpus: 2_000_000_000,
  tmpfs: { '/tmp': 'rw,size=256m' },
  mounts: [
    {
      source: artifactVolume(input.ref),
      target: '/artifact',
      readOnly: false,
      type: 'volume',
      purpose: 'artifact',
    },
  ],
})

/**
 * Environment variables that must never reach a container.
 *
 * The supervisor builds `env` from scratch rather than inheriting, so this is a belt-and-braces
 * assertion the hostile-fixture suite can check directly.
 */
export const FORBIDDEN_ENV_SUBSTRINGS: ReadonlyArray<string> = [
  'DISCORD_TOKEN',
  'DISCORD_CLIENT_SECRET',
  'DISCORD_MCP_MASTER_KEY',
  'DATABASE_PATH',
  'OIDC_',
  'SUPERVISOR_SOCKET',
]

export interface SpecViolation {
  readonly field: string
  readonly reason: string
}

/**
 * Verify a spec before it reaches Docker.
 *
 * The supervisor constructs these itself, so this can only fail if the supervisor's own code is
 * wrong — which is exactly when a check is worth having, because nothing else would catch it.
 */
export const validateRuntimeSpec = (spec: ContainerSpec): ReadonlyArray<SpecViolation> => {
  const violations: SpecViolation[] = []
  const fail = (field: string, reason: string) => violations.push({ field, reason })

  if (spec.networkMode !== 'none') {
    fail(
      'networkMode',
      'A runtime container must have no direct network. Without that, a workflow could reach Discord, the control plane, or a cloud metadata service directly instead of through the broker.',
    )
  }
  if (!spec.readonlyRootfs) fail('readonlyRootfs', 'The root filesystem must be read-only.')
  if (spec.user === 'root' || spec.user.startsWith('0:')) fail('user', 'Must not run as root.')
  if (!spec.capDrop.includes('ALL')) fail('capDrop', 'All Linux capabilities must be dropped.')
  if (!spec.securityOpt.includes('no-new-privileges')) {
    fail('securityOpt', 'no-new-privileges must be set.')
  }
  if (spec.pidsLimit <= 0 || spec.pidsLimit > 512) {
    fail('pidsLimit', 'A PID limit is what stops a fork bomb; it must be set and modest.')
  }
  if (spec.memoryBytes <= 0) fail('memoryBytes', 'A memory limit must be set.')

  for (const violation of mountViolations(spec.mounts)) violations.push(violation)
  for (const violation of envViolations(spec.env)) violations.push(violation)

  return violations
}

const mountViolations = (mounts: ReadonlyArray<Mount>): ReadonlyArray<SpecViolation> => {
  const violations: SpecViolation[] = []
  const fail = (reason: string) => violations.push({ field: 'mounts', reason })

  for (const mount of mounts) {
    if (mount.type !== 'volume') {
      fail(`Only named volumes may be mounted; "${mount.source}" is not one.`)
    }
    // The capability socket is the sole exception, because connecting to a Unix socket needs write
    // permission on it. It contains nothing else.
    if (!mount.readOnly && mount.purpose !== 'capability') {
      fail(`Runtime mounts must be read-only; "${mount.target}" is not.`)
    }
    if (mount.purpose === 'capability' && mount.target !== CAPABILITY_MOUNT) {
      fail(`The capability mount must be at ${CAPABILITY_MOUNT}.`)
    }
    // The Docker socket is the whole ballgame: mounting it would hand a workflow the host.
    if (mount.source.includes('docker.sock') || mount.target.includes('docker.sock')) {
      fail('The Docker socket must never be mounted into a workflow container.')
    }
  }

  if (mounts.filter((m) => !m.readOnly).length > 1) {
    fail('At most one mount — the capability socket — may be writable.')
  }

  return violations
}

const envViolations = (env: Readonly<Record<string, string>>): ReadonlyArray<SpecViolation> => {
  const violations: SpecViolation[] = []

  for (const [key, value] of Object.entries(env)) {
    for (const forbidden of FORBIDDEN_ENV_SUBSTRINGS) {
      if (key.includes(forbidden)) {
        violations.push({
          field: 'env',
          reason: `"${key}" looks like a control-plane credential and must not be passed in.`,
        })
      }
      if (value.includes(forbidden)) {
        violations.push({ field: 'env', reason: `The value of "${key}" mentions ${forbidden}.` })
      }
    }
  }

  return violations
}
