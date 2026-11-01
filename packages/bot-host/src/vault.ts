import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type {
  BotGateway,
  BotOnline,
  BotRanAs,
  Fence,
  Storage,
  StoredBot,
} from '@discord-mcp/storage'
import type { ShardSession } from './shard.ts'

const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12
const TAG_BYTES = 16
const VERSION = 'v1'

/** A stored bot, its token opened. */
export interface VaultBot extends Omit<StoredBot, 'sealedToken'> {
  readonly token: string
}

/** An online bot, its token and the sessions its shards left resumable opened. */
export interface OnlineVaultBot extends BotOnline, BotGateway {
  readonly botId: string
  readonly token: string
  readonly sessions: ReadonlyMap<number, ShardSession>
}

/** Stores bot tokens and their shards' Gateway sessions encrypted at rest, and decrypts them. */
export interface TokenVault {
  /** Store a bot's token. A replaced token takes the bot offline and ends its sessions. */
  readonly store: (botId: string, token: string) => Promise<void>
  /** Throws when the vault key differs from the one that sealed the token. */
  readonly load: (botId: string) => Promise<VaultBot | undefined>
  /**
   * `setBotOnline`, while `token` is still the bot's stored token: an answer for a replaced token
   * says nothing about its successor. Resolves whether it changed.
   */
  readonly setOnline: (botId: string, token: string, online: BotOnline) => Promise<boolean>
  /** `setBotOffline`, while `token` is still the bot's stored token. Resolves whether it changed. */
  readonly setOffline: (
    botId: string,
    token: string,
    options: {
      readonly rejectedCode?: number
      readonly ranAs?: BotRanAs
    },
  ) => Promise<boolean>
  /** Store a shard's resumable session while `fence` holds. The bot's token must be stored first. */
  readonly storeSession: (
    botId: string,
    shardId: number,
    session: ShardSession,
    fence: Fence,
  ) => Promise<void>
  readonly clearSession: (botId: string, shardId: number, fence: Fence) => Promise<void>
  /** Every online bot. Throws when the vault key differs from the one that sealed it. */
  readonly loadOnline: () => Promise<ReadonlyArray<OnlineVaultBot>>
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
  /** The envelope of `token` as stored, if it still is. Each store seals afresh. */
  const sealedAs = async (botId: string, token: string) => {
    const stored = await storage.loadBot(botId)
    if (stored === undefined || open(botId, stored.sealedToken) !== token) return undefined
    return stored.sealedToken
  }
  return {
    store: (botId, token) => storage.storeSealedToken(botId, seal(botId, token)),
    load: async (botId) => {
      const stored = await storage.loadBot(botId)
      if (stored === undefined) return undefined
      const { sealedToken, ...bot } = stored
      return { ...bot, token: open(botId, sealedToken) }
    },
    setOnline: async (botId, token, online) => {
      const sealedToken = await sealedAs(botId, token)
      return sealedToken !== undefined && storage.setBotOnline(botId, sealedToken, online)
    },
    setOffline: async (botId, token, options) => {
      const sealedToken = await sealedAs(botId, token)
      return sealedToken !== undefined && storage.setBotOffline(botId, { ...options, sealedToken })
    },
    storeSession: (botId, shardId, session, fence) =>
      storage.storeSealedSession(
        botId,
        shardId,
        seal(sessionContext(botId, shardId), JSON.stringify(session)),
        fence,
      ),
    clearSession: (botId, shardId, fence) => storage.deleteSession(botId, shardId, fence),
    loadOnline: async () =>
      (await storage.loadOnlineBots()).map(({ sealedToken, sessions, ...bot }) => ({
        ...bot,
        token: open(bot.botId, sealedToken),
        sessions: new Map(
          sessions.map(({ shardId, sealedSession }) => {
            // Sessions sealed before they carried intents read without them, and so resume nothing.
            const { sessionId, resumeGatewayUrl, sequence, intents, stale }: ShardSession =
              JSON.parse(open(sessionContext(bot.botId, shardId), sealedSession))
            const session = { sessionId, resumeGatewayUrl, sequence, intents }
            return [shardId, stale === true ? { ...session, stale } : session]
          }),
        ),
      })),
  }
}
