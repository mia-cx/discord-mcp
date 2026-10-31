import type { Storage, VoiceOptOutChange, VoiceOptOutScope } from '@discord-mcp/storage'

/** Prefix of the custom IDs on Textile's own buttons. Clicks on them never reach workflows. */
export const CONSENT_PREFIX = 'textile:voice:'

const BUTTON = 2
const ACTION_ROW = 1
const SECONDARY = 2
const MESSAGE_COMPONENT = 3
const EPHEMERAL = 1 << 6
/** Interaction callbacks: a new reply to come, or an edit to come of the clicked message. */
const DEFERRED_REPLY = 5
const DEFERRED_UPDATE = 6

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
  readonly application_id: string
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
  /** A person's opt-out changed: this process's voices apply it without waiting for storage. */
  readonly changed: (change: VoiceOptOutChange) => void
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
   * Answer a click on one of Textile's buttons: acknowledge it at once, record the opt-out or its
   * undo, then say so in the reply. False when the interaction isn't Textile's, so it goes on to
   * the bot's workflows.
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

  /** An interaction's callback or follow-up, which its token authorizes. */
  const call = async (method: string, path: string, body: unknown) => {
    const response = await discordFetch(`${apiUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!response.ok) throw new Error(`Discord answered ${response.status}`)
  }

  /** Record the click, then edit the acknowledged reply to say what happened. */
  const record = async (
    botId: string,
    click: Click,
    id: ButtonId,
    guildId: string,
    userId: string,
    acknowledged: Promise<void>,
  ) => {
    const { optedOut, scope: kind } = Buttons[id]
    const scope: VoiceOptOutScope = kind === 'all' ? { everywhere: true } : { botId, guildId }
    let reply: { readonly content: string; readonly components: ReadonlyArray<unknown> }
    try {
      await storage.setVoiceOptOut(scope, userId, optedOut)
      changed({ scope, userId, optedOut })
      reply = {
        content: Copy[id],
        components: optedOut ? [row(kind === 'all' ? 'undo:all' : 'undo:bot')] : [],
      }
    } catch (cause) {
      log(`Recording a voice opt-out for bot ${botId} failed: ${String(cause)}`)
      // A failed undo keeps its button; a failed opt-out leaves the notice's buttons to retry.
      reply = { content: Copy.failed, components: optedOut ? [] : [row(id)] }
    }
    await acknowledged
    await call(
      'PATCH',
      `/webhooks/${click.application_id}/${click.token}/messages/@original`,
      reply,
    )
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
      // Discord drops an answer that takes over three seconds, so acknowledge at once: the
      // notice's buttons get a new ephemeral reply, and an undo will edit the reply it sits on.
      const acknowledged = call(
        'POST',
        `/interactions/${click.id}/${click.token}/callback`,
        Buttons[id as ButtonId].optedOut
          ? { type: DEFERRED_REPLY, data: { flags: EPHEMERAL } }
          : { type: DEFERRED_UPDATE },
      )
      // Awaited by `record`, which still saves a click whose acknowledgement failed.
      acknowledged.catch(() => {})
      const next = (clicks.get(userId) ?? Promise.resolve())
        .then(() => record(botId, click, id as ButtonId, guildId, userId, acknowledged))
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
