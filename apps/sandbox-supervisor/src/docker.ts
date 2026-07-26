import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SandboxError } from '@discord-mcp/core'
import { Context, Effect, Layer } from 'effect'
import type { ContainerSpec } from './container-spec.ts'

/**
 * The rootless Docker boundary.
 *
 * Commands are built as argv arrays and run with `execFile`, never a shell string. There is no
 * interpolation point a workflow slug could reach, because there is no shell to interpolate into.
 */

/**
 * Translate a spec into `docker run` arguments.
 *
 * Pure and exported so the hostile-fixture suite can assert on the exact flags without Docker
 * installed. If a restriction is missing here it is missing in production.
 */
export const runArgs = (spec: ContainerSpec): ReadonlyArray<string> => {
  const args = [
    'run',
    '--detach',
    '--name',
    spec.name,
    '--network',
    spec.networkMode,
    '--user',
    spec.user,
    '--pids-limit',
    String(spec.pidsLimit),
    '--memory',
    String(spec.memoryBytes),
    // Docker takes a fraction of a CPU as nano-CPUs; there is no float flag that means the same.
    '--cpus',
    String(spec.nanoCpus / 1_000_000_000),
  ]

  if (spec.readonlyRootfs) args.push('--read-only')
  for (const cap of spec.capDrop) args.push('--cap-drop', cap)
  for (const opt of spec.securityOpt) args.push('--security-opt', opt)
  for (const [path, options] of Object.entries(spec.tmpfs))
    args.push('--tmpfs', `${path}:${options}`)

  for (const mount of spec.mounts) {
    const parts = [`type=${mount.type}`, `source=${mount.source}`, `target=${mount.target}`]
    if (mount.readOnly) parts.push('readonly')
    if (mount.subpath !== undefined) parts.push(`volume-subpath=${mount.subpath}`)
    args.push('--mount', parts.join(','))
  }

  // `--env KEY=VALUE` would put the credential in the supervisor's own argv, where anything on the
  // host can read it from /proc. `--env KEY` reads it from the environment we hand execFile.
  for (const key of Object.keys(spec.env)) args.push('--env', key)

  args.push(spec.image, ...spec.cmd)
  return args
}

export interface DockerResult {
  readonly stdout: string
  readonly stderr: string
}

export class DockerEngine extends Context.Service<
  DockerEngine,
  {
    readonly run: (
      spec: ContainerSpec,
    ) => Effect.Effect<{ readonly containerId: string }, SandboxError>
    readonly wait: (
      name: string,
      timeoutMs: number,
    ) => Effect.Effect<{ readonly exitCode: number; readonly timedOut: boolean }, SandboxError>
    readonly logs: (name: string, maxBytes: number) => Effect.Effect<string, SandboxError>
    readonly inspect: (name: string) => Effect.Effect<unknown, SandboxError>
    readonly stop: (name: string) => Effect.Effect<void, SandboxError>
    readonly destroy: (name: string) => Effect.Effect<void, SandboxError>
    readonly createVolume: (name: string) => Effect.Effect<void, SandboxError>
    readonly removeVolume: (name: string) => Effect.Effect<void, SandboxError>
    readonly copyInto: (
      name: string,
      files: ReadonlyArray<{ readonly path: string; readonly contents: string }>,
    ) => Effect.Effect<void, SandboxError>
    /** Read one file back out of a container, running or stopped. */
    readonly readFile: (name: string, path: string) => Effect.Effect<string, SandboxError>
  }
>()('sandbox-supervisor/DockerEngine') {
  static readonly layer = (options: {
    readonly binary: string
    readonly dockerHost: string
  }): Layer.Layer<DockerEngine> =>
    Layer.sync(DockerEngine)(() => {
      const exec = (
        args: ReadonlyArray<string>,
        env: Readonly<Record<string, string>> = {},
        timeoutMs = 60_000,
      ): Effect.Effect<DockerResult, SandboxError> =>
        Effect.callback<DockerResult, SandboxError>((resume) => {
          const child = execFile(
            options.binary,
            [...args],
            {
              // Deliberately not `process.env`. The supervisor holds the master key and the bot
              // token; inheriting would put both one `--env` flag away from a container.
              env: {
                PATH: process.env.PATH ?? '/usr/bin:/bin',
                DOCKER_HOST: options.dockerHost,
                ...env,
              },
              timeout: timeoutMs,
              maxBuffer: 8 * 1024 * 1024,
            },
            (error, stdout, stderr) => {
              if (error === null) {
                resume(Effect.succeed({ stdout, stderr }))
                return
              }
              resume(
                Effect.fail(
                  new SandboxError({
                    message: `docker ${args[0] ?? ''} failed: ${stderr.trim() || error.message}`,
                    phase: 'engine',
                  }),
                ),
              )
            },
          )
          return Effect.sync(() => {
            child.kill('SIGKILL')
          })
        })

      return {
        run: (spec) =>
          Effect.map(exec(runArgs(spec), spec.env), ({ stdout }) => ({
            containerId: stdout.trim(),
          })),

        wait: (name, timeoutMs) =>
          Effect.map(Effect.result(exec(['wait', name], {}, timeoutMs)), (result) =>
            result._tag === 'Success'
              ? { exitCode: Number(result.success.stdout.trim()), timedOut: false }
              : // A container that outran the deadline is killed by the caller; reporting it as a
                // timeout rather than an engine error keeps the two distinguishable upstream.
                { exitCode: -1, timedOut: true },
          ),

        logs: (name, maxBytes) =>
          Effect.map(exec(['logs', '--tail', '2000', name]), ({ stdout, stderr }) =>
            `${stdout}${stderr}`.slice(0, maxBytes),
          ),

        inspect: (name) =>
          Effect.flatMap(exec(['inspect', name]), ({ stdout }) =>
            Effect.try({
              try: () => JSON.parse(stdout) as unknown,
              catch: () =>
                new SandboxError({
                  message: 'docker inspect returned invalid JSON',
                  phase: 'engine',
                }),
            }),
          ),

        stop: (name) => Effect.asVoid(exec(['stop', '--timeout', '5', name])),

        // Forced. A container past its deadline has already had its chance to stop politely.
        destroy: (name) => Effect.asVoid(Effect.ignore(exec(['rm', '--force', '--volumes', name]))),

        createVolume: (name) => Effect.asVoid(exec(['volume', 'create', name])),

        removeVolume: (name) =>
          Effect.asVoid(Effect.ignore(exec(['volume', 'rm', '--force', name]))),

        copyInto: (name, files) =>
          Effect.forEach(
            files,
            // Staged through the supervisor's own temp directory, then `docker cp`. The supervisor
            // is trusted with a filesystem; the container still gets no host mount, because `cp` is
            // a copy rather than a mount.
            (file) =>
              Effect.acquireUseRelease(
                Effect.tryPromise({
                  try: () => mkdtemp(join(tmpdir(), 'discord-mcp-stage-')),
                  catch: (cause) =>
                    new SandboxError({
                      message: `Could not stage ${file.path}: ${cause}`,
                      phase: 'build',
                    }),
                }),
                (dir) => {
                  const staged = join(dir, 'file')
                  return Effect.tryPromise({
                    try: () => writeFile(staged, file.contents, { mode: 0o600 }),
                    catch: (cause) =>
                      new SandboxError({
                        message: `Could not stage ${file.path}: ${cause}`,
                        phase: 'build',
                      }),
                  }).pipe(
                    Effect.andThen(Effect.asVoid(exec(['cp', staged, `${name}:${file.path}`]))),
                  )
                },
                (dir) =>
                  Effect.ignore(Effect.promise(() => rm(dir, { recursive: true, force: true }))),
              ),
            { discard: true },
          ),

        readFile: (name, path) =>
          Effect.acquireUseRelease(
            Effect.tryPromise({
              try: () => mkdtemp(join(tmpdir(), 'discord-mcp-read-')),
              catch: (cause) =>
                new SandboxError({ message: `Could not read ${path}: ${cause}`, phase: 'engine' }),
            }),
            (dir) => {
              const staged = join(dir, 'file')
              return exec(['cp', `${name}:${path}`, staged]).pipe(
                Effect.andThen(
                  Effect.tryPromise({
                    try: () => readFile(staged, 'utf8'),
                    catch: (cause) =>
                      new SandboxError({
                        message: `Could not read ${path}: ${cause}`,
                        phase: 'engine',
                      }),
                  }),
                ),
              )
            },
            (dir) => Effect.ignore(Effect.promise(() => rm(dir, { recursive: true, force: true }))),
          ),
      }
    })
}
