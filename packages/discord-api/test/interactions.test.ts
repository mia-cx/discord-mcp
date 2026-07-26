import { generateKeyPairSync, sign as signEd25519 } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ComponentBindingRepository,
  type Database,
  PersistenceLayer,
} from '@discord-mcp/persistence'
import { Effect, ManagedRuntime } from 'effect'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { routeInteraction, storableInteraction } from '../src/interactions/router.ts'
import {
  CALLBACK_TYPE,
  INTERACTION_TYPE,
  INTERNAL_DEFER_DEADLINE_MS,
  MAX_TIMESTAMP_SKEW_MS,
  verifyInteractionSignature,
} from '../src/interactions/verify.ts'

/**
 * A real Ed25519 key pair, so the signature path is exercised rather than stubbed. Discord
 * disables an endpoint whose verification misbehaves, which makes this the least forgiving code in
 * the project.
 */
const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const publicKeyHex = Buffer.from(
  publicKey.export({ format: 'der', type: 'spki' }).subarray(12),
).toString('hex')

const sign = (timestamp: string, body: string) =>
  signEd25519(
    null,
    Buffer.concat([Buffer.from(timestamp), Buffer.from(body)]),
    privateKey,
  ).toString('hex')

const NOW = 1_700_000_000_000
const nowSeconds = String(Math.floor(NOW / 1000))

let dir: string
let runtime: ManagedRuntime.ManagedRuntime<ComponentBindingRepository | Database, never>

const route = (
  over: { body?: string; signature?: string; timestamp?: string; now?: number } = {},
) => {
  const body = over.body ?? JSON.stringify({ type: INTERACTION_TYPE.ping })
  const timestamp = over.timestamp ?? nowSeconds
  return runtime.runPromise(
    routeInteraction({
      signature: over.signature ?? sign(timestamp, body),
      timestamp,
      rawBody: new Uint8Array(Buffer.from(body)),
      publicKey: publicKeyHex,
      now: over.now ?? NOW,
    }),
  )
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'discord-mcp-interactions-'))
  runtime = ManagedRuntime.make(PersistenceLayer(join(dir, 'i.sqlite')))
})

afterEach(async () => {
  await runtime.dispose()
  rmSync(dir, { recursive: true, force: true })
})

describe('signature verification', () => {
  it('accepts a genuine signature over the raw bytes', () => {
    const body = '{"type":1}'
    const result = verifyInteractionSignature({
      signature: sign(nowSeconds, body),
      timestamp: nowSeconds,
      rawBody: new Uint8Array(Buffer.from(body)),
      publicKey: publicKeyHex,
      now: NOW,
    })
    expect(result.ok).toBe(true)
  })

  it('fails if the body is re-serialised rather than passed through', () => {
    // The signature covers the exact bytes. Re-encoding a parsed object changes key order and
    // whitespace, which is why the raw body has to be preserved all the way here.
    const original = '{"type":1,"id":"123"}'
    const reserialised = JSON.stringify(JSON.parse(original))

    const result = verifyInteractionSignature({
      signature: sign(nowSeconds, original),
      timestamp: nowSeconds,
      rawBody: new Uint8Array(Buffer.from(`${reserialised} `)),
      publicKey: publicKeyHex,
      now: NOW,
    })
    expect(result.ok).toBe(false)
  })

  it('rejects a signature from a different key', () => {
    const other = generateKeyPairSync('ed25519')
    const body = '{"type":1}'
    const forged = signEd25519(
      null,
      Buffer.concat([Buffer.from(nowSeconds), Buffer.from(body)]),
      other.privateKey,
    ).toString('hex')

    const result = verifyInteractionSignature({
      signature: forged,
      timestamp: nowSeconds,
      rawBody: new Uint8Array(Buffer.from(body)),
      publicKey: publicKeyHex,
      now: NOW,
    })
    expect(result.ok).toBe(false)
  })

  it('rejects a stale timestamp even when the signature is valid', () => {
    // A correctly signed replay. Without the timestamp check, a captured request would work
    // forever.
    const body = '{"type":1}'
    const old = String(Math.floor((NOW - MAX_TIMESTAMP_SKEW_MS - 1000) / 1000))

    const result = verifyInteractionSignature({
      signature: sign(old, body),
      timestamp: old,
      rawBody: new Uint8Array(Buffer.from(body)),
      publicKey: publicKeyHex,
      now: NOW,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('replay')
  })

  it('rejects missing headers and a malformed public key', () => {
    const body = '{"type":1}'
    const raw = new Uint8Array(Buffer.from(body))

    expect(
      verifyInteractionSignature({
        signature: null,
        timestamp: nowSeconds,
        rawBody: raw,
        publicKey: publicKeyHex,
        now: NOW,
      }).ok,
    ).toBe(false)

    const badKey = verifyInteractionSignature({
      signature: sign(nowSeconds, body),
      timestamp: nowSeconds,
      rawBody: raw,
      publicKey: 'not-hex',
      now: NOW,
    })
    expect(badKey.ok).toBe(false)
    if (!badKey.ok) expect(badKey.reason).toContain('Developer Portal')
  })
})

describe('routing', () => {
  it('answers PING with PONG, which is what enables the endpoint at all', async () => {
    const { response, dispatch } = await route()
    expect(response.status).toBe(200)
    expect((response.body as { type: number }).type).toBe(CALLBACK_TYPE.pong)
    expect(dispatch.outcome).toBe('pong')
  })

  it('never reaches the parser when the signature is bad', async () => {
    // Deliberately unparseable. If routing decoded before verifying, this would fail as invalid
    // JSON rather than as an invalid signature — which is exactly the ordering bug being ruled out.
    const { response, dispatch } = await route({
      body: 'this is not json at all',
      signature: 'deadbeef'.repeat(16),
    })

    expect(response.status).toBe(401)
    expect(dispatch.outcome).toBe('rejected')
    if (dispatch.outcome === 'rejected') expect(dispatch.reason).toContain('signature')
  })

  it('says nothing about why a signature failed', async () => {
    const { response } = await route({ signature: '00'.repeat(64) })
    // The reason is only useful to someone probing the endpoint.
    expect(JSON.stringify(response.body)).toBe('{"error":"invalid_signature"}')
  })

  it('resolves an opaque handle to its binding', async () => {
    const handle = await runtime.runPromise(
      Effect.flatMap(ComponentBindingRepository, (r) =>
        r.create({
          kind: 'workflow',
          actionKey: 'acknowledge',
          ownerKind: 'workflow',
          ownerId: 'w1',
          ownerRevision: 2,
        }),
      ),
    )

    const { response, dispatch } = await route({
      body: JSON.stringify({
        type: INTERACTION_TYPE.messageComponent,
        id: '111111111111111111',
        data: { custom_id: handle },
      }),
    })

    expect((response.body as { type: number }).type).toBe(
      CALLBACK_TYPE.deferredChannelMessageWithSource,
    )
    expect(dispatch.outcome).toBe('dispatched')
    if (dispatch.outcome === 'dispatched') {
      expect(dispatch.binding.actionKey).toBe('acknowledge')
      expect(dispatch.binding.ownerRevision).toBe(2)
    }
  })

  it('treats a tampered handle as unbound rather than trusting it', async () => {
    // custom_id round-trips through the client, so it is untrusted input on the way back.
    const { response, dispatch } = await route({
      body: JSON.stringify({
        type: INTERACTION_TYPE.messageComponent,
        id: '111111111111111111',
        data: { custom_id: 'workflow:w1:acknowledge' },
      }),
    })

    expect(dispatch.outcome).toBe('unbound')
    // Still a valid deferral: the user pressed a button and should not see a failure for a stale
    // one they could not have known about.
    expect((response.body as { type: number }).type).toBe(
      CALLBACK_TYPE.deferredChannelMessageWithSource,
    )
  })

  it('deduplicates a retried interaction without running it twice', async () => {
    const handle = await runtime.runPromise(
      Effect.flatMap(ComponentBindingRepository, (r) =>
        r.create({ kind: 'inbox', actionKey: 'k', ownerKind: 'message', ownerId: 'm1' }),
      ),
    )
    const body = JSON.stringify({
      type: INTERACTION_TYPE.messageComponent,
      id: '222222222222222222',
      data: { custom_id: handle },
    })

    const first = await route({ body })
    const second = await route({ body })

    expect(first.dispatch.outcome).toBe('dispatched')
    // Discord retries when it thinks it did not hear back; the handler must not run again.
    expect(second.dispatch.outcome).toBe('duplicate')
    expect((second.response.body as { type: number }).type).toBe(
      CALLBACK_TYPE.deferredChannelMessageWithSource,
    )
  })
})

describe('token handling', () => {
  it('redacts the interaction token before anything stores or logs it', () => {
    const payload = {
      id: '1',
      token: 'a-live-bearer-credential',
      data: { custom_id: 'h' },
    }
    const stored = storableInteraction(payload) as Record<string, unknown>

    // Valid for fifteen minutes and able to post as the bot; retention would outlive its
    // usefulness and leave a live credential in the log.
    expect(stored.token).toBe('[redacted]')
    expect(JSON.stringify(stored)).not.toContain('a-live-bearer-credential')
    expect(stored.id).toBe('1')
  })
})

describe('timing', () => {
  it('defers inside Discord’s three-second window with margin', () => {
    // A handler that answers at 2.9s still loses, because the response itself has to reach
    // Discord before the deadline.
    expect(INTERNAL_DEFER_DEADLINE_MS).toBeLessThan(3000)
    expect(3000 - INTERNAL_DEFER_DEADLINE_MS).toBeGreaterThanOrEqual(500)
  })
})
