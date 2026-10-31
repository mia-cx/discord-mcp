import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type { Storage } from '@discord-mcp/storage'

const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12
const TAG_BYTES = 16
const VERSION = 'v1'

/** Stores bot tokens encrypted at rest and decrypts them again. */
export interface TokenVault {
  readonly store: (botId: string, token: string) => Promise<void>
  /** Throws when the vault key differs from the one that sealed the token. */
  readonly load: (botId: string) => Promise<string | undefined>
}

/**
 * AES-256-GCM under a 32-byte key. The bot ID is authenticated data, so a sealed token copied to
 * another bot's row fails to open.
 */
export const createTokenVault = (key: Buffer, storage: Storage): TokenVault => {
  const seal = (botId: string, token: string) => {
    const iv = randomBytes(IV_BYTES)
    const cipher = createCipheriv(ALGORITHM, key, iv).setAAD(Buffer.from(botId))
    const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()])
    const parts = [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString('base64url'))
    return [VERSION, ...parts].join('.')
  }
  const open = (botId: string, sealed: string) => {
    const [version, iv, tag, ciphertext] = sealed.split('.')
    if (version !== VERSION || iv === undefined || tag === undefined || ciphertext === undefined) {
      throw new Error(`Bot ${botId} has an unrecognised sealed token.`)
    }
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'base64url'), {
      authTagLength: TAG_BYTES,
    })
      .setAAD(Buffer.from(botId))
      .setAuthTag(Buffer.from(tag, 'base64url'))
    const plaintext = [decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]
    return Buffer.concat(plaintext).toString('utf8')
  }
  return {
    store: (botId, token) => storage.storeSealedToken(botId, seal(botId, token)),
    load: async (botId) => {
      const sealed = await storage.loadSealedToken(botId)
      return sealed === undefined ? undefined : open(botId, sealed)
    },
  }
}
