import { readFile } from 'node:fs/promises'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport } from '@modelcontextprotocol/server'
import { buildToolServer } from '../apps/server/dist/tool-surface.js'
import { DiscordRestClient } from '../packages/discord-api/dist/index.js'
import { GatewayLifecycle } from '../packages/discord-gateway/dist/index.js'
import { Database } from '../packages/persistence/dist/index.js'

const database = new Database(':memory:')
database.migrate()
const server = buildToolServer({
  rest: new DiscordRestClient({ request: async () => ({}) }),
  database,
  gateway: new GatewayLifecycle('lazy', {
    connect: async () => {},
    destroy: async () => {},
    send: async () => {},
  }),
  toolsets: new Set(['operator', 'automation', 'admin', 'api']),
})
const client = new Client({ name: 'discord-mcp-inspector', version: '1.0.0' })
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
await server.connect(serverTransport)
await client.connect(clientTransport)
try {
  const { tools } = await client.listTools()
  const invalid = tools.filter(
    ({ name, title, inputSchema, outputSchema }) =>
      !/^discord_[a-z0-9_]{1,56}$/.test(name) ||
      !title ||
      inputSchema.type !== 'object' ||
      outputSchema?.type !== 'object',
  )
  if (invalid.length > 0) {
    throw new Error(`invalid tool registrations: ${invalid.map(({ name }) => name).join(', ')}`)
  }
  const scenarios = JSON.parse(
    await readFile(new URL('../tests/evals/scenarios.json', import.meta.url), 'utf8'),
  )
  if (!Array.isArray(scenarios) || scenarios.length !== 12) {
    throw new Error('the MCP evaluation suite must contain the 12 planned scenarios')
  }
  const toolNames = new Set(tools.map(({ name }) => name))
  const scenarioIds = new Set()
  for (const scenario of scenarios) {
    if (
      typeof scenario !== 'object' ||
      scenario === null ||
      typeof scenario.id !== 'string' ||
      scenario.id.length === 0 ||
      typeof scenario.prompt !== 'string' ||
      scenario.prompt.length === 0 ||
      !Array.isArray(scenario.expectedTools) ||
      scenario.expectedTools.length === 0 ||
      !Array.isArray(scenario.requiredBehaviors) ||
      scenario.requiredBehaviors.length === 0 ||
      !Array.isArray(scenario.forbiddenBehaviors) ||
      scenario.forbiddenBehaviors.length === 0
    ) {
      throw new Error('invalid MCP evaluation scenario')
    }
    if (scenarioIds.has(scenario.id))
      throw new Error(`duplicate evaluation scenario ${scenario.id}`)
    scenarioIds.add(scenario.id)
    const missing = scenario.expectedTools.filter((name) => !toolNames.has(name))
    if (missing.length > 0) {
      throw new Error(`evaluation scenario ${scenario.id} references missing tools: ${missing}`)
    }
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        toolCount: tools.length,
        evaluationScenarioCount: scenarios.length,
        tools: tools.map(({ name, title, annotations }) => ({ name, title, annotations })),
      },
      null,
      2,
    )}\n`,
  )
} finally {
  await client.close()
  await server.close()
  database.close()
}
