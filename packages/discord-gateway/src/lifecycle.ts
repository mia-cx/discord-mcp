import { GatewayIntentBits } from 'discord-api-types/v10'
import { Schema } from 'effect'

export type GatewayMode = 'off' | 'lazy' | 'eager'
export type GatewayStatus = 'disconnected' | 'connecting' | 'connected' | 'failed'

export interface GatewayAdapter {
  connect(): Promise<void>
  destroy(): Promise<void>
  send(payload: unknown): Promise<void>
}

const closeCodeHelp: Readonly<Record<number, string>> = {
  4004: 'Invalid bot token; check DISCORD_TOKEN and do not retry.',
  4013: 'Invalid Gateway intents; verify configured intent names.',
  4014: 'Disallowed privileged intent; enable it in the Discord Developer Portal bot settings.',
}

export class DiscordGatewayError extends Schema.TaggedErrorClass<DiscordGatewayError>()(
  'DiscordGatewayError',
  {
    message: Schema.String,
    closeCode: Schema.optionalKey(Schema.Number),
    retryable: Schema.Boolean,
  },
) {
  constructor(
    message: string,
    options: { readonly closeCode?: number; readonly retryable?: boolean } = {},
  ) {
    super({
      message,
      ...(options.closeCode === undefined ? {} : { closeCode: options.closeCode }),
      retryable: options.retryable ?? false,
    })
  }
}

export const explainGatewayClose = (code: number): string =>
  closeCodeHelp[code] ?? `Discord Gateway closed with code ${code}; inspect Gateway diagnostics.`

const eventIntentAlternatives: ReadonlyArray<{
  readonly matches: (eventType: string) => boolean
  readonly alternatives: ReadonlyArray<readonly [name: string, bit: number]>
}> = [
  {
    matches: (eventType) => /^GUILD_MEMBER_(?:ADD|REMOVE|UPDATE)$/.test(eventType),
    alternatives: [['GuildMembers', GatewayIntentBits.GuildMembers]],
  },
  {
    matches: (eventType) => eventType === 'PRESENCE_UPDATE',
    alternatives: [['GuildPresences', GatewayIntentBits.GuildPresences]],
  },
  {
    matches: (eventType) => /^GUILD_BAN_(?:ADD|REMOVE)$/.test(eventType),
    alternatives: [['GuildModeration', GatewayIntentBits.GuildModeration]],
  },
  {
    matches: (eventType) =>
      eventType === 'GUILD_EMOJIS_UPDATE' || eventType === 'GUILD_STICKERS_UPDATE',
    alternatives: [['GuildExpressions', GatewayIntentBits.GuildExpressions]],
  },
  {
    matches: (eventType) =>
      eventType === 'GUILD_INTEGRATIONS_UPDATE' ||
      eventType === 'INTEGRATION_CREATE' ||
      eventType === 'INTEGRATION_UPDATE' ||
      eventType === 'INTEGRATION_DELETE',
    alternatives: [['GuildIntegrations', GatewayIntentBits.GuildIntegrations]],
  },
  {
    matches: (eventType) => eventType === 'WEBHOOKS_UPDATE',
    alternatives: [['GuildWebhooks', GatewayIntentBits.GuildWebhooks]],
  },
  {
    matches: (eventType) => /^INVITE_(?:CREATE|DELETE)$/.test(eventType),
    alternatives: [['GuildInvites', GatewayIntentBits.GuildInvites]],
  },
  {
    matches: (eventType) => eventType === 'VOICE_STATE_UPDATE',
    alternatives: [['GuildVoiceStates', GatewayIntentBits.GuildVoiceStates]],
  },
  {
    matches: (eventType) => eventType.startsWith('GUILD_SCHEDULED_EVENT_'),
    alternatives: [['GuildScheduledEvents', GatewayIntentBits.GuildScheduledEvents]],
  },
  {
    matches: (eventType) =>
      eventType === 'AUTO_MODERATION_RULE_CREATE' ||
      eventType === 'AUTO_MODERATION_RULE_UPDATE' ||
      eventType === 'AUTO_MODERATION_RULE_DELETE',
    alternatives: [['AutoModerationConfiguration', GatewayIntentBits.AutoModerationConfiguration]],
  },
  {
    matches: (eventType) => eventType === 'AUTO_MODERATION_ACTION_EXECUTION',
    alternatives: [['AutoModerationExecution', GatewayIntentBits.AutoModerationExecution]],
  },
  {
    matches: (eventType) => eventType.startsWith('MESSAGE_POLL_VOTE_'),
    alternatives: [
      ['GuildMessagePolls', GatewayIntentBits.GuildMessagePolls],
      ['DirectMessagePolls', GatewayIntentBits.DirectMessagePolls],
    ],
  },
  {
    matches: (eventType) => eventType.startsWith('MESSAGE_REACTION_'),
    alternatives: [
      ['GuildMessageReactions', GatewayIntentBits.GuildMessageReactions],
      ['DirectMessageReactions', GatewayIntentBits.DirectMessageReactions],
    ],
  },
  {
    matches: (eventType) => eventType === 'TYPING_START',
    alternatives: [
      ['GuildMessageTyping', GatewayIntentBits.GuildMessageTyping],
      ['DirectMessageTyping', GatewayIntentBits.DirectMessageTyping],
    ],
  },
  {
    matches: (eventType) => eventType.startsWith('MESSAGE_') || eventType === 'CHANNEL_PINS_UPDATE',
    alternatives: [
      ['GuildMessages', GatewayIntentBits.GuildMessages],
      ['DirectMessages', GatewayIntentBits.DirectMessages],
    ],
  },
  {
    matches: (eventType) =>
      eventType === 'GUILD_CREATE' ||
      eventType === 'GUILD_UPDATE' ||
      eventType === 'GUILD_DELETE' ||
      eventType.startsWith('CHANNEL_') ||
      eventType.startsWith('THREAD_') ||
      eventType === 'STAGE_INSTANCE_CREATE' ||
      eventType === 'STAGE_INSTANCE_UPDATE' ||
      eventType === 'STAGE_INSTANCE_DELETE',
    alternatives: [['Guilds', GatewayIntentBits.Guilds]],
  },
]

export const assertGatewayEventIntents = (
  eventTypes: ReadonlyArray<string>,
  configuredIntents: number,
): void => {
  for (const eventType of eventTypes) {
    const rule = eventIntentAlternatives.find(({ matches }) => matches(eventType))
    if (!rule || rule.alternatives.some(([, bit]) => (configuredIntents & bit) === bit)) continue
    const names = rule.alternatives.map(([name]) => name)
    const privileged = names.some((name) => name === 'GuildMembers' || name === 'GuildPresences')
    throw new DiscordGatewayError(
      `Gateway event ${eventType} requires configured intent ${names.join(' or ')}.${
        privileged
          ? ' Enable the privileged intent in the Discord Developer Portal bot settings and add it to DISCORD_MCP_GATEWAY_INTENTS.'
          : ' Add it to DISCORD_MCP_GATEWAY_INTENTS.'
      }`,
    )
  }
}

export class GatewayLifecycle {
  #status: GatewayStatus = 'disconnected'
  #connection: Promise<void> | undefined

  constructor(
    readonly mode: GatewayMode,
    readonly adapter: GatewayAdapter,
  ) {}

  get status(): GatewayStatus {
    return this.#status
  }

  ensureConnected(): Promise<void> {
    if (this.mode === 'off') {
      return Promise.reject(new DiscordGatewayError('Gateway mode is off'))
    }
    if (this.#status === 'connected') return Promise.resolve()
    if (this.#connection) return this.#connection
    this.#status = 'connecting'
    this.#connection = this.adapter.connect().then(
      () => {
        this.#status = 'connected'
      },
      (cause) => {
        this.#status = 'failed'
        this.#connection = undefined
        throw cause instanceof DiscordGatewayError
          ? cause
          : new DiscordGatewayError(
              `Discord Gateway connection failed: ${
                cause instanceof Error ? cause.message : String(cause)
              }`,
              { retryable: true },
            )
      },
    )
    return this.#connection
  }

  async send(payload: unknown): Promise<void> {
    await this.ensureConnected()
    await this.adapter.send(payload)
  }

  async close(): Promise<void> {
    await this.adapter.destroy()
    this.#status = 'disconnected'
    this.#connection = undefined
  }
}
