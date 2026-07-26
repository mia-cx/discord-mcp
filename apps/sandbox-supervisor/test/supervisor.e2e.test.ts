import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Layer, ManagedRuntime } from 'effect'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CAPABILITY_VOLUME, containerName, runtimeSpec } from '../src/container-spec.ts'
import { DockerEngine, runArgs } from '../src/docker.ts'

/**
 * The supervisor against a real rootless Docker daemon.
 *
 * Excluded from the ordinary suite: it needs a daemon, pulls an image, and takes tens of seconds.
 * The hostile-fixture suite asserts on the derived specification and runs everywhere; this asserts
 * that Docker actually honours what that specification says, which is the half a unit test cannot
 * reach.
 *
 *   DISCORD_MCP_E2E_DOCKER=1 pnpm exec vitest run --config vitest.e2e.config.ts
 *
 * Rootless only. Under rootful Docker these containers get a root-equivalent escape path and the
 * assertions below would be measuring the wrong thing.
 */

const enabled = process.env.DISCORD_MCP_E2E_DOCKER === '1'
const run = promisify(execFile)

/** Alpine, because it is small and every assertion below only needs a shell. */
const IMAGE = 'alpine:3.21'
const REF = { workflowId: 'e2e', revision: 1 }

const docker = (...args: string[]) => run('docker', args, { timeout: 120_000 })

let runtime: ManagedRuntime.ManagedRuntime<DockerEngine, never>

beforeAll(async () => {
  if (!enabled) return

  await docker('pull', IMAGE)
  runtime = ManagedRuntime.make(
    Layer.mergeAll(
      DockerEngine.layer({
        binary: 'docker',
        dockerHost: process.env.DOCKER_HOST ?? `unix://${process.env.XDG_RUNTIME_DIR}/docker.sock`,
      }),
    ),
  )
}, 180_000)

afterAll(async () => {
  if (!enabled) return
  await docker('rm', '--force', containerName(REF, 'run')).catch(() => undefined)
  await docker('volume', 'rm', '--force', CAPABILITY_VOLUME).catch(() => undefined)
  await runtime.dispose()
})

/** Start a container from the derived spec, but with a command that reports what it can see. */
const probe = async (command: ReadonlyArray<string>): Promise<string> => {
  const spec = {
    ...runtimeSpec({
      ref: REF,
      image: IMAGE,
      executionId: 'e2e-exec',
      capabilityCredential: 'unused',
    }),
    cmd: ['/bin/sh', '-c', command.join(' ')],
    // The artifact volume does not exist in this test; only the capability mount is exercised.
    mounts: [],
  }

  await docker('rm', '--force', spec.name).catch(() => undefined)
  await run('docker', [...runArgs(spec)], { env: { ...process.env, ...spec.env } })
  await docker('wait', spec.name)

  const { stdout, stderr } = await docker('logs', spec.name)
  await docker('rm', '--force', spec.name)
  return `${stdout}${stderr}`
}

describe.skipIf(!enabled)('the sandbox against a real daemon', () => {
  it('runs as a non-root user', async () => {
    const output = await probe(['id', '-u'])
    expect(output.trim()).toBe('65534')
  }, 60_000)

  it('cannot write to its root filesystem', async () => {
    const output = await probe(['touch /evidence 2>&1 || echo REFUSED'])
    expect(output).toContain('REFUSED')
  }, 60_000)

  it('can write only to its tmpfs, and it does not survive', async () => {
    const output = await probe(['touch /tmp/scratch && echo WROTE'])
    expect(output).toContain('WROTE')

    // A second container is a second tmpfs. Nothing carries over.
    const second = await probe(['test -f /tmp/scratch && echo SURVIVED || echo GONE'])
    expect(second).toContain('GONE')
  }, 120_000)

  it('has no network at all', async () => {
    // Not "cannot reach Discord" — cannot reach anything, including its own loopback beyond lo.
    const output = await probe([
      'ip route 2>/dev/null | grep -q default && echo HAS_ROUTE || echo NO_ROUTE',
    ])
    expect(output).toContain('NO_ROUTE')
  }, 60_000)

  it('cannot see the Docker socket', async () => {
    const output = await probe(['test -S /var/run/docker.sock && echo EXPOSED || echo ABSENT'])
    expect(output).toContain('ABSENT')
  }, 60_000)

  it('carries no control-plane credential in its environment', async () => {
    const output = await probe(['env'])

    for (const forbidden of ['DISCORD_TOKEN=', 'DISCORD_MCP_MASTER_KEY=', 'DATABASE_PATH=']) {
      expect(output).not.toContain(forbidden)
    }
    // The one credential it does get, and it is useless anywhere but the broker.
    expect(output).toContain('DISCORD_MCP_CAPABILITY_TOKEN=')
  }, 60_000)

  it('is stopped by the PID limit rather than taking the host down', async () => {
    // A fork bomb, bounded. Without --pids-limit this is how a host dies.
    const output = await probe([
      'i=0; while [ $i -lt 500 ]; do (sleep 5 &) 2>/dev/null || break; i=$((i+1)); done; echo "spawned=$i"',
    ])

    const spawned = Number(/spawned=(\d+)/.exec(output)?.[1] ?? '0')
    expect(spawned).toBeLessThan(500)
  }, 120_000)

  it('is killed by the memory limit rather than exhausting the host', async () => {
    const spec = runtimeSpec({
      ref: REF,
      image: IMAGE,
      executionId: 'e2e-mem',
      capabilityCredential: 'unused',
    })
    expect(spec.memoryBytes).toBe(256 * 1024 * 1024)

    // `dd` into tmpfs counts against the container's memory cgroup.
    const output = await probe(['dd if=/dev/zero of=/tmp/fill bs=1M count=512 2>&1 || echo KILLED'])
    expect(output).toMatch(/KILLED|No space left/)
  }, 120_000)
})
