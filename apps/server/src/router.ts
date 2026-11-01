const BASE64 = /^[A-Za-z0-9+/_-]+={0,2}$/
/** A Discord ID, such as a bot's. */
export const SNOWFLAKE = /^\d{17,20}$/

/**
 * The bot ID a Discord bot token names in its first segment, base64 of the decimal ID. Only routes
 * the request: the owning bot host still checks the token with Discord before acting on it.
 */
export const botIdFromToken = (token: string): string | undefined => {
  const [segment = ''] = token.split('.')
  if (!BASE64.test(segment)) return undefined
  const id = Buffer.from(segment, 'base64').toString('utf8')
  return SNOWFLAKE.test(id) ? id : undefined
}

/** The bot host that owns `botId` and so its REST traffic, by rendezvous hashing. */
export { ownerOf } from '@discord-mcp/bot-host'
