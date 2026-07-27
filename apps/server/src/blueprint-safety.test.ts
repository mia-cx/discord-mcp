import type { Principal } from '@discord-mcp/auth'
import { DiscordRestClient, type DiscordTransport } from '@discord-mcp/discord-api'
import { Database, VersionedDocumentStore } from '@discord-mcp/persistence'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { afterEach, describe, expect, it } from 'vitest'
import { buildToolServer } from './tool-surface.js'

const guildId = '12345678901234567'
const ownerId = '12345678901234568'
const botId = '12345678901234569'
const botRoleId = '12345678901234570'
const managedRoleId = '12345678901234571'

const toolData = <A>(result: { readonly structuredContent?: unknown }): A =>
  (result.structuredContent as { readonly data: A }).data

const createDiscord = () => {
  let guildName = 'Before'
  const requests: string[] = []
  const transport: DiscordTransport = {
    request: async ({ route }) => {
      requests.push(route)
      if (route === `/guilds/${guildId}`) {
        return { id: guildId, name: guildName, owner_id: ownerId }
      }
      if (route === `/guilds/${guildId}/channels`) return []
      if (route === `/guilds/${guildId}/roles`) {
        return [
          {
            id: guildId,
            name: '@everyone',
            permissions: '0',
            color: 0,
            hoist: false,
            mentionable: false,
            position: 0,
            managed: false,
          },
          {
            id: managedRoleId,
            name: 'Managed by blueprint',
            permissions: '0',
            color: 0,
            hoist: false,
            mentionable: false,
            position: 1,
            managed: false,
          },
          {
            id: botRoleId,
            name: 'Bot',
            permissions: '8',
            color: 0,
            hoist: false,
            mentionable: false,
            position: 10,
            managed: false,
          },
        ]
      }
      if (route === '/users/@me') return { id: botId }
      if (route === `/guilds/${guildId}/members/${botId}`) return { roles: [botRoleId] }
      if (route === `/guilds/${guildId}/onboarding`) return {}
      if (route === `/guilds/${guildId}/welcome-screen`) return {}
      if (route === `/guilds/${guildId}/auto-moderation/rules`) return []
      throw new Error(`Unexpected Discord route: ${route}`)
    },
  }
  return {
    rest: new DiscordRestClient(transport),
    requests,
    renameGuild: (name: string) => {
      guildName = name
    },
  }
}

const createPublishedBlueprint = (database: Database): string => {
  const store = new VersionedDocumentStore(database, 'server-blueprint')
  const blueprint = store.create({
    ownerPrincipalId: 'local-administrator',
    name: 'Safety fixture',
    guildId,
    document: { roles: [], channels: [] },
  })
  store.publish(blueprint.id, 'local-administrator')
  return blueprint.id
}

const connect = async (input: {
  readonly database: Database
  readonly rest: DiscordRestClient
  readonly principal?: Principal
}) => {
  const server = buildToolServer({
    ...input,
    toolsets: new Set(['operator', 'admin']),
  })
  const client = new Client({ name: 'blueprint-safety', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  return {
    client,
    close: async () => {
      await client.close()
      await server.close()
    },
  }
}

describe('blueprint apply safety boundary', () => {
  const cleanup: Array<() => Promise<void> | void> = []

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((run) => run()))
  })

  it('re-reads Discord and rejects a preview after the guild changes', async () => {
    const database = new Database(':memory:')
    database.migrate()
    cleanup.push(() => database.close())
    const blueprintId = createPublishedBlueprint(database)
    const discord = createDiscord()
    const connection = await connect({ database, rest: discord.rest })
    cleanup.push(connection.close)

    const captured = await connection.client.callTool({
      name: 'discord_server_snapshot',
      arguments: { guildId },
    })
    const snapshot = toolData<{ readonly snapshot: unknown }>(captured).snapshot
    const planned = await connection.client.callTool({
      name: 'discord_server_blueprint_plan',
      arguments: { blueprintId, snapshot },
    })
    const previewToken = toolData<{ readonly previewToken: string }>(planned).previewToken

    discord.renameGuild('After')
    const applied = await connection.client.callTool({
      name: 'discord_server_blueprint_apply',
      arguments: { blueprintId, previewToken },
    })

    expect(applied.isError).toBe(true)
    expect(applied.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: expect.stringMatching(/snapshotDigest|plan again/) }),
      ]),
    )
    expect(discord.requests.filter((route) => route === `/guilds/${guildId}`)).toHaveLength(2)
  })

  it('requires mcp:destructive before applying managed deletion', async () => {
    const database = new Database(':memory:')
    database.migrate()
    cleanup.push(() => database.close())
    const blueprintId = createPublishedBlueprint(database)
    database.run(
      `INSERT INTO server_blueprint_bindings
       (blueprint_id, logical_type, logical_key, discord_id, created_at)
       VALUES (?, 'role', 'legacy', ?, ?)`,
      blueprintId,
      managedRoleId,
      new Date().toISOString(),
    )
    const discord = createDiscord()
    const principal: Principal = {
      id: 'local-administrator',
      name: 'Apply without destructive scope',
      kind: 'local',
      scopes: new Set(['mcp:read', 'server:plan', 'server:apply']),
    }
    const connection = await connect({ database, rest: discord.rest, principal })
    cleanup.push(connection.close)

    const captured = await connection.client.callTool({
      name: 'discord_server_snapshot',
      arguments: { guildId },
    })
    const snapshot = toolData<{ readonly snapshot: unknown }>(captured).snapshot
    const planned = await connection.client.callTool({
      name: 'discord_server_blueprint_plan',
      arguments: { blueprintId, snapshot, deleteManaged: true },
    })
    const plan = toolData<{
      readonly previewToken: string
      readonly destructive: boolean
    }>(planned)
    expect(plan.destructive).toBe(true)

    const applied = await connection.client.callTool({
      name: 'discord_server_blueprint_apply',
      arguments: {
        blueprintId,
        deleteManaged: true,
        previewToken: plan.previewToken,
      },
    })

    expect(applied.isError).toBe(true)
    expect(applied.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: expect.stringContaining('mcp:destructive') }),
      ]),
    )
  })
})
