import type { Storage, VoiceOptOutScope } from '@discord-mcp/storage'

/** Prefix of the custom IDs on Textile's own buttons. Clicks on them never reach workflows. */
export const CONSENT_PREFIX = 'textile:voice:'

const BUTTON = 2
const ACTION_ROW = 1
const SECONDARY = 2
const MESSAGE_COMPONENT = 3
const EPHEMERAL = 1 << 6
const REPLY = 4
const UPDATE_MESSAGE = 7

/** The notice's two buttons, and the undo that follows each. */
const Buttons = {
  'opt-out:bot': { label: 'Opt out of this bot', optedOut: true, scope: 'bot' },
  'opt-out:all': { label: 'Opt out of all Textile bots', optedOut: true, scope: 'all' },
  'undo:bot': { label: 'Undo', optedOut: false, scope: 'bot' },
  'undo:all': { label: 'Undo', optedOut: false, scope: 'all' },
} as const
type ButtonId = keyof typeof Buttons

const Copy = {
  notice: "I'm relaying voice in this channel to an AI agent.",
  'opt-out:bot': "I won't relay your voice in this server.",
  'opt-out:all': 'No Textile bot will relay your voice.',
  'undo:bot': 'I can relay your voice in this server again.',
  'undo:all': 'Textile bots can relay your voice again.',
  failed: "I couldn't save that. Try again.",
} as const

const row = (...ids: ReadonlyArray<ButtonId>) => ({
  type: ACTION_ROW,
  components: ids.map((id) => ({
    type: BUTTON,
    style: SECONDARY,
    label: Buttons[id].label,
    custom_id: `${CONSENT_PREFIX}${id}`,
  })),
})

/** A click on a button, as `INTERACTION_CREATE` carries it. */
interface Click {
  readonly id: string
  readonly token: string
  readonly type: number
  readonly guild_id?: string
  readonly member?: { readonly user?: { readonly id?: string } }
  readonly data?: { readonly custom_id?: string }
}

export interface ConsentOptions {
  readonly storage: Pick<Storage, 'setVoiceOptOut' | 'voiceOptedOut'>
  /** Reaches Discord's REST API. */
  readonly discordFetch: typeof fetch
  readonly apiUrl: string
  readonly log: (message: string) => void
  /** A person's opt-out changed in `scope`: voices in it should check them again. */
  readonly changed: (scope: VoiceOptOutScope, userId: string) => void
}

export interface Consent {
  /**
   * Post the notice in a voice channel's chat, as the bot. Resolves to why it could not be posted,
   * or `undefined` once it is up.
   */
  readonly notice: (token: string, channelId: string) => Promise<string | undefined>
  /** Whether a person opted out of relay by this bot in this server, or by every bot. */
  readonly optedOut: (botId: string, guildId: string, userId: string) => Promise<boolean>
  /**
   * Answer a click on one of Textile's buttons, recording the opt-out or its undo before replying.
   * False when the interaction isn't Textile's, so it goes on to the bot's workflows.
   */
  readonly answer: (botId: string, interaction: unknown) => boolean
}

/**
 * The notice a bot posts before relaying anyone's voice, and the opt-outs its buttons record:
 * from this bot in this server, or from every bot Textile hosts.
 */
export const createConsent = ({
  storage,
  discordFetch,
  apiUrl,
  log,
  changed,
}: ConsentOptions): Consent => {
  /** Each person's clicks, chained so an undo never lands before the opt-out it undoes. */
  const clicks = new Map<string, Promise<void>>()

  const reply = async (click: Click, body: unknown) => {
    const response = await discordFetch(
      `${apiUrl}/interactions/${click.id}/${click.token}/callback`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
    )
    if (!response.ok) throw new Error(`Discord answered ${response.status}`)
  }

  const record = async (
    botId: string,
    click: Click,
    id: ButtonId,
    guildId: string,
    userId: string,
  ) => {
    const { optedOut, scope: kind } = Buttons[id]
    const scope: VoiceOptOutScope = kind === 'all' ? { everywhere: true } : { botId, guildId }
    // The notice's buttons reply anew; an undo replaces the reply it sits on.
    const type = optedOut ? REPLY : UPDATE_MESSAGE
    try {
      await storage.setVoiceOptOut(scope, userId, optedOut)
    } catch (cause) {
      log(`Recording a voice opt-out for bot ${botId} failed: ${String(cause)}`)
      // A failed undo keeps its button; a failed opt-out leaves the notice's buttons to retry.
      const retry = optedOut ? [] : [row(id)]
      return reply(click, {
        type,
        data: { content: Copy.failed, flags: EPHEMERAL, components: retry },
      })
    }
    changed(scope, userId)
    const undo = optedOut ? [row(kind === 'all' ? 'undo:all' : 'undo:bot')] : []
    await reply(click, { type, data: { content: Copy[id], flags: EPHEMERAL, components: undo } })
  }

  return {
    notice: async (token, channelId) => {
      const response = await discordFetch(`${apiUrl}/channels/${channelId}/messages`, {
        method: 'POST',
        headers: { authorization: `Bot ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          content: Copy.notice,
          allowed_mentions: { parse: [] },
          components: [row('opt-out:bot', 'opt-out:all')],
        }),
      }).catch(() => undefined)
      if (response?.ok) return undefined
      if (response?.status === 403) {
        return "The bot couldn't post its notice in the voice channel's chat, so it only sends audio. Receiving needs View Channel and Send Messages there."
      }
      return `The bot couldn't post its notice in the voice channel's chat${response === undefined ? '' : ` (HTTP ${response.status})`}, so it only sends audio. Join again to retry.`
    },
    optedOut: (botId, guildId, userId) => storage.voiceOptedOut(botId, guildId, userId),
    answer: (botId, interaction) => {
      const click = interaction as Click
      const customId = click.data?.custom_id
      if (click.type !== MESSAGE_COMPONENT || !customId?.startsWith(CONSENT_PREFIX)) return false
      const id = customId.slice(CONSENT_PREFIX.length)
      const userId = click.member?.user?.id
      // Notices are only posted in servers, so a click without one isn't from a notice.
      if (!(id in Buttons) || click.guild_id === undefined || userId === undefined) return true
      const guildId = click.guild_id
      const next = (clicks.get(userId) ?? Promise.resolve())
        .then(() => record(botId, click, id as ButtonId, guildId, userId))
        .catch((cause) =>
          log(`Answering a voice opt-out for bot ${botId} failed: ${String(cause)}`),
        )
      clicks.set(userId, next)
      void next.then(() => {
        if (clicks.get(userId) === next) clicks.delete(userId)
      })
      return true
    },
  }
}
