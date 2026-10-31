import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createBotRuntimes, createTokenVault } from '@discord-mcp/bot-host'
import { fakeGateway, manualClock } from '@discord-mcp/bot-host/testing'
import { DiscordRest } from '@discord-mcp/discord-api'
import { inMemoryStorage } from '@discord-mcp/storage/testing'
import { Effect, Layer } from 'effect'
import { describe, expect, it, vi } from 'vitest'
import { createRelay } from '../src/relay.ts'
import { config, discordOAuth, login } from './login-fixture.ts'

const BOT_ID = '345678901234567890'
const TOKEN = 'private-bot-token'
const HOUR = 60 * 60 * 1000

const listTools = (accessToken: string) =>
  new Request('https://relay.test/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-method': 'tools/list',
      'mcp-protocol-version': '2026-07-28',
      authorization: `Bearer ${accessToken}`,
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

describe('bot hosting', () => {
  it('brings a bot online on first use and offline for good after 24 hours without a call', async () => {
    const storage = await inMemoryStorage()
    // Heartbeats are proven in the shard suite; keep them out of this 47-hour window.
    const gateway = await fakeGateway(100 * HOUR)
    const clock = manualClock()
    const log = vi.fn()
    const vault = createTokenVault(Buffer.alloc(32, 1), storage)
    const bots = createBotRuntimes({ vault, clock, log, gatewayUrl: gateway.url })
    const relay = createRelay(
      config,
      () =>
        Layer.succeed(DiscordRest)({
          raw: undefined as never,
          request: () => Effect.succeed({ id: BOT_ID, bot: true }),
        }),
      discordOAuth().fetch,
      bots,
    )
    const { tokens } = await login(relay)

    expect((await relay.fetch(listTools(tokens.access_token))).status).toBe(200)
    await vi.waitFor(async () => expect(await storage.loadSealedToken(BOT_ID)).toBeDefined())
    expect(await storage.loadSealedToken(BOT_ID)).not.toContain(TOKEN)
    expect(await vault.load(BOT_ID)).toBe(TOKEN)
    await vi.waitFor(() =>
      expect(gateway.connections[0]?.received[0]).toMatchObject({
        op: 2,
        d: { token: TOKEN, presence: { status: 'online' } },
      }),
    )

    await Promise.all([
      relay.fetch(listTools(tokens.access_token)),
      relay.fetch(listTools(tokens.access_token)),
    ])
    clock.advance(23 * HOUR)
    await relay.fetch(listTools(tokens.access_token))
    // 46 hours after first use, but only 23 after the last call.
    clock.advance(23 * HOUR)
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('went offline'))

    clock.advance(HOUR)
    await vi.waitFor(() => expect(gateway.connections[0]?.closeCode).toBe(1000))
    // Its session ended, so a restart leaves it offline.
    await vi.waitFor(async () => expect(await vault.loadSessions()).toEqual([]))
    expect(gateway.connections).toHaveLength(1)
    await gateway.close()
    await storage.close()
  })
})

const BIN = fileURLToPath(new URL('../src/bin.ts', import.meta.url))
const TSX = fileURLToPath(new URL('../../../node_modules/.bin/tsx', import.meta.url))
const UNREACHABLE_DATABASE = 'postgres://discord-mcp@127.0.0.1:1/unreachable'

/** Start the real HTTP server and resolve with its stderr once it listens or exits. */
const startServer = (env: Record<string, string>) =>
  new Promise<{ stderr: string; port: number | undefined; stop: () => void }>((resolve) => {
    const { DISCORD_OAUTH_ALLOWED_USER_IDS: _, ...inherited } = process.env
    const child = spawn(TSX, [BIN], {
      env: {
        ...inherited,
        MCP_TRANSPORT: 'http',
        MCP_HTTP_PORT: '0',
        DISCORD_OAUTH_CLIENT_ID: '123456789012345678',
        DISCORD_OAUTH_CLIENT_SECRET: 'test-client-secret',
        OAUTH_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
        DATABASE_URL: UNREACHABLE_DATABASE,
        TOKEN_VAULT_KEY: Buffer.alloc(32, 1).toString('base64'),
        ...env,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    const stop = () => child.kill('SIGTERM')
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
      const port = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(stderr)?.[1]
      if (port !== undefined) resolve({ stderr, port: Number(port), stop })
    })
    child.on('close', () => resolve({ stderr, port: undefined, stop }))
  })

describe('the allowlist gate', () => {
  it('serves the plain relay without starting bot hosting when no allowlist is set', async () => {
    const server = await startServer({})
    try {
      expect(server.stderr).toContain('Bot hosting is off')
      const health = await fetch(`http://127.0.0.1:${server.port}/health/live`)
      expect(health.status).toBe(200)
    } finally {
      server.stop()
    }
  }, 20_000)

  it('starts bot hosting, and so needs the database, once the allowlist names users', async () => {
    const server = await startServer({ DISCORD_OAUTH_ALLOWED_USER_IDS: '234567890123456789' })
    server.stop()
    expect(server.port).toBeUndefined()
    expect(server.stderr).toContain('DATABASE_URL')
  }, 20_000)
})
