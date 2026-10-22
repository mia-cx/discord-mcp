import { defineResource } from '@discord-mcp/core'
import { OperationCatalog } from '@mia-cx/discord-catalog'
import { Effect } from 'effect'

/**
 * Catalog detail as resources.
 *
 * A single operation's JSON Schema can run to tens of kilobytes. Returning that from a tool pushes
 * everything else out of a model's context to answer a question it may not have asked — so the
 * tool returns a summary and a link, and the detail is fetched only when it is wanted.
 */

export const operationResource = defineResource<OperationCatalog>({
  name: 'discord-operation',
  title: 'A Discord API operation',
  description:
    'One cataloged operation in full: method, route, parameters, request body schema, risk class, auth modes, and pagination style.',
  uri: 'discord://api/operations/{operationId}',
  mimeType: 'application/json',
  variables: ['operationId'],
  read: (variables) =>
    Effect.gen(function* () {
      const catalog = yield* OperationCatalog
      const operation = yield* catalog.get(variables.operationId ?? '')
      const bodySchema = yield* catalog.bodySchema(operation.operationId)

      return { ...operation, bodySchema }
    }),
  list: () =>
    Effect.map(OperationCatalog, (catalog) =>
      catalog.all.map((operation) => ({
        uri: `discord://api/operations/${operation.operationId}`,
        name: operation.operationId,
      })),
    ),
})

export const familyResource = defineResource<OperationCatalog>({
  name: 'discord-family',
  title: 'A Discord API operation family',
  description:
    'Every operation in one family with its risk class and route. Read this to see what is possible in an area before searching.',
  uri: 'discord://api/families/{family}',
  mimeType: 'application/json',
  variables: ['family'],
  read: (variables) =>
    Effect.map(OperationCatalog, (catalog) => {
      const family = variables.family ?? ''
      const operations = catalog.all.filter((operation) => operation.family === family)

      return {
        family,
        count: operations.length,
        operations: operations.map((operation) => ({
          operationId: operation.operationId,
          method: operation.method,
          path: operation.path,
          risk: operation.risk,
          curatedTool: operation.curatedTool,
        })),
      }
    }),
  list: () =>
    Effect.map(OperationCatalog, (catalog) => {
      const families = [...new Set(catalog.all.map((operation) => operation.family))].sort()
      return families.map((family) => ({
        uri: `discord://api/families/${family}`,
        name: family,
      }))
    }),
})

export const catalogResources = [operationResource, familyResource]
