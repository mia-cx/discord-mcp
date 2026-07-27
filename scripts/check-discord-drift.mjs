import { readFile } from 'node:fs/promises'

const source = JSON.parse(await readFile('vendor/discord/source.json', 'utf8'))
const pinned = JSON.parse(await readFile('vendor/discord/openapi.json', 'utf8'))
const upstreamUrl =
  process.env.DISCORD_SPEC_UPSTREAM_URL ??
  'https://raw.githubusercontent.com/discord/discord-api-spec/main/specs/openapi.json'
const response = await fetch(upstreamUrl, { redirect: 'error' })
if (!response.ok) {
  throw new Error(`Unable to read upstream Discord spec: HTTP ${response.status}`)
}
const upstream = await response.json()

const operations = (document) =>
  new Map(
    Object.entries(document.paths ?? {}).flatMap(([path, item]) =>
      Object.entries(item)
        .filter(([method]) => /^(?:get|post|put|patch|delete)$/i.test(method))
        .map(([method, operation]) => [
          operation.operationId,
          JSON.stringify({ method: method.toUpperCase(), path, operation }),
        ]),
    ),
  )

const before = operations(pinned)
const after = operations(upstream)
const additions = [...after.keys()].filter((id) => !before.has(id)).sort()
const removals = [...before.keys()].filter((id) => !after.has(id)).sort()
const changes = [...before.keys()]
  .filter((id) => after.has(id) && before.get(id) !== after.get(id))
  .sort()
process.stdout.write(
  `${JSON.stringify(
    {
      pin: source.commit,
      upstream: upstreamUrl,
      additions,
      removals,
      changes,
      drift: additions.length + removals.length + changes.length,
    },
    null,
    2,
  )}\n`,
)
