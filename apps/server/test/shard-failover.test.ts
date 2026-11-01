import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { createTokenVault, shardOwner } from '@discord-mcp/bot-host'
import { type FakeConnection, fakeGateway } from '@discord-mcp/bot-host/testing'
import { connectStorage, type Storage } from '@discord-mcp/storage'
import { PGlite } from '@electric-sql/pglite'
import { PGLiteSocketServer } from '@electric-sql/pglite-socket'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { ownerOf } from '../src/router.ts'
import { botToken } from './login-fixture.ts'

/** The built binary: `pnpm check` builds before testing, and three hosts transpiling at once are slow. */
const BIN = fileURLToPath(new URL('../dist/bin.js', import.meta.url))
const NETWORK = fileURLToPath(new URL('./support/discord-network.ts', import.meta.url))
const SECRET = 'test-bot-host-secret-0123456789abcdef'
const KEY = Buffer.alloc(32, 1)
/** Chosen once the hosts' ports are known, so its shards spread over more than one of them. */
let BOT_ID = ''
let TOKEN = ''
const SHARDS = 4
/** A dead host's leases expire within 15 seconds; its shards resume on the next pass after. */
const FAILOVER_MS = 30_000
/** Three processes' session writes queue at PGlite's one connection. */
const STORED_MS = 10_000

/** Discord's REST API, for checking the bot's token and saying how to shard it. */
const fakeRest = async (gatewayUrl: string) => {
  const server = createServer((request, response) => {
    if (request.headers.authorization !== `Bot ${TOKEN}`) return response.writeHead(401).end()
    const path = new URL(request.url ?? '/', 'http://discord.test').pathname
    response.writeHead(200, { 'content-type': 'application/json' })
    if (path === '/api/v10/users/@me') {
      return response.end(JSON.stringify({ id: BOT_ID, bot: true, username: 'bot' }))
    }
    response.end(
      JSON.stringify({
        url: gatewayUrl,
        shards: SHARDS,
        session_start_limit: {
          total: 1000,
          remaining: 1000,
          reset_after: 24 * 60 * 60 * 1000,
          max_concurrency: SHARDS,
        },
      }),
    )
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

const freePort = async () => {
  const server = createServer().listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address() as AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

/** A bot ID whose shards rendezvous hashing spreads over more than one of `hosts`. */
const botSpreadOver = (hosts: ReadonlyArray<string>) => {
  for (let id = 345678901234567890n; ; id += 1n) {
    const owners = Array.from({ length: SHARDS }, (_, shardId) =>
      shardOwner(hosts, String(id), shardId),
    )
    if (new Set(owners).size > 1) return String(id)
  }
}

/** Start the real binary as a bot host and resolve once it listens. */
const startHost = (env: Record<string, string>) =>
  new Promise<{ readonly kill: () => void; readonly stop: () => void }>((resolve, reject) => {
    const { DISCORD_OAUTH_ALLOWED_USER_IDS: _, DATABASE_URL: __, ...inherited } = process.env
    // Node itself, not a wrapper, so a SIGKILL kills the host. Node strips the preload's types.
    const child = spawn(process.execPath, ['--import', NETWORK, BIN], {
      env: {
        ...inherited,
        MCP_TRANSPORT: 'http',
        DISCORD_MCP_TIER: 'bot-host',
        BOT_HOST_SECRET: SECRET,
        TOKEN_VAULT_KEY: KEY.toString('base64'),
        DISCORD_OAUTH_ALLOWED_USER_IDS: '234567890123456789',
        ...env,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
      if (!stderr.includes('listening on')) return
      resolve({ kill: () => child.kill('SIGKILL'), stop: () => child.kill('SIGTERM') })
    })
    child.on('close', () => reject(new Error(`${env.BOT_HOST_URL} exited: ${stderr}`)))
  })

/** Ask a bot host for the tool list as the bot, which brings it online. */
const useBot = (host: string) =>
  fetch(`${host}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-method': 'tools/list',
      'mcp-protocol-version': '2026-07-28',
      authorization: `Bearer ${SECRET}`,
      'x-discord-bot-token': TOKEN,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    }),
  })

const callerOf = (connection: FakeConnection) =>
  new URL(connection.path, 'ws://gateway.test').searchParams.get('caller')
const first = (connection: FakeConnection) =>
  connection.received[0] as { op: number; d: { shard?: number[]; seq?: number } } | undefined
/** Each shard's sequence number before the kill, so a resume names its shard by its `seq`. */
const sequenceOf = (shardId: number) => 100 * (shardId + 1)

describe('shard failover across bot host processes', () => {
  const children: Array<{ readonly kill: () => void; readonly stop: () => void }> = []
  let db: PGlite
  let postgres: PGLiteSocketServer
  let storage: Storage
  let gateway: Awaited<ReturnType<typeof fakeGateway>>
  let rest: Awaited<ReturnType<typeof fakeRest>>
  let hosts: string[]

  beforeAll(async () => {
    db = await PGlite.create()
    postgres = new PGLiteSocketServer({ db, host: '127.0.0.1', port: 0, maxConnections: 100 })
    await postgres.start()
    const databaseUrl = `postgres://postgres@${postgres.getServerConn()}/postgres`
    gateway = await fakeGateway()
    rest = await fakeRest(gateway.url)
    const ports = [await freePort(), await freePort(), await freePort()]
    hosts = ports.map((port) => `http://127.0.0.1:${port}`)
    BOT_ID = botSpreadOver(hosts)
    TOKEN = botToken(BOT_ID)
    // One at a time, so only the first applies migrations.
    for (const [index, host] of hosts.entries()) {
      children.push(
        await startHost({
          BOT_HOSTS: hosts.join(','),
          BOT_HOST_URL: host,
          MCP_HTTP_PORT: String(ports[index]),
          DATABASE_URL: databaseUrl,
          FAKE_DISCORD_URL: rest.url,
          TEST_CALLER: host,
        }),
      )
    }
    storage = await connectStorage(databaseUrl, () => {})
  }, 60_000)

  afterAll(async () => {
    for (const child of children) child.stop()
    await storage?.close()
    await gateway?.close()
    await rest?.close()
    await postgres?.stop()
    await db?.close()
  })

  it("runs a bot's shards on several hosts, and resumes a killed host's shards on the others", async () => {
    const owner = ownerOf(hosts, BOT_ID) ?? ''
    expect((await useBot(owner)).status).toBe(200)

    // Every host joins in within one pass, and each shard identifies once, on one host.
    await vi.waitFor(
      () => expect(gateway.connections.filter((c) => first(c)?.op === 2)).toHaveLength(SHARDS),
      { timeout: 15_000 },
    )
    const ran = new Map<number, string | null>()
    for (const connection of gateway.connections) {
      const [shardId = -1] = first(connection)?.d.shard ?? []
      ran.set(shardId, callerOf(connection))
      connection.send({ op: 0, t: 'MESSAGE_CREATE', s: sequenceOf(shardId), d: {} })
    }
    expect([...ran.keys()].sort()).toEqual([0, 1, 2, 3])
    expect(new Set(ran.values()).size).toBeGreaterThan(1)
    const vault = createTokenVault(KEY, storage)
    const stored = async () => {
      const [bot] = await vault.loadOnline()
      return [...(bot?.sessions ?? [])].map(([id, session]) => [id, session.sequence])
    }
    await vi.waitFor(
      async () =>
        expect((await stored()).sort()).toEqual([0, 1, 2, 3].map((id) => [id, sequenceOf(id)])),
      { timeout: STORED_MS },
    )

    // Kill the host running the most shards, with no chance to hand them over.
    const counts = [...ran.values()].map((host) => [...ran.values()].filter((h) => h === host))
    const victim = counts.sort((a, b) => b.length - a.length)[0]?.[0]
    const stranded = [...ran].filter(([, host]) => host === victim).map(([shardId]) => shardId)
    children[hosts.indexOf(victim ?? '')]?.kill()
    const before = gateway.connections.length

    // The survivors resume each stranded shard from its stored sequence, once each.
    await vi.waitFor(() => expect(gateway.connections.length - before).toBe(stranded.length), {
      timeout: FAILOVER_MS,
    })
    const resumed = gateway.connections.slice(before)
    await vi.waitFor(() => expect(resumed.every((c) => first(c)?.op === 6)).toBe(true))
    expect(resumed.map((c) => first(c)?.d.seq).sort()).toEqual(stranded.map(sequenceOf).sort())
    expect(resumed.every((c) => callerOf(c) !== victim)).toBe(true)

    // Discord replays what the killed host missed, and the new host takes it from there.
    for (const connection of resumed) {
      const seq = first(connection)?.d.seq ?? 0
      connection.send({ op: 0, t: 'MESSAGE_CREATE', s: seq + 1, d: {} })
      connection.send({ op: 0, t: 'MESSAGE_CREATE', s: seq + 2, d: {} })
      connection.send({ op: 0, t: 'RESUMED', s: seq + 3, d: {} })
    }
    await vi.waitFor(
      async () =>
        expect((await stored()).sort()).toEqual(
          [0, 1, 2, 3].map((id) => [id, sequenceOf(id) + (stranded.includes(id) ? 3 : 0)]),
        ),
      { timeout: STORED_MS },
    )
    // Exactly one open connection per shard, and no shard identified twice.
    expect(gateway.connections.filter((c) => c.closeCode === undefined)).toHaveLength(SHARDS)
    expect(gateway.connections.filter((c) => first(c)?.op === 2)).toHaveLength(SHARDS)
  }, 90_000)
})
