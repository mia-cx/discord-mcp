export interface DaemonCapabilities {
  readonly rootless: boolean
  readonly cgroupVersion: string
  readonly memoryLimit: boolean
  readonly pidsLimit: boolean
  readonly warnings: ReadonlyArray<string>
}

export const parseDaemonCapabilities = (value: string): DaemonCapabilities => {
  let info: {
    readonly SecurityOptions?: ReadonlyArray<string>
    readonly CgroupVersion?: string
    readonly MemoryLimit?: boolean
    readonly PidsLimit?: boolean
    readonly Warnings?: ReadonlyArray<string>
  }
  try {
    info = JSON.parse(value) as typeof info
  } catch {
    throw new Error('docker info returned invalid JSON')
  }
  return {
    rootless: (info.SecurityOptions ?? []).some((option) =>
      option.toLowerCase().includes('rootless'),
    ),
    cgroupVersion: info.CgroupVersion ?? 'unknown',
    memoryLimit: info.MemoryLimit === true,
    pidsLimit: info.PidsLimit === true,
    warnings: info.Warnings ?? [],
  }
}

export const daemonPreflightProblems = (
  capabilities: DaemonCapabilities,
  options: { readonly allowRootful: boolean },
): ReadonlyArray<string> => {
  const problems: string[] = []
  if (!capabilities.rootless && !options.allowRootful) {
    problems.push(
      'sandbox supervisor requires rootless Docker; set DISCORD_MCP_ALLOW_ROOTFUL_DOCKER=true only for isolated development',
    )
  }
  if (!capabilities.pidsLimit) {
    problems.push(
      'Docker cannot enforce PID limits; configure cgroup v2 delegation before running untrusted workflows',
    )
  }
  if (!capabilities.memoryLimit) {
    problems.push(
      'Docker cannot enforce memory limits; configure cgroup v2 delegation before running untrusted workflows',
    )
  }
  if (capabilities.cgroupVersion !== '2') {
    problems.push(
      `Docker reports cgroup v${capabilities.cgroupVersion}; workflow resource isolation requires cgroup v2`,
    )
  }
  return problems
}
