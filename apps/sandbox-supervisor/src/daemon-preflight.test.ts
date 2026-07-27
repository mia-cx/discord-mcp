import { describe, expect, it } from 'vitest'
import { daemonPreflightProblems, parseDaemonCapabilities } from './daemon-preflight.js'

const capable = {
  rootless: true,
  cgroupVersion: '2',
  memoryLimit: true,
  pidsLimit: true,
  warnings: [],
}

describe('Docker daemon preflight', () => {
  it('parses the enforcement properties reported by docker info', () => {
    expect(
      parseDaemonCapabilities(
        JSON.stringify({
          SecurityOptions: ['name=seccomp', 'name=rootless'],
          CgroupVersion: '2',
          MemoryLimit: true,
          PidsLimit: true,
          Warnings: ['example'],
        }),
      ),
    ).toEqual({ ...capable, warnings: ['example'] })
  })

  it('accepts a rootless cgroup-v2 daemon with delegated limits', () => {
    expect(daemonPreflightProblems(capable, { allowRootful: false })).toEqual([])
  })

  it('refuses silent resource-limit failures', () => {
    expect(
      daemonPreflightProblems(
        { ...capable, cgroupVersion: '1', memoryLimit: false, pidsLimit: false },
        { allowRootful: false },
      ),
    ).toEqual([
      expect.stringContaining('PID limits'),
      expect.stringContaining('memory limits'),
      expect.stringContaining('cgroup v1'),
    ])
  })

  it('allows an explicit rootful development override without weakening limit checks', () => {
    expect(
      daemonPreflightProblems({ ...capable, rootless: false }, { allowRootful: true }),
    ).toEqual([])
    expect(
      daemonPreflightProblems(
        { ...capable, rootless: false, memoryLimit: false },
        { allowRootful: true },
      ),
    ).toEqual([expect.stringContaining('memory limits')])
  })
})
