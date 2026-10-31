import { createHash } from 'node:crypto'

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

const weight = (host: string, botId: string) =>
  createHash('sha256').update(`${host}\n${botId}`).digest().readBigUInt64BE()

/**
 * The bot host that owns `botId`, by rendezvous hashing: each host scores the bot, and the highest
 * score wins. Every caller with the same hosts agrees whatever their order, and adding or removing
 * a host moves only the bots that host gains or loses.
 */
export const ownerOf = (hosts: ReadonlyArray<string>, botId: string): string | undefined => {
  let owner: { host: string; weight: bigint } | undefined
  for (const host of hosts) {
    const score = weight(host, botId)
    if (
      owner === undefined ||
      score > owner.weight ||
      (score === owner.weight && host < owner.host)
    )
      owner = { host, weight: score }
  }
  return owner?.host
}
