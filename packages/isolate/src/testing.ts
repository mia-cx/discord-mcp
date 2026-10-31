import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export interface FixturePackage {
  readonly name: string
  readonly version: string
  readonly dependencies?: Readonly<Record<string, string>>
  /** Files by path inside the package; `package.json` is written for it. */
  readonly files: Readonly<Record<string, string>>
}

/**
 * A local npm registry serving `packages`, so installs in tests never reach npm. `requests` lists
 * every path asked for.
 */
export const fixtureRegistry = async (packages: ReadonlyArray<FixturePackage>) => {
  const dir = await mkdtemp(join(tmpdir(), 'textile-registry-'))
  const tarballs = new Map<string, Buffer>()
  const requests: string[] = []
  const server = createServer((request, response) => {
    const path = decodeURIComponent(request.url ?? '')
    requests.push(path)
    const tarball = tarballs.get(path)
    if (tarball !== undefined) return response.end(tarball)
    const versions = packages.filter((pkg) => `/${pkg.name}` === path)
    if (versions.length === 0) return response.writeHead(404).end('{}')
    response.setHeader('content-type', 'application/json')
    response.end(
      JSON.stringify({
        name: versions[0]?.name,
        'dist-tags': { latest: versions.at(-1)?.version },
        versions: Object.fromEntries(versions.map((pkg) => [pkg.version, manifest(pkg)])),
      }),
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const url = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}/`
  const tarballPath = ({ name, version }: FixturePackage) =>
    `/${name}/-/${name.split('/').at(-1)}-${version}.tgz`
  const dist = (pkg: FixturePackage) => {
    const tarball = tarballs.get(tarballPath(pkg)) ?? Buffer.alloc(0)
    return {
      tarball: new URL(tarballPath(pkg).slice(1), url).href,
      integrity: `sha512-${createHash('sha512').update(tarball).digest('base64')}`,
      shasum: createHash('sha1').update(tarball).digest('hex'),
    }
  }
  const manifest = (pkg: FixturePackage) => ({
    name: pkg.name,
    version: pkg.version,
    dependencies: pkg.dependencies ?? {},
    dist: dist(pkg),
  })

  for (const pkg of packages) {
    const root = join(dir, `${pkg.name}@${pkg.version}`)
    const { name, version, dependencies = {} } = pkg
    const files = { ...pkg.files, 'package.json': JSON.stringify({ name, version, dependencies }) }
    for (const [file, contents] of Object.entries(files)) {
      await mkdir(dirname(join(root, 'package', file)), { recursive: true })
      await writeFile(join(root, 'package', file), contents)
    }
    execFileSync('tar', ['-czf', 'package.tgz', 'package'], { cwd: root })
    tarballs.set(tarballPath(pkg), await readFile(join(root, 'package.tgz')))
  }

  return {
    url,
    requests,
    /** Where `pkg`'s tarball is served, and its integrity, as a lockfile records them. */
    dist: (name: string, version: string) =>
      dist({ name, version, files: {} } satisfies FixturePackage),
    close: async () => {
      server.closeAllConnections()
      server.close()
      await rm(dir, { recursive: true, force: true })
    },
  }
}
