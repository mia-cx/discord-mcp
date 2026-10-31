import { spawn } from 'node:child_process'
import { lstat, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer, request as httpRequest, type Server } from 'node:http'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RUNTIME_MODULES } from './bundle.ts'

export const NPM_REGISTRY = 'https://registry.npmjs.org/'
const DIRECT_DEPENDENCY_LIMIT = 100
const INSTALL_TIMEOUT_MS = 120_000
const INSTALL_LIMIT_BYTES = 256 * 1024 * 1024
const SIZE_CHECK_MS = 250
/** A filesystem block: the least any file or directory occupies. */
const BLOCK_BYTES = 4096
const INSTALL_CONCURRENCY = 2
const ERROR_LINES = 10
/** Where npm places a package: nested `node_modules` directories, never out of the install. */
const INSTALL_PATH =
  /^node_modules\/(?:(?:@[^/.][^/]*\/)?[^/.][^/]*\/node_modules\/)*(?:@[^/.][^/]*\/)?[^/.][^/]*$/
/** npm's own package-name rule. */
const PACKAGE_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/
/** Versions, ranges, and tags. Paths, URLs, git, and `npm:` aliases all contain `/` or `:`. */
const REGISTRY_SPEC = /^[^./:\\][^/:\\]*$/

/** Dependencies npm could not install, with what npm reported. */
export class DependencyError extends Error {
  constructor(
    message: string,
    readonly issues: ReadonlyArray<string>,
  ) {
    super(message)
    this.name = 'DependencyError'
  }
}

/** The npm packages a workflow imports. */
export interface Dependencies {
  /** Package names to versions, ranges, or tags. */
  readonly dependencies: Readonly<Record<string, string>>
  /** A package-lock.json for them, to install exactly the versions it pins. */
  readonly lockfile?: string
  readonly registry?: string
}

/** The parts of a package-lock.json read here. An agent's may hold anything. */
interface Lockfile {
  readonly packages?: Readonly<
    Record<
      string,
      {
        readonly name?: string
        readonly version?: string
        readonly resolved?: unknown
        readonly link?: boolean
        /** Shipped inside its parent's tarball, so it has no URL of its own. */
        readonly inBundle?: boolean
      } | null
    >
  >
}

const checkDependencies = (dependencies: Readonly<Record<string, string>>) => {
  const names = Object.keys(dependencies)
  if (names.length > DIRECT_DEPENDENCY_LIMIT) {
    throw new DependencyError(`List at most ${DIRECT_DEPENDENCY_LIMIT} dependencies.`, [])
  }
  const issues = Object.entries(dependencies).flatMap(([name, spec]) => {
    if (RUNTIME_MODULES.includes(name)) {
      return [`dependencies.${name}: remove it; workflows always import the platform’s ${name}.`]
    }
    if (!PACKAGE_NAME.test(name)) return [`dependencies: "${name}" is not an npm package name.`]
    if (!REGISTRY_SPEC.test(spec)) {
      return [`dependencies.${name}: use a version, range, or tag from the npm registry.`]
    }
    return []
  })
  if (issues.length > 0) throw new DependencyError('The dependencies are not valid.', issues)
}

/** A lockfile may install only packages from the registry, never a local path or another URL. */
const checkLockfile = (text: string, registry: string) => {
  let lock: Lockfile | null
  try {
    lock = JSON.parse(text) as Lockfile | null
  } catch {
    throw new DependencyError('The lockfile is not valid JSON.', [
      'lockfile: pass the contents of a package-lock.json.',
    ])
  }
  const packages = lock?.packages
  if (typeof packages !== 'object' || packages === null) {
    throw new DependencyError('The lockfile lists no packages.', [
      'lockfile: pass a package-lock.json from npm 7 or later.',
    ])
  }
  const issues = Object.entries(packages).flatMap(([path, entry]) => {
    if (path === '') return []
    if (!INSTALL_PATH.test(path)) return [`lockfile: ${path} is not a path under node_modules.`]
    if (entry?.inBundle === true) return []
    const fromRegistry =
      entry?.link !== true &&
      typeof entry?.resolved === 'string' &&
      entry.resolved.startsWith(registry)
    return fromRegistry ? [] : [`lockfile: ${path} is not installed from ${registry}.`]
  })
  if (issues.length > 0) {
    throw new DependencyError('The lockfile installs packages from outside the registry.', issues)
  }
}

const listen = (server: Server) =>
  new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve(typeof address === 'object' && address !== null ? address.port : 0)
    })
  })

/**
 * npm's only way out: a proxy that reaches the registry's host and refuses everything else, so no
 * package can make the relay fetch another URL, like a private address named as a tarball.
 */
const registryProxy = (registry: URL) => {
  const port = registry.port || (registry.protocol === 'https:' ? '443' : '80')
  const server = createServer((incoming, outgoing) => {
    // Plain-HTTP requests name their full URL.
    const target = URL.canParse(incoming.url ?? '') ? new URL(incoming.url ?? '') : undefined
    if (target?.origin !== registry.origin) {
      outgoing.writeHead(403).end()
      return
    }
    const upstream = httpRequest(
      target,
      { method: incoming.method, headers: incoming.headers },
      (reply) => {
        outgoing.writeHead(reply.statusCode ?? 502, reply.headers)
        reply.pipe(outgoing)
      },
    )
    upstream.on('error', () => outgoing.destroy())
    incoming.pipe(upstream)
  })
  // HTTPS requests tunnel through CONNECT to the registry's host and port only.
  server.on('connect', (incoming, socket, head) => {
    if (incoming.url !== `${registry.hostname}:${port}`) {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
      return
    }
    const upstream = connect(Number(port), registry.hostname, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      upstream.write(head)
      upstream.pipe(socket).pipe(upstream)
    })
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
  })
  return server
}

/**
 * npm's error lines, without their prefix, or its last lines when it failed before logging any.
 */
const npmErrors = (stderr: string) => {
  const lines = stderr
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const errors = lines
    .filter((line) => line.startsWith('npm error'))
    .map((line) => line.replace(/^npm error\s*/, ''))
    .filter((line) => line !== '' && !line.startsWith('Log files were not written'))
  return errors.length > 0 ? errors.slice(0, ERROR_LINES) : lines.slice(-ERROR_LINES)
}

/**
 * What everything under `dir` costs on disk, links not followed. Each entry costs at least a
 * block, as it does on the filesystem, so a package of empty files can't run the host out of
 * inodes under the byte limit.
 */
const sizeOf = async (dir: string) => {
  let bytes = 0
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    const { size } = entry.isFile() ? await lstat(join(entry.parentPath, entry.name)) : { size: 0 }
    bytes += Math.max(size, BLOCK_BYTES)
  }
  return bytes
}

const runNpm = (root: string, args: ReadonlyArray<string>) =>
  new Promise<void>((resolve, reject) => {
    // Only what npm needs to run: no credentials, no user or global config.
    const child = spawn('npm', args, {
      cwd: root,
      env: { PATH: process.env.PATH, HOME: root },
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: INSTALL_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    })
    let stderr = ''
    let oversized = false
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    // A small tarball can unpack to gigabytes, so the install is measured while it runs.
    let measuring = false
    const watch = setInterval(() => {
      if (measuring) return
      measuring = true
      sizeOf(root)
        .then((bytes) => {
          if (bytes <= INSTALL_LIMIT_BYTES) return
          oversized = true
          child.kill('SIGKILL')
        })
        // npm moves files while it works; the next measurement sees them.
        .catch(() => {})
        .finally(() => {
          measuring = false
        })
    }, SIZE_CHECK_MS)
    child.once('error', (error) => {
      clearInterval(watch)
      reject(error)
    })
    child.once('exit', (code, signal) => {
      clearInterval(watch)
      if (code === 0) resolve()
      else if (oversized) {
        reject(
          new DependencyError(
            `The dependencies take more than ${INSTALL_LIMIT_BYTES / 1024 / 1024} MB installed.`,
            ['dependencies: import fewer or smaller packages.'],
          ),
        )
      } else if (signal !== null) {
        reject(
          new DependencyError(`Installing took longer than ${INSTALL_TIMEOUT_MS / 1000} s.`, []),
        )
      } else
        reject(new DependencyError('npm could not install the dependencies.', npmErrors(stderr)))
    })
  })

/** Installs a process runs at once, so publishes can't fill the host's disk or memory together. */
const installs = (() => {
  let running = 0
  const waiting: Array<() => void> = []
  return {
    acquire: () =>
      running < INSTALL_CONCURRENCY
        ? Promise.resolve(void running++)
        : new Promise<void>((resolve) => waiting.push(resolve)),
    // A freed turn passes straight to the next install waiting, so `running` never overshoots.
    release: () => {
      const next = waiting.shift()
      if (next === undefined) running -= 1
      else next()
    },
  }
})()

/**
 * Every installed package as `name@version`, read from its own manifest: a lockfile's versions are
 * what it claims, not what the tarballs it names contain. A listed package npm skipped, like an
 * optional one for another platform, has no manifest and was not installed.
 */
const listPackages = async (root: string, { packages = {} }: Lockfile) => {
  const installed = await Promise.all(
    Object.keys(packages)
      .filter((path) => path !== '')
      .map(async (path) => {
        const text = await readFile(join(root, path, 'package.json'), 'utf8').catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return undefined
            throw error
          },
        )
        if (text === undefined) return []
        const { name, version } = JSON.parse(text) as { name?: unknown; version?: unknown }
        return [`${String(name)}@${String(version)}`]
      }),
  )
  return [...new Set(installed.flat())].sort()
}

/**
 * Install a workflow's dependencies from the registry, exactly as `lockfile` pins them when given,
 * into a private directory that `use` reads before it is removed. Returns what `use` returned and
 * every installed package. Install scripts never run, and npm reaches nothing but the registry.
 */
export const withDependencies = async <A>(
  { dependencies, lockfile, registry = NPM_REGISTRY }: Dependencies,
  use: (root: string) => Promise<A>,
): Promise<{ readonly value: A; readonly packages: ReadonlyArray<string> }> => {
  checkDependencies(dependencies)
  const registryUrl = new URL(registry)
  if (lockfile !== undefined) checkLockfile(lockfile, registryUrl.href)
  await installs.acquire()
  try {
    return await install(dependencies, lockfile, registryUrl, use)
  } finally {
    installs.release()
  }
}

const install = async <A>(
  dependencies: Readonly<Record<string, string>>,
  lockfile: string | undefined,
  registryUrl: URL,
  use: (root: string) => Promise<A>,
) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'textile-workflow-')))
  const proxy = registryProxy(registryUrl)
  try {
    const proxyUrl = `http://127.0.0.1:${await listen(proxy)}`
    await writeFile(join(root, 'package.json'), JSON.stringify({ private: true, dependencies }))
    if (lockfile !== undefined) await writeFile(join(root, 'package-lock.json'), lockfile)
    await runNpm(root, [
      lockfile === undefined ? 'install' : 'ci',
      `--registry=${registryUrl.href}`,
      `--proxy=${proxyUrl}`,
      `--https-proxy=${proxyUrl}`,
      '--noproxy=',
      // No git dependencies: the proxy can't confine git.
      '--git=false',
      `--cache=${join(root, '.npm')}`,
      // Neither file exists, so no operator's npm config, or its credentials, applies.
      `--userconfig=${join(root, '.npmrc')}`,
      `--globalconfig=${join(root, 'npmrc')}`,
      '--ignore-scripts',
      '--no-bin-links',
      '--no-audit',
      '--no-fund',
      '--no-update-notifier',
      '--logs-max=0',
      '--loglevel=error',
    ])
    proxy.closeAllConnections()
    proxy.close()
    const installed = JSON.parse(
      await readFile(join(root, 'package-lock.json'), 'utf8'),
    ) as Lockfile
    return { value: await use(root), packages: await listPackages(root, installed) }
  } finally {
    proxy.closeAllConnections()
    proxy.close()
    await rm(root, { recursive: true, force: true })
  }
}
