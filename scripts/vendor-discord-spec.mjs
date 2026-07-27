import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'

const commit = '74fda0fad044407ea280043a03ffc9bc64c4e49e'
const url = `https://raw.githubusercontent.com/discord/discord-api-spec/${commit}/specs/openapi.json`
const response = await fetch(url)
if (!response.ok) {
  throw new Error(`Unable to fetch Discord OpenAPI pin: HTTP ${response.status}`)
}
const bytes = Buffer.from(await response.arrayBuffer())
const specification = JSON.parse(bytes.toString('utf8'))
const paths = Object.keys(specification.paths ?? {})
const operations = Object.values(specification.paths ?? {}).flatMap((path) =>
  Object.keys(path).filter((method) => ['get', 'post', 'put', 'patch', 'delete'].includes(method)),
)
const source = {
  repository: 'discord/discord-api-spec',
  commit,
  path: 'specs/openapi.json',
  fetchedAt: new Date().toISOString(),
  sha256: createHash('sha256').update(bytes).digest('hex'),
  pathCount: paths.length,
  operationCount: operations.length,
}
await mkdir('vendor/discord', { recursive: true })
await writeFile('vendor/discord/openapi.json', bytes)
await writeFile('vendor/discord/source.json', `${JSON.stringify(source, null, 2)}\n`)
