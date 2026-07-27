import { REST } from '@discordjs/rest'
import { WebSocketManager, WebSocketShardEvents } from '@discordjs/ws'
import type { GatewayDispatchPayload, GatewaySendPayload } from 'discord-api-types/v10'
import { GatewayIntentBits } from 'discord-api-types/v10'
import type { GatewayEventStore } from './events.js'
import { explainGatewayClose, type GatewayAdapter } from './lifecycle.js'

export interface GatewayDiagnostic {
  readonly kind: 'closed' | 'error' | 'debug'
  readonly level: 'debug' | 'error'
  readonly message: string
  readonly shardId?: number
}

export interface GatewayCausality {
  readonly correlationId: string
  readonly causationId: string
  readonly causalDepth: number
}

export class DiscordJsGatewayAdapter implements GatewayAdapter {
  readonly manager: WebSocketManager

  constructor(
    token: string,
    intents: number,
    events: GatewayEventStore,
    onDiagnostic: (diagnostic: GatewayDiagnostic) => void = () => undefined,
    sharedRest?: REST,
    resolveCausality: (
      discordEntityIds: ReadonlyArray<string>,
    ) => GatewayCausality | undefined = () => undefined,
  ) {
    const rest = sharedRest ?? new REST({ version: '10' }).setToken(token)
    this.manager = new WebSocketManager({ token, intents, rest })
    this.manager.on(WebSocketShardEvents.Dispatch, (payload, shardId) => {
      const dispatch = payload as GatewayDispatchPayload
      const causality = resolveCausality(discordEntityIds(dispatch.d))
      events.publish({
        eventType: dispatch.t,
        payload: {
          shardId,
          sequence: dispatch.s,
          data: dispatch.d,
        },
        ...gatewayEventIdentity(dispatch, shardId),
        ...causality,
      })
    })
    this.manager.on(WebSocketShardEvents.Closed, (code, shardId) => {
      onDiagnostic({ kind: 'closed', level: 'error', message: explainGatewayClose(code), shardId })
    })
    this.manager.on(WebSocketShardEvents.Error, (error, shardId) => {
      onDiagnostic({ kind: 'error', level: 'error', message: error.message, shardId })
    })
    this.manager.on(WebSocketShardEvents.SocketError, (error, shardId) => {
      onDiagnostic({ kind: 'error', level: 'error', message: error.message, shardId })
    })
    this.manager.on(WebSocketShardEvents.Debug, (message, shardId) => {
      onDiagnostic({ kind: 'debug', level: 'debug', message, shardId })
    })
  }

  async connect(): Promise<void> {
    await this.manager.connect()
  }

  async destroy(): Promise<void> {
    await this.manager.destroy()
  }

  async send(payload: unknown): Promise<void> {
    if (!isGatewayPayload(payload)) throw new Error('Gateway payload must contain a numeric opcode')
    const shardIds = await this.manager.getShardIds()
    await Promise.all(shardIds.map((shardId) => this.manager.send(shardId, payload)))
  }
}

const isGatewayPayload = (payload: unknown): payload is GatewaySendPayload =>
  typeof payload === 'object' &&
  payload !== null &&
  'op' in payload &&
  typeof (payload as { readonly op?: unknown }).op === 'number'

export const gatewayEventIdentity = (
  payload: GatewayDispatchPayload,
  shardId: number,
): { readonly discordEventId?: string } =>
  typeof payload.s === 'number' ? { discordEventId: `${shardId}:${payload.s}` } : {}

export const discordEntityIds = (value: unknown): ReadonlyArray<string> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return []
  const record = value as Readonly<Record<string, unknown>>
  return [
    ...new Set(
      [
        record.id,
        record.message_id,
        record.role_id,
        record.emoji_id,
        record.sticker_id,
        record.guild_scheduled_event_id,
        record.application_command_id,
        record.thread_id,
      ].filter(
        (candidate): candidate is string =>
          typeof candidate === 'string' && /^\d{17,21}$/.test(candidate),
      ),
    ),
  ]
}

export const parseGatewayIntents = (value: string): number => {
  if (value.trim() === '') return 0
  let intents = 0
  for (const item of value.split(',').map((part) => part.trim())) {
    if (/^\d+$/.test(item)) {
      intents |= Number(item)
      continue
    }
    const bit = (GatewayIntentBits as Readonly<Record<string, unknown>>)[item]
    if (typeof bit !== 'number') {
      throw new Error(
        `Unknown Gateway intent "${item}"; use GatewayIntentBits names or decimal values`,
      )
    }
    intents |= bit
  }
  return intents
}
