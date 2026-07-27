import { mkdir, readFile, writeFile } from 'node:fs/promises'

const methods = ['get', 'post', 'put', 'patch', 'delete']
const sourcePath = 'vendor/discord/openapi.json'
const catalogPath = 'packages/discord-api/src/generated/catalog.json'
const schemasPath = 'packages/discord-api/src/generated/schemas.json'

const spec = JSON.parse(await readFile(sourcePath, 'utf8'))
const overrides = JSON.parse(await readFile('vendor/discord/overrides.json', 'utf8'))
const source = JSON.parse(await readFile('vendor/discord/source.json', 'utf8'))

const destructive = /(?:delete|remove|kick|ban|prune|bulk_delete|disconnect)/
const botAdmin = /(?:application_command|application_update|bot_|application_emoji|entitlement|sku)/
const credential = /(?:oauth2_token|token_exchange|token_revocation|partner_sdk)/
const botIncompatible = new Set([
  'get_current_user_application_entitlements',
  'get_application_user_role_connection',
  'update_application_user_role_connection',
  'delete_application_user_role_connection',
  'get_my_guild_member',
])

const familyFor = (path) => {
  const segments = path.split('/').filter(Boolean)
  if (segments[0] === 'guilds' && segments[2]) return segments[2].replaceAll('-', '_')
  return (segments.find((segment) => !segment.startsWith('{')) ?? 'root').replaceAll('-', '_')
}

const riskFor = (operationId, method) => {
  if (overrides.risk[operationId]) return overrides.risk[operationId]
  if (credential.test(operationId)) return 'credential'
  if (method === 'GET') return 'read'
  if (botAdmin.test(operationId)) return 'bot_admin'
  if (destructive.test(operationId) || method === 'DELETE') return 'destructive'
  return 'write'
}

const authFor = (operationId, operation, rootSecurity, path) => {
  if (overrides.auth[operationId]) return overrides.auth[operationId]
  if (path.includes('{interaction_token}')) return ['interaction']
  const security = operation.security ?? rootSecurity ?? []
  const names = new Set(security.flatMap((entry) => Object.keys(entry)))
  const auth = []
  if ([...names].some((name) => /bot|bearer/i.test(name))) auth.push('bot')
  if ([...names].some((name) => /oauth/i.test(name))) auth.push('oauth2')
  if ([...names].some((name) => /webhook/i.test(name))) auth.push('webhook')
  if (path.includes('{webhook_token}')) auth.push('webhook')
  if (auth.length === 0) auth.push('bot')
  if (botIncompatible.has(operationId)) {
    return [...new Set(auth.filter((mode) => mode !== 'bot').concat('oauth2'))]
  }
  return [...new Set(auth)]
}

const oauthScopesFor = (operation, rootSecurity) => [
  ...new Set(
    (operation.security ?? rootSecurity ?? []).flatMap((entry) =>
      Object.entries(entry).flatMap(([name, scopes]) => (/oauth/i.test(name) ? scopes : [])),
    ),
  ),
]

const paginationFor = (parameters) => {
  const names = parameters
    .filter((parameter) => parameter.in === 'query')
    .map((parameter) => parameter.name)
  const cursorParameters = names.filter((name) =>
    ['after', 'around', 'before', 'cursor', 'from', 'until'].includes(name),
  )
  if (cursorParameters.length > 0) {
    return {
      style: 'cursor',
      parameters: cursorParameters,
      limitParameter: names.includes('limit') ? 'limit' : undefined,
    }
  }
  const offsetParameters = names.filter((name) => ['offset', 'page'].includes(name))
  if (offsetParameters.length > 0) {
    return {
      style: 'offset',
      parameters: offsetParameters,
      limitParameter: names.includes('limit') ? 'limit' : undefined,
    }
  }
  return { style: 'none', parameters: [] }
}

const responseBodiesFor = (operation) =>
  Object.fromEntries(
    Object.entries(operation.responses ?? {}).flatMap(([status, response]) => {
      if ('$ref' in response) return []
      const content = Object.fromEntries(
        Object.entries(response.content ?? {}).map(([contentType, value]) => [
          contentType,
          value.schema ?? {},
        ]),
      )
      return Object.keys(content).length === 0 ? [] : [[status, content]]
    }),
  )

const schemaNamesFor = (schemas) => {
  const names = new Set()
  const visit = (value) => {
    if (Array.isArray(value)) {
      for (const child of value) visit(child)
      return
    }
    if (typeof value !== 'object' || value === null) return
    if (typeof value.$ref === 'string') {
      const match = /^#\/components\/schemas\/(.+)$/.exec(value.$ref)
      if (match && !names.has(match[1])) {
        names.add(match[1])
        visit(spec.components?.schemas?.[match[1]])
      }
    }
    for (const child of Object.values(value)) visit(child)
  }
  visit(schemas)
  return [...names].sort()
}

const exampleFromSchema = (schema, seen = new Set()) => {
  if (typeof schema !== 'object' || schema === null) return {}
  if (schema.const !== undefined) return schema.const
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0]
  if (typeof schema.$ref === 'string') {
    const match = /^#\/components\/schemas\/(.+)$/.exec(schema.$ref)
    if (!match || seen.has(match[1])) return {}
    const nextSeen = new Set(seen)
    nextSeen.add(match[1])
    return exampleFromSchema(spec.components?.schemas?.[match[1]] ?? {}, nextSeen)
  }
  for (const branchName of ['oneOf', 'anyOf', 'allOf']) {
    if (Array.isArray(schema[branchName]) && schema[branchName].length > 0) {
      return exampleFromSchema(schema[branchName][0], seen)
    }
  }
  const type = Array.isArray(schema.type)
    ? schema.type.find((value) => value !== 'null')
    : schema.type
  if (type === 'object' || schema.properties) {
    return Object.fromEntries(
      (schema.required ?? []).map((name) => [
        name,
        exampleFromSchema(schema.properties?.[name] ?? {}, seen),
      ]),
    )
  }
  if (type === 'array') return [exampleFromSchema(schema.items ?? {}, seen)]
  if (type === 'boolean') return false
  if (type === 'integer' || type === 'number') return schema.minimum ?? 0
  if (schema.format === 'snowflake') return '12345678901234567'
  return 'value'
}

const parameterExample = (parameter) => {
  if (parameter.schema?.format === 'snowflake' || /_id$/.test(parameter.name)) {
    return '12345678901234567'
  }
  return exampleFromSchema(parameter.schema)
}

const overrideMetadataFor = (operationId) => {
  const applied = []
  if (overrides.auth[operationId]) {
    applied.push({
      field: 'auth',
      rationale:
        overrides.rationale?.auth ??
        'The preview specification does not express token-in-path webhook authentication.',
    })
  }
  if (overrides.risk[operationId]) {
    applied.push({
      field: 'risk',
      rationale:
        overrides.rationale?.risk ??
        'The generated method/name heuristic does not capture this operation risk.',
    })
  }
  if (overrides.gloss[operationId]) {
    applied.push({
      field: 'gloss',
      rationale:
        overrides.rationale?.gloss ??
        'Discord omits summaries for this operation, so a maintained search gloss improves discovery.',
    })
  }
  if ((overrides.auditLogReason ?? []).includes(operationId)) {
    applied.push({
      field: 'auditLogReason',
      rationale:
        overrides.rationale?.auditLogReason ??
        'Discord documents audit-log reason support outside the preview OpenAPI document.',
    })
  }
  return applied
}

const operations = []
for (const [path, item] of Object.entries(spec.paths)) {
  const pathParameters = item.parameters ?? []
  for (const method of methods) {
    const operation = item[method]
    if (!operation) continue
    const operationId = operation.operationId
    if (!operationId) throw new Error(`${method.toUpperCase()} ${path} has no operationId`)
    const parameters = [...pathParameters, ...(operation.parameters ?? [])].map((parameter) => {
      if ('$ref' in parameter) return parameter
      return {
        name: parameter.name,
        in: parameter.in,
        required: parameter.required ?? parameter.in === 'path',
        schema: parameter.schema ?? {},
        description: parameter.description,
        sensitive: /(?:token|secret|authorization)/i.test(parameter.name),
      }
    })
    for (const match of path.matchAll(/\{([^}]+)\}/g)) {
      if (!parameters.some((parameter) => parameter.name === match[1] && parameter.in === 'path')) {
        throw new Error(`${operationId} is missing path parameter ${match[1]}`)
      }
    }
    const requestContent = operation.requestBody?.content ?? {}
    const body = Object.fromEntries(
      Object.entries(requestContent).map(([contentType, value]) => [
        contentType,
        value.schema ?? {},
      ]),
    )
    const sensitiveBodyFields = [
      ...new Set(
        Object.values(body).flatMap((schema) =>
          Object.keys(schema.properties ?? {})
            .filter((name) => /(?:token|secret|authorization)/i.test(name))
            .map((name) => `body.${name}`),
        ),
      ),
    ].sort()
    const risk = riskFor(operationId, method.toUpperCase())
    const auth = authFor(operationId, operation, spec.security, path)
    const oauthScopes = oauthScopesFor(operation, spec.security)
    const responseBodies = responseBodiesFor(operation)
    const pagination = paginationFor(parameters)
    const primaryBody = Object.values(body)[0]
    if (auth.length === 0) throw new Error(`${operationId} has no supported authentication mode`)
    operations.push({
      operationId,
      method: method.toUpperCase(),
      path,
      family: familyFor(path),
      risk,
      auth,
      oauthScopes,
      parameters,
      body,
      bodyRequired: operation.requestBody?.required === true,
      responseBodies,
      schemaNames: schemaNamesFor({ body, responseBodies, parameters }),
      sensitiveBodyFields,
      description: operation.description ?? overrides.gloss[operationId] ?? '',
      searchTokens: [operationId, path, method, familyFor(path), overrides.gloss[operationId] ?? '']
        .join(' ')
        .toLowerCase(),
      auditLogReason:
        (overrides.auditLogReason ?? []).includes(operationId) ||
        parameters.some(
          (parameter) => parameter.in === 'header' && parameter.name === 'X-Audit-Log-Reason',
        ),
      botIncompatible: botIncompatible.has(operationId),
      pagination,
      documentationUrl: `https://github.com/${source.repository}/blob/${source.commit}/${source.path}`,
      overrides: overrideMetadataFor(operationId),
      dispatcherExample: {
        operationId,
        authMode: auth[0],
        ...(parameters.some((parameter) => parameter.in === 'path' && parameter.required)
          ? {
              path: Object.fromEntries(
                parameters
                  .filter((parameter) => parameter.in === 'path' && parameter.required)
                  .map((parameter) => [parameter.name, parameterExample(parameter)]),
              ),
            }
          : {}),
        ...(parameters.some((parameter) => parameter.in === 'query' && parameter.required)
          ? {
              query: Object.fromEntries(
                parameters
                  .filter((parameter) => parameter.in === 'query' && parameter.required)
                  .map((parameter) => [parameter.name, parameterExample(parameter)]),
              ),
            }
          : {}),
        ...(primaryBody === undefined ? {} : { body: exampleFromSchema(primaryBody) }),
      },
    })
  }
}
operations.sort((left, right) => left.operationId.localeCompare(right.operationId))
const catalog = {
  generatedFrom: source,
  operationCount: operations.length,
  pathCount: Object.keys(spec.paths).length,
  operations,
}
const catalogOutput = `${JSON.stringify(catalog, null, 2)}\n`
const schemasOutput = `${JSON.stringify(spec.components?.schemas ?? {}, null, 2)}\n`

if (process.argv.includes('--check')) {
  const currentCatalog = await readFile(catalogPath, 'utf8')
  const currentSchemas = await readFile(schemasPath, 'utf8')
  if (currentCatalog !== catalogOutput || currentSchemas !== schemasOutput) {
    throw new Error('Generated Discord catalog differs; run pnpm spec:generate')
  }
} else {
  await mkdir('packages/discord-api/src/generated', { recursive: true })
  await writeFile(catalogPath, catalogOutput)
  await writeFile(schemasPath, schemasOutput)
}
