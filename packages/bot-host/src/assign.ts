import { createHash } from 'node:crypto'

const weight = (host: string, key: string) =>
  createHash('sha256').update(`${host}\n${key}`).digest().readBigUInt64BE()

/**
 * The host that owns `key`, by rendezvous hashing: each host scores the key, and the highest score
 * wins. Every caller with the same hosts agrees whatever their order, and adding or removing a
 * host moves only the keys that host gains or loses.
 */
export const ownerOf = (hosts: ReadonlyArray<string>, key: string): string | undefined => {
  let owner: { host: string; weight: bigint } | undefined
  for (const host of hosts) {
    const score = weight(host, key)
    if (
      owner === undefined ||
      score > owner.weight ||
      (score === owner.weight && host < owner.host)
    )
      owner = { host, weight: score }
  }
  return owner?.host
}

/** The host that runs one shard of a bot. A bot's shards spread across hosts independently. */
export const shardOwner = (hosts: ReadonlyArray<string>, botId: string, shardId: number) =>
  ownerOf(hosts, `${botId}/${shardId}`)
