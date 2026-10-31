import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type { Storage } from '@discord-mcp/storage'
import type { ShardSession } from './shard.ts'

const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12
const TAG_BYTES = 16
const VERSION = 'v1'

/** A shard session another process left resumable, with the token that resumes it. */
export interface StoredSession {
  readonly botId: string
  readonly shardId: number
  readonly token: string
  readonly session: ShardSession
}

/** Stores bot tokens and their shards' Gateway sessions encrypted at rest, and decrypts them. */
export interface TokenVault {
  readonly store: (botId: string, token: string) => Promise<void>
  /** Throws when the vault key differs from the one that sealed the token. */
  readonly load: (botId: string) => Promise<string | undefined>
  /** Store a shard's resumable session. The bot's token must be stored first. */
  readonly storeSession: (botId: string, shardId: number, session: ShardSession) => Promise<void>
  readonly clearSession: (botId: string, shardId: number) => Promise<void>
  /** Every stored shard session. Throws when the vault key differs from the one that sealed it. */
  readonly loadSessions: () => Promise<ReadonlyArray<StoredSession>>
}

/**
 * AES-256-GCM under a 32-byte key. The bot ID, and for sessions the shard ID, are authenticated
 * data, so an envelope copied to another bot's row, or between columns, fails to open.
 */
export const createTokenVault = (key: Buffer, storage: Storage): TokenVault => {
  const seal = (context: string, plaintext: string) => {
    const iv = randomBytes(IV_BYTES)
    const cipher = createCipheriv(ALGORITHM, key, iv).setAAD(Buffer.from(context))
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    const parts = [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString('base64url'))
    return [VERSION, ...parts].join('.')
  }
  const open = (context: string, sealed: string) => {
    const [version, iv, tag, ciphertext] = sealed.split('.')
    if (version !== VERSION || iv === undefined || tag === undefined || ciphertext === undefined) {
      throw new Error(`Unrecognised vault envelope for ${context}.`)
    }
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'base64url'), {
      authTagLength: TAG_BYTES,
    })
      .setAAD(Buffer.from(context))
      .setAuthTag(Buffer.from(tag, 'base64url'))
    const plaintext = [decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]
    return Buffer.concat(plaintext).toString('utf8')
  }
  // Bot IDs are digits only, so no session context can equal a token's.
  const sessionContext = (botId: string, shardId: number) => `session:${botId}:${shardId}`
  return {
    store: (botId, token) => storage.storeSealedToken(botId, seal(botId, token)),
    load: async (botId) => {
      const sealed = await storage.loadSealedToken(botId)
      return sealed === undefined ? undefined : open(botId, sealed)
    },
    storeSession: (botId, shardId, session) =>
      storage.storeSealedSession(
        botId,
        shardId,
        seal(sessionContext(botId, shardId), JSON.stringify(session)),
      ),
    clearSession: (botId, shardId) => storage.deleteSession(botId, shardId),
    loadSessions: async () =>
      (await storage.loadSealedSessions()).map(
        ({ botId, shardId, sealedSession, sealedToken }) => ({
          botId,
          shardId,
          token: open(botId, sealedToken),
          session: JSON.parse(open(sessionContext(botId, shardId), sealedSession)),
        }),
      ),
  }
}
