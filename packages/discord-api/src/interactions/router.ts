import { ComponentBindingRepository, Database } from '@discord-mcp/persistence'
import { Effect } from 'effect'
import {
  CALLBACK_TYPE,
  INTERACTION_TYPE,
  redactInteraction,
  verifyInteractionSignature,
} from './verify.ts'

/**
 * The interactions endpoint.
 *
 * The order here is the security property: verify the signature over the raw bytes, *then* decode.
 * Decoding first would mean parsing attacker-controlled JSON before establishing that Discord sent
 * it, and this endpoint is public by necessity.
 */

export interface InteractionResponse {
  readonly status: number
  readonly body: unknown
  readonly contentType: string
}

export interface RouteInput {
  readonly signature: string | null
  readonly timestamp: string | null
  readonly rawBody: Uint8Array
  readonly publicKey: string
  readonly now: number
}

export interface ResolvedBinding {
  readonly kind: 'workflow' | 'inbox'
  readonly actionKey: string
  readonly ownerKind: string
  readonly ownerId: string
  readonly ownerRevision: number | null
}

export type Dispatch =
  | { readonly outcome: 'pong' }
  | { readonly outcome: 'deferred'; readonly interactionId: string }
  | { readonly outcome: 'duplicate'; readonly interactionId: string }
  | { readonly outcome: 'unbound'; readonly customId: string }
  | { readonly outcome: 'rejected'; readonly reason: string }
  | {
      readonly outcome: 'dispatched'
      readonly interactionId: string
      readonly binding: ResolvedBinding
    }

const json = (status: number, body: unknown): InteractionResponse => ({
  status,
  body,
  contentType: 'application/json',
})

/**
 * Handle one inbound interaction.
 *
 * Returns both the HTTP response and what was decided, so the caller can act on the dispatch
 * without re-parsing the response it is about to send.
 */
export const routeInteraction = (
  input: RouteInput,
): Effect.Effect<
  { readonly response: InteractionResponse; readonly dispatch: Dispatch },
  never,
  ComponentBindingRepository | Database
> =>
  Effect.gen(function* () {
    // 1. Signature, over the raw bytes, before anything looks at the content.
    const verification = verifyInteractionSignature({
      signature: input.signature,
      timestamp: input.timestamp,
      rawBody: input.rawBody,
      publicKey: input.publicKey,
      now: input.now,
    })

    if (!verification.ok) {
      // 401 with no detail. Discord retries a 5xx and disables an endpoint that misbehaves, and
      // the reason is only useful to someone probing.
      return {
        response: json(401, { error: 'invalid_signature' }),
        dispatch: { outcome: 'rejected', reason: verification.reason } as const,
      }
    }

    // 2. Only now is it safe to parse.
    const parsed = yield* Effect.try({
      try: () => JSON.parse(Buffer.from(input.rawBody).toString('utf8')) as Record<string, unknown>,
      catch: () => undefined,
    }).pipe(Effect.catch(() => Effect.succeed(undefined)))

    if (parsed === undefined) {
      return {
        response: json(400, { error: 'invalid_json' }),
        dispatch: { outcome: 'rejected', reason: 'Body is not JSON.' } as const,
      }
    }

    // 3. PING. Discord sends one when the endpoint URL is saved, and refuses to enable it without
    // a PONG.
    if (parsed.type === INTERACTION_TYPE.ping) {
      return {
        response: json(200, { type: CALLBACK_TYPE.pong }),
        dispatch: { outcome: 'pong' } as const,
      }
    }

    const interactionId = typeof parsed.id === 'string' ? parsed.id : undefined
    if (interactionId === undefined) {
      return {
        response: json(400, { error: 'missing_id' }),
        dispatch: { outcome: 'rejected', reason: 'No interaction id.' } as const,
      }
    }

    // 4. Deduplicate. Discord retries on a slow response, and a retried button press must not run
    // its handler twice.
    const db = yield* Database
    const seen = yield* Effect.orDie(
      db.query<{ interaction_id: string }>(
        'SELECT interaction_id FROM interaction_deduplication WHERE interaction_id = ?',
        [interactionId],
      ),
    )

    if (seen.length > 0) {
      // Still deferred rather than errored: Discord is retrying because it thinks it did not hear
      // back, and an error would surface to the user as a failed interaction.
      return {
        response: json(200, { type: CALLBACK_TYPE.deferredChannelMessageWithSource }),
        dispatch: { outcome: 'duplicate', interactionId } as const,
      }
    }

    yield* Effect.orDie(
      db.execute(
        'INSERT INTO interaction_deduplication (interaction_id, received_at) VALUES (?, ?)',
        [interactionId, input.now],
      ),
    )

    // 5. Resolve the opaque handle. `custom_id` round-trips through the client, so it is untrusted
    // input on the way back — it is a lookup key and never carries meaning.
    const data = (parsed.data ?? {}) as Record<string, unknown>
    const customId = typeof data.custom_id === 'string' ? data.custom_id : undefined

    if (
      parsed.type === INTERACTION_TYPE.messageComponent ||
      parsed.type === INTERACTION_TYPE.modalSubmit
    ) {
      if (customId === undefined) {
        return {
          response: json(400, { error: 'missing_custom_id' }),
          dispatch: {
            outcome: 'rejected',
            reason: 'Component interaction with no custom_id.',
          } as const,
        }
      }

      const bindings = yield* ComponentBindingRepository
      const binding = yield* Effect.orDie(bindings.resolve(customId))

      if (binding === undefined) {
        // A handle we did not mint, or one whose owner is gone. Deferring and saying nothing is
        // better than a visible error for a button the user could not have known was stale.
        return {
          response: json(200, { type: CALLBACK_TYPE.deferredChannelMessageWithSource }),
          dispatch: { outcome: 'unbound', customId } as const,
        }
      }

      return {
        // Deterministic deferral. A handler that has not answered within the internal deadline
        // would otherwise lose Discord's three-second window entirely.
        response: json(200, { type: CALLBACK_TYPE.deferredChannelMessageWithSource }),
        dispatch: { outcome: 'dispatched', interactionId, binding } as const,
      }
    }

    // Commands and autocomplete are dispatched by name once workflows register them; until then
    // deferring keeps the interaction alive rather than showing the user a failure.
    return {
      response: json(200, { type: CALLBACK_TYPE.deferredChannelMessageWithSource }),
      dispatch: { outcome: 'deferred', interactionId } as const,
    }
  })

/**
 * What gets persisted or logged for an interaction.
 *
 * The token is a bearer credential valid for fifteen minutes that can post as the bot. Storing it
 * would put a live credential in the event log, where retention outlives its usefulness.
 */
export const storableInteraction = (payload: unknown): unknown => redactInteraction(payload)
