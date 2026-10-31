import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createRelay } from '../src/relay.ts'
import { ownerOf } from '../src/router.ts'
import { botToken, config, discordOAuth, executor, login } from './login-fixture.ts'

const BIN = fileURLToPath(new URL('../src/bin.ts', import.meta.url))
const TSX = fileURLToPath(new URL('../../../node_modules/.bin/tsx', import.meta.url))
const NETWORK = fileURLToPath(new URL('./support/discord-network.ts', import.meta.url))
const SECRET = 'test-bot-host-secret-0123456789abcdef'
const GUILD_ID = '123456789012345678'
/** Requests Discord allows per bot on the guild route before it answers 429. */
const GUILD_LIMIT = 2

interface DiscordCall {
  readonly caller: string
  readonly path: string
  readonly bot: string | undefined
}

/**
 * Discord's REST and OAuth endpoints over HTTP. The guild route enforces a per-bot limit and
 * advertises it the way Discord does, so a client that shares rate-limit state never sees a 429.
 */
const fakeDiscord = async (tokens: ReadonlyMap<string, string>) => {
  const oauth = discordOAuth()
  const calls: DiscordCall[] = []
  const guildCalls = new Map<string, number>()
  let tooManyRequests = 0
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? '/', 'http://discord.test').pathname
    const caller = String(request.headers['x-test-caller'])
    let body = ''
    for await (const chunk of request) body += String(chunk)
    if (path.includes('/oauth2/')) {
      calls.push({ caller, path, bot: undefined })
      const answer = await oauth.fetch(`https://discord.com${path}`, {
        method: request.method ?? 'GET',
        headers: { authorization: request.headers.authorization ?? '' },
        ...(body === '' ? {} : { body }),
      })
      response.writeHead(answer.status, { 'content-type': 'application/json' })
      return response.end(await answer.text())
    }
    const bot = tokens.get(request.headers.authorization?.replace(/^Bot /, '') ?? '')
    calls.push({ caller, path, bot })
    if (bot === undefined) return response.writeHead(401).end('{"message":"401: Unauthorized"}')
    if (path === '/api/v10/users/@me') {
      response.writeHead(200, { 'content-type': 'application/json' })
      return response.end(JSON.stringify({ id: bot, bot: true, username: 'bot' }))
    }
    const used = (guildCalls.get(bot) ?? 0) + 1
    guildCalls.set(bot, used)
    const limit = {
      'x-ratelimit-limit': String(GUILD_LIMIT),
      'x-ratelimit-remaining': String(Math.max(0, GUILD_LIMIT - used)),
      'x-ratelimit-reset-after': '60',
      'x-ratelimit-bucket': 'guild',
      'content-type': 'application/json',
    }
    if (used > GUILD_LIMIT) {
      tooManyRequests += 1
      response.writeHead(429, { ...limit, 'retry-after': '60', 'x-ratelimit-scope': 'user' })
      return response.end(
        JSON.stringify({ message: 'You are being rate limited.', retry_after: 60, global: false }),
      )
    }
    response.writeHead(200, limit)
    response.end(JSON.stringify({ id: GUILD_ID, name: `guild of ${bot}` }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    oauth,
    calls,
    tooManyRequests: () => tooManyRequests,
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

/** Start the real server binary as `name` and resolve with its port once it listens. */
const startTier = (name: string, discordUrl: string, env: Record<string, string>) =>
  new Promise<{ readonly url: string; readonly stop: () => void }>((resolve, reject) => {
    const { DISCORD_OAUTH_ALLOWED_USER_IDS: _, DATABASE_URL: __, ...inherited } = process.env
    const child = spawn(TSX, ['--import', NETWORK, BIN], {
      env: {
        ...inherited,
        MCP_TRANSPORT: 'http',
        MCP_HTTP_PORT: '0',
        FAKE_DISCORD_URL: discordUrl,
        TEST_CALLER: name,
        BOT_HOST_SECRET: SECRET,
        ...env,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
      const port = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(stderr)?.[1]
      if (port !== undefined) {
        resolve({ url: `http://127.0.0.1:${port}`, stop: () => child.kill('SIGTERM') })
      }
    })
    child.on('close', () => reject(new Error(`${name} exited: ${stderr}`)))
  })

/** A bot ID that `owner` owns among `hosts`. */
const botOwnedBy = (hosts: string[], owner: string) => {
  for (let id = 345678901234567890n; ; id += 1n) {
    if (ownerOf(hosts, String(id)) === owner) return String(id)
  }
}

const getGuild = (central: string, accessToken: string, token: string) =>
  fetch(`${central}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-method': 'tools/call',
      'mcp-name': 'discord_api_read',
      'mcp-protocol-version': '2026-07-28',
      authorization: `Bearer ${accessToken}`,
      'x-discord-bot-token': token,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientCapabilities': {},
        },
        name: 'discord_api_read',
        arguments: { operationId: 'get_guild', path: { guild_id: GUILD_ID } },
      },
    }),
  })

describe('central and bot-host tiers', () => {
  const stops: Array<() => void> = []
  let discord: Awaited<ReturnType<typeof fakeDiscord>>
  let hosts: string[]
  let centrals: string[]
  let accessToken: string
  const bots: Array<{ id: string; token: string; host: string }> = []

  beforeAll(async () => {
    const ports = [await freePort(), await freePort()]
    hosts = ports.map((port) => `http://127.0.0.1:${port}`)
    for (const [index, host] of hosts.entries()) {
      const id = botOwnedBy(hosts, host)
      bots.push({ id, token: botToken(id, `private-secret-${index}`), host })
    }
    discord = await fakeDiscord(new Map(bots.map((bot) => [bot.token, bot.id])))
    const membership = { BOT_HOSTS: hosts.join(','), DISCORD_MCP_TIER: 'bot-host' }
    const started = await Promise.all([
      ...hosts.map((host, index) =>
        startTier(host, discord.url, {
          ...membership,
          BOT_HOST_URL: host,
          MCP_HTTP_PORT: String(ports[index]),
        }),
      ),
      ...['central-a', 'central-b'].map((name) =>
        startTier(name, discord.url, {
          BOT_HOSTS: hosts.join(','),
          DISCORD_MCP_TIER: 'central',
          PUBLIC_BASE_URL: config.login.publicBaseUrl,
          DISCORD_OAUTH_CLIENT_ID: config.login.clientId,
          DISCORD_OAUTH_CLIENT_SECRET: 'test-client-secret',
          OAUTH_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
        }),
      ),
    ])
    for (const tier of started) stops.push(tier.stop)
    centrals = started.slice(2).map((tier) => tier.url)
    // Relay logins are stateless, so one minted here with the centrals' key works on both.
    const issuer = createRelay(config, executor(), discord.oauth.fetch)
    accessToken = (await login(issuer)).tokens.access_token
  }, 60_000)

  afterAll(async () => {
    for (const stop of stops) stop()
    await discord?.close()
  })

  it("runs each bot's requests on its owning host, through one rate limiter, from any central", async () => {
    // Discord's first answer teaches the limiter the guild route's bucket.
    for (const bot of bots)
      expect((await getGuild(centrals[0] ?? '', accessToken, bot.token)).status).toBe(200)

    const parallel = bots.flatMap((bot) =>
      [0, 1, 2, 3].map((n) => getGuild(centrals[n % 2] ?? '', accessToken, bot.token)),
    )
    const results = await Promise.all(
      (await Promise.all(parallel)).map(async (response) => ({
        status: response.status,
        body: await response.json(),
      })),
    )
    expect(results.every((result) => result.status === 200)).toBe(true)
    const succeeded = results.filter((result) => result.body.result?.isError !== true)
    expect(succeeded).toHaveLength(bots.length)

    expect(discord.tooManyRequests()).toBe(0)
    for (const bot of bots) {
      const restCalls = discord.calls.filter((call) => call.bot === bot.id)
      expect(new Set(restCalls.map((call) => call.caller))).toEqual(new Set([bot.host]))
      expect(restCalls.filter((call) => call.path.includes('/guilds/'))).toHaveLength(GUILD_LIMIT)
    }
    // Central checks logins with Discord but never acts as a bot.
    const centralCalls = discord.calls.filter((call) => call.caller.startsWith('central'))
    expect(centralCalls.length).toBeGreaterThan(0)
    expect(centralCalls.every((call) => call.path.includes('/oauth2/'))).toBe(true)
  }, 30_000)

  it('refuses requests that skip central or reach a host that does not own the bot', async () => {
    const [owned, other] = bots
    const direct = (host: string, authorization: string) =>
      fetch(`${host}/mcp`, {
        method: 'POST',
        headers: { authorization, 'x-discord-bot-token': owned?.token ?? '' },
      })
    expect((await direct(owned?.host ?? '', `Bearer ${accessToken}`)).status).toBe(401)
    const misrouted = await direct(other?.host ?? '', `Bearer ${SECRET}`)
    expect(misrouted.status).toBe(503)
    expect(misrouted.headers.get('retry-after')).toBe('1')
  })
})
