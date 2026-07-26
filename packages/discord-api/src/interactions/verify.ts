import { createPublicKey, verify as verifyEd25519 } from 'node:crypto'

/**
 * Ed25519 verification for Discord's interactions endpoint.
 *
 * The signature covers `timestamp + rawBody`, so the **raw bytes** must be preserved. Verifying a
 * re-serialised body would fail on any key ordering or whitespace difference, and — worse —
 * verifying *after* JSON decoding would mean parsing attacker-controlled input before proving it
 * came from Discord. Discord disables an endpoint that fails verification, so getting this wrong
 * is not subtle.
 */

/** Discord's own tolerance. Older timestamps are replays or clock problems, and both are refused. */
export const MAX_TIMESTAMP_SKEW_MS = 5 * 60 * 1000

export type VerificationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string }

export interface VerificationInput {
  readonly signature: string | null
  readonly timestamp: string | null
  /** Exactly the bytes Discord sent. Not a re-encoding of a parsed object. */
  readonly rawBody: Uint8Array
  /** Application public key, hex, from the Developer Portal. */
  readonly publicKey: string
  readonly now: number
}

const hexToBytes = (hex: string): Uint8Array | undefined => {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) return undefined
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

/** DER prefix for an Ed25519 SubjectPublicKeyInfo, so a raw 32-byte key can be imported. */
const ED25519_SPKI_PREFIX = new Uint8Array([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
])

export const verifyInteractionSignature = (input: VerificationInput): VerificationResult => {
  if (input.signature === null || input.timestamp === null) {
    return {
      ok: false,
      reason:
        'Missing X-Signature-Ed25519 or X-Signature-Timestamp. Every genuine Discord interaction carries both.',
    }
  }

  const timestampSeconds = Number(input.timestamp)
  if (!Number.isFinite(timestampSeconds)) {
    return { ok: false, reason: 'X-Signature-Timestamp is not a number.' }
  }

  // Checked before the signature: a valid signature over a stale timestamp is a replay, and
  // rejecting it early avoids spending a verification on it.
  const skew = Math.abs(input.now - timestampSeconds * 1000)
  if (skew > MAX_TIMESTAMP_SKEW_MS) {
    return {
      ok: false,
      reason: `X-Signature-Timestamp is ${Math.round(skew / 1000)}s from now, beyond the ${MAX_TIMESTAMP_SKEW_MS / 1000}s tolerance. Either this is a replay or the server clock is wrong.`,
    }
  }

  const signatureBytes = hexToBytes(input.signature)
  const keyBytes = hexToBytes(input.publicKey)
  if (signatureBytes === undefined || signatureBytes.length !== 64) {
    return { ok: false, reason: 'X-Signature-Ed25519 is not 64 hex-encoded bytes.' }
  }
  if (keyBytes === undefined || keyBytes.length !== 32) {
    return {
      ok: false,
      reason:
        'DISCORD_PUBLIC_KEY is not a 32-byte hex value. Copy it from the Developer Portal’s General Information page.',
    }
  }

  const message = new Uint8Array(
    Buffer.concat([Buffer.from(input.timestamp, 'utf8'), input.rawBody]),
  )

  try {
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, keyBytes]),
      format: 'der',
      type: 'spki',
    })
    return verifyEd25519(null, message, key, signatureBytes)
      ? { ok: true }
      : { ok: false, reason: 'The Ed25519 signature does not match.' }
  } catch (cause) {
    return { ok: false, reason: `Signature verification failed: ${String(cause)}` }
  }
}

/** Discord's interaction types. */
export const INTERACTION_TYPE = {
  ping: 1,
  applicationCommand: 2,
  messageComponent: 3,
  autocomplete: 4,
  modalSubmit: 5,
} as const

/** Discord's callback types. */
export const CALLBACK_TYPE = {
  pong: 1,
  channelMessageWithSource: 4,
  deferredChannelMessageWithSource: 5,
  deferredUpdateMessage: 6,
  updateMessage: 7,
  autocompleteResult: 8,
  modal: 9,
} as const

/**
 * Discord requires an initial response within three seconds. Deferring at 2.5 leaves margin for
 * the response itself to reach Discord — a handler that finishes at 2.9 seconds still loses.
 */
export const INTERNAL_DEFER_DEADLINE_MS = 2500

/** Once deferred, Discord accepts follow-ups for fifteen minutes and then the token is dead. */
export const FOLLOW_UP_WINDOW_MS = 15 * 60 * 1000

/**
 * A deferred response (callback type 5) cannot set `IS_COMPONENTS_V2`.
 *
 * Components V2 content has to arrive by *editing* the original response afterwards. Sending the
 * flag with the deferral is a 400, and it is an easy mistake because every other path sets it.
 */
export const deferralAllowsComponentsV2 = false

/** Interaction tokens are credentials. They must never reach a log or a stored payload. */
export const redactInteraction = (payload: unknown): unknown => {
  if (payload === null || typeof payload !== 'object') return payload
  const { token, ...rest } = payload as Record<string, unknown>
  return token === undefined ? payload : { ...rest, token: '[redacted]' }
}
