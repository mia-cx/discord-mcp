import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { AuthenticationError } from './principal.js'

export class TokenEncryption {
  readonly #key: Buffer

  constructor(base64Key: string) {
    this.#key = Buffer.from(base64Key, 'base64')
    if (this.#key.length !== 32) {
      throw new AuthenticationError('DISCORD_MCP_MASTER_KEY must be exactly 32 bytes in base64')
    }
  }

  encrypt(plaintext: string, context: string): Buffer {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv)
    cipher.setAAD(Buffer.from(context))
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), ciphertext])
  }

  decrypt(payload: Uint8Array, context: string): string {
    const bytes = Buffer.from(payload)
    if (bytes.length < 30 || bytes[0] !== 1)
      throw new AuthenticationError('invalid encrypted value')
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.#key, bytes.subarray(1, 13))
      decipher.setAAD(Buffer.from(context))
      decipher.setAuthTag(bytes.subarray(13, 29))
      return Buffer.concat([decipher.update(bytes.subarray(29)), decipher.final()]).toString('utf8')
    } catch {
      throw new AuthenticationError('encrypted value could not be authenticated')
    }
  }
}
