import { Database } from '@discord-mcp/persistence'
import { GatewayDispatchEvents, GatewayIntentBits } from 'discord-api-types/v10'
import { describe, expect, it } from 'vitest'
import { discordEntityIds, gatewayEventIdentity } from './discordjs-adapter.js'
import { GatewayEventStore } from './events.js'
import { assertGatewayEventIntents, explainGatewayClose, GatewayLifecycle } from './lifecycle.js'

describe('Gateway lifecycle and durable events', () => {
  it('single-flights lazy connection attempts', async () => {
    let connects = 0
    const lifecycle = new GatewayLifecycle('lazy', {
      connect: async () => {
        connects += 1
      },
      destroy: async () => {},
      send: async () => {},
    })
    await Promise.all([lifecycle.ensureConnected(), lifecycle.ensureConnected()])
    expect(connects).toBe(1)
    expect(lifecycle.status).toBe('connected')
    expect(explainGatewayClose(4014)).toContain('privileged intent')
  })

  it('rejects workflow event triggers whose required Gateway intent is unavailable', () => {
    expect(() =>
      assertGatewayEventIntents(['MESSAGE_CREATE'], GatewayIntentBits.GuildMessages),
    ).not.toThrow()
    expect(() =>
      assertGatewayEventIntents(['MESSAGE_CREATE'], GatewayIntentBits.DirectMessages),
    ).not.toThrow()
    expect(() => assertGatewayEventIntents(['GUILD_MEMBER_ADD'], GatewayIntentBits.Guilds)).toThrow(
      /GuildMembers.*Developer Portal.*DISCORD_MCP_GATEWAY_INTENTS/,
    )
  })

  it('returns events published before wait and treats timeout as success', async () => {
    const database = new Database(':memory:')
    database.migrate()
    const store = new GatewayEventStore(database)
    const initial = store.recent()
    store.publish({ eventType: 'MESSAGE_CREATE', payload: { id: 'one' } })
    const observed = await store.wait({
      cursor: initial.cursor,
      types: ['MESSAGE_CREATE'],
      waitMs: 10,
    })
    expect(observed.events).toHaveLength(1)
    expect(observed.timedOut).toBe(false)
    const timeout = await store.wait({ cursor: observed.cursor, waitMs: 1 })
    expect(timeout).toMatchObject({ events: [], timedOut: true })
    database.close()
  })

  it('deduplicates Discord event IDs and does not skip filtered events after a full page', () => {
    const database = new Database(':memory:')
    database.migrate()
    const events = new GatewayEventStore(database)
    const duplicate = events.publish({
      discordEventId: 'same-discord-event',
      eventType: 'MESSAGE_CREATE',
      payload: { version: 1 },
    })
    const repeated = events.publish({
      discordEventId: 'same-discord-event',
      eventType: 'MESSAGE_CREATE',
      payload: { version: 2 },
    })
    expect(repeated.sequence).toBe(duplicate.sequence)
    expect(events.recent({ limit: 200 }).events).toHaveLength(1)

    for (let index = 0; index < 201; index += 1) {
      events.publish({ eventType: 'PRESENCE_UPDATE', payload: { index } })
    }
    const wanted = events.publish({ eventType: 'GUILD_CREATE', payload: { wanted: true } })
    const result = events.recent({ types: ['GUILD_CREATE'], limit: 1 })
    expect(result.events.map(({ sequence }) => sequence)).toEqual([wanted.sequence])
    database.close()
  })

  it('uses shard sequence for event identity and persists workflow causality', () => {
    expect(
      gatewayEventIdentity(
        {
          op: 0,
          s: 42,
          t: GatewayDispatchEvents.MessageUpdate,
          d: { id: '12345678901234567' },
        } as never,
        3,
      ),
    ).toEqual({ discordEventId: '3:42' })
    expect(
      discordEntityIds({
        id: '12345678901234567',
        message_id: '12345678901234568',
        channel_id: '12345678901234569',
      }),
    ).toEqual(['12345678901234567', '12345678901234568'])

    const database = new Database(':memory:')
    database.migrate()
    const events = new GatewayEventStore(database)
    const event = events.publish({
      discordEventId: '3:42',
      eventType: 'MESSAGE_UPDATE',
      payload: { id: '12345678901234567' },
      correlationId: 'root-correlation',
      causationId: 'workflow-execution',
      causalDepth: 4,
    })
    expect(event).toMatchObject({
      correlationId: 'root-correlation',
      causationId: 'workflow-execution',
      causalDepth: 4,
    })
    database.close()
  })
})
