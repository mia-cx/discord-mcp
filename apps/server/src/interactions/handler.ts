import { createPublicKey, verify } from 'node:crypto'
import { encodeMessage, type MessagePresentation } from '@discord-mcp/discord-presentations'
import type { Database } from '@discord-mcp/persistence'
import { Schema } from 'effect'

export interface DiscordInteraction {
  readonly id: string
  readonly application_id: string
  readonly type: number
  readonly token?: string
  readonly guild_id?: string
  readonly channel_id?: string
  readonly data?: {
    readonly name?: string
    readonly custom_id?: string
    readonly [key: string]: unknown
  }
  readonly [key: string]: unknown
}

export interface ComponentBinding {
  readonly ownerType: string
  readonly ownerId: string
  readonly ownerRevision?: number
  readonly actionType: string
  readonly actionKey: string
}

export interface InteractionCallback {
  readonly type: number
  readonly data?: Readonly<Record<string, unknown>>
}

export interface InteractionDispatcher {
  dispatch(
    interaction: DiscordInteraction,
    binding: ComponentBinding | undefined,
  ): Promise<InteractionCallback>
}

export interface InteractionFollowups {
  complete(interaction: DiscordInteraction, callback: InteractionCallback): Promise<void>
}

export interface InteractionObserver {
  readonly deferred?: (event: { readonly interactionType: number }) => void
  readonly deadlineReached?: (event: { readonly interactionType: number }) => void
}

export interface InteractionRequest {
  readonly rawBody: Uint8Array
  readonly signature: string | undefined
  readonly timestamp: string | undefined
}

export interface InteractionResponse {
  readonly status: number
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
}

export class InteractionError extends Schema.TaggedErrorClass<InteractionError>()(
  'InteractionError',
  { message: Schema.String },
) {
  constructor(message: string) {
    super({ message })
  }
}

const response = (status: number, body: unknown): InteractionResponse => ({
  status,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

const withoutToken = (interaction: DiscordInteraction): DiscordInteraction => {
  const { token: _token, ...safe } = interaction
  return safe
}

const failedCallback = (interactionType: number, ephemeral = true): InteractionCallback =>
  interactionType === 4
    ? { type: 8, data: { choices: [] } }
    : {
        type: 4,
        data: {
          content: 'This interaction could not be completed.',
          ...(ephemeral ? { flags: 64 } : {}),
        },
      }

export class InteractionHandler {
  readonly #publicKey: ReturnType<typeof createPublicKey>

  constructor(
    readonly database: Database,
    publicKeyHex: string,
    readonly dispatcher: InteractionDispatcher,
    readonly now = () => Date.now(),
    readonly deferAfterMs = 2_500,
    readonly followups?: InteractionFollowups,
    readonly observer: InteractionObserver = {},
  ) {
    const raw = Buffer.from(publicKeyHex, 'hex')
    if (raw.length !== 32) throw new InteractionError('DISCORD_PUBLIC_KEY must be 32-byte hex')
    this.#publicKey = createPublicKey({
      key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]),
      format: 'der',
      type: 'spki',
    })
  }

  async handle(request: InteractionRequest): Promise<InteractionResponse> {
    if (!request.signature || !request.timestamp)
      return response(401, { error: 'invalid signature' })
    const timestampMs = Number(request.timestamp) * 1_000
    if (!Number.isFinite(timestampMs) || Math.abs(this.now() - timestampMs) > 5 * 60_000) {
      return response(401, { error: 'stale interaction timestamp' })
    }
    const signature = Buffer.from(request.signature, 'hex')
    const signed = Buffer.concat([Buffer.from(request.timestamp), Buffer.from(request.rawBody)])
    if (signature.length !== 64 || !verify(null, signed, this.#publicKey, signature)) {
      return response(401, { error: 'invalid signature' })
    }
    let interaction: DiscordInteraction
    try {
      interaction = JSON.parse(Buffer.from(request.rawBody).toString('utf8')) as DiscordInteraction
    } catch {
      return response(400, { error: 'invalid JSON' })
    }
    if (interaction.type === 1) return response(200, { type: 1 })
    if (!/^\d{17,21}$/.test(interaction.id))
      return response(400, { error: 'invalid interaction id' })

    const existing = this.database.get<{ response_state_json: string }>(
      'SELECT response_state_json FROM interaction_deduplication WHERE interaction_id = ?',
      interaction.id,
    )
    if (existing) return response(200, JSON.parse(existing.response_state_json))

    let binding: ComponentBinding | undefined
    if (interaction.data?.custom_id !== undefined) {
      const row = this.database.get<{
        owner_type: string
        owner_id: string
        owner_revision: number | null
        action_type: string
        action_key: string
        expires_at: string | null
      }>(
        `SELECT owner_type, owner_id, owner_revision, action_type, action_key, expires_at
         FROM component_bindings WHERE handle = ?`,
        interaction.data.custom_id,
      )
      if (!row || (row.expires_at !== null && Date.parse(row.expires_at) <= this.now())) {
        return response(400, { error: 'unknown or expired component handle' })
      }
      if (row.owner_type === 'workflow') {
        const workflow = this.database.get<{ enabled_revision: number | null }>(
          'SELECT enabled_revision FROM workflows WHERE id = ? AND deleted_at IS NULL',
          row.owner_id,
        )
        if (
          workflow?.enabled_revision === null ||
          workflow?.enabled_revision === undefined ||
          workflow.enabled_revision !== row.owner_revision
        ) {
          return response(400, { error: 'component workflow revision is no longer enabled' })
        }
      }
      binding = {
        ownerType: row.owner_type,
        ownerId: row.owner_id,
        ...(row.owner_revision === null ? {} : { ownerRevision: row.owner_revision }),
        actionType: row.action_type,
        actionKey: row.action_key,
      }
    }
    const deferred: InteractionCallback = { type: 5 }
    this.database.run(
      `INSERT INTO interaction_deduplication(interaction_id, response_state_json, expires_at)
       VALUES (?, ?, ?)`,
      interaction.id,
      JSON.stringify(deferred),
      new Date(this.now() + 24 * 60 * 60_000).toISOString(),
    )
    const work = this.dispatcher.dispatch(withoutToken(interaction), binding).then((callback) => {
      if (callback.type === 5 && callback.data !== undefined) {
        throw new InteractionError('deferred callback type 5 cannot carry response data')
      }
      validateCallback(callback)
      return callback
    })
    const outcome = await Promise.race([
      work.then(
        (callback) => ({ kind: 'callback' as const, callback }),
        () => ({ kind: 'failure' as const }),
      ),
      new Promise<{ kind: 'deferred' }>((resolve) =>
        setTimeout(() => resolve({ kind: 'deferred' }), this.deferAfterMs),
      ),
    ])
    if (outcome.kind === 'callback') {
      this.database.run(
        'UPDATE interaction_deduplication SET response_state_json = ? WHERE interaction_id = ?',
        JSON.stringify(outcome.callback),
        interaction.id,
      )
      return response(200, outcome.callback)
    }
    if (outcome.kind === 'failure') {
      const callback = failedCallback(interaction.type)
      this.database.run(
        'UPDATE interaction_deduplication SET response_state_json = ? WHERE interaction_id = ?',
        JSON.stringify(callback),
        interaction.id,
      )
      return response(200, callback)
    }
    this.observer.deadlineReached?.({ interactionType: interaction.type })
    if (interaction.type === 4) {
      const emptyAutocomplete = failedCallback(interaction.type)
      this.database.run(
        'UPDATE interaction_deduplication SET response_state_json = ? WHERE interaction_id = ?',
        JSON.stringify(emptyAutocomplete),
        interaction.id,
      )
      void work.catch(() => undefined)
      return response(200, emptyAutocomplete)
    }
    this.observer.deferred?.({ interactionType: interaction.type })
    void work
      .then(
        (callback) => this.followups?.complete(interaction, callback),
        () => this.followups?.complete(interaction, failedCallback(interaction.type, false)),
      )
      .catch(() => undefined)
    return response(200, deferred)
  }

  cleanup(): number {
    return Number(
      this.database.run(
        'DELETE FROM interaction_deduplication WHERE expires_at <= ?',
        new Date(this.now()).toISOString(),
      ).changes,
    )
  }
}

const validateCallback = (callback: InteractionCallback): void => {
  if (callback.data === undefined) return
  const flags = typeof callback.data.flags === 'number' ? callback.data.flags : 0
  if ((flags & 32_768) === 0) return
  for (const field of ['content', 'embeds', 'poll', 'sticker_ids', 'shared_client_theme']) {
    if (callback.data[field] !== undefined) {
      throw new InteractionError(`Components V2 interaction response cannot contain ${field}`)
    }
  }
}

export const presentationCallback = (
  presentation: Exclude<MessagePresentation, { type: 'template' }>,
  ephemeral = false,
): InteractionCallback => {
  const encoded = encodeMessage(presentation, 'interaction')
  const existingFlags = typeof encoded.payload.flags === 'number' ? encoded.payload.flags : 0
  return {
    type: 4,
    data: {
      ...encoded.payload,
      ...(ephemeral ? { flags: existingFlags | 64 } : {}),
    },
  }
}
