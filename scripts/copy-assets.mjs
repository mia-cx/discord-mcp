import { cp, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Copy non-TypeScript assets into `dist`.
 *
 * `tsc` emits only what it compiles, so a `.json` imported at runtime through `import.meta.url` is
 * absent from the built package — and the failure surfaces as a missing file at the first tool call
 * rather than at build time, which is the worst place for it.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const assets = [
  {
    from: 'packages/discord-api/src/catalog/generated/schemas.json',
    to: 'packages/discord-api/dist/catalog/generated/schemas.json',
  },
]

for (const asset of assets) {
  const target = join(root, asset.to)
  await mkdir(dirname(target), { recursive: true })
  await cp(join(root, asset.from), target)
}
