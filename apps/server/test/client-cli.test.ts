import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { DiscordRest } from '@discord-mcp/discord-api/relay'
import { toNodeHandler } from '@modelcontextprotocol/node'
import { Effect, Layer } from 'effect'
import { expect, it } from 'vitest'
import { createRelay } from '../src/relay.ts'
import { BOT_ID, botToken, config, discordOAuth, executor, login } from './login-fixture.ts'

it('relays stdio requests with private credentials, legacy SSE, and credential replacement', async () => {
  const received: Array<{ authorization: string | undefined; bot: string | string[] | undefined }> =
    []
  const server = createServer((request, response) => {
    received.push({
      authorization: request.headers.authorization,
      bot: request.headers['x-discord-bot-token'],
    })
    let body = ''
    request.on('data', (chunk) => {
      body += String(chunk)
    })
    request.on('end', () => {
      const message = JSON.parse(body)
      const result =
        message.method === 'initialize'
          ? {
              protocolVersion: '2025-06-18',
              serverInfo: { name: 'fixture', version: '1' },
              capabilities: { tools: {} },
            }
          : { tools: [{ name: 'discord_api_search', inputSchema: { type: 'object' } }] }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(
        `event: message\r\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\r\n\r\n`,
      )
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Missing port')
  const directory = await mkdtemp(join(tmpdir(), 'discord-mcp-client-'))
  await writeFile(
    join(directory, 'login.json'),
    JSON.stringify({
      resource: `http://127.0.0.1:${address.port}/mcp`,
      access_token: 'private-oauth',
    }),
    { mode: 0o600 },
  )
  await writeFile(join(directory, 'bot.env'), 'DISCORD_BOT_TOKEN=private-bot\n', { mode: 0o600 })
  const child = spawn(process.execPath, ['scripts/client.mjs'], {
    env: { ...process.env, DISCORD_MCP_CONFIG_DIR: directory },
  })
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
  try {
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })}\n`,
    )
    expect(JSON.parse((await lines.next()).value ?? '').result.protocolVersion).toBe('2025-06-18')
    await writeFile(join(directory, 'bot.env'), 'DISCORD_BOT_TOKEN=replaced-bot\n', { mode: 0o600 })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`)
    const output = (await lines.next()).value ?? ''
    expect(JSON.parse(output).result.tools[0].name).toBe('discord_api_search')
    expect(output).not.toContain('private-')
    expect(received).toEqual([
      { authorization: 'Bearer private-oauth', bot: 'private-bot' },
      { authorization: 'Bearer private-oauth', bot: 'replaced-bot' },
    ])
  } finally {
    child.kill()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  }
})

it('serialises concurrent bridge refreshes into one valid login and refreshes on a rejected token', async () => {
  const oauth = discordOAuth()
  let handle: ReturnType<typeof toNodeHandler>
  const server = createServer((request, response) => {
    void handle(
      {
        method: request.method ?? 'GET',
        url: request.url ?? '/',
        headers: request.headers,
        [Symbol.asyncIterator]: () => request[Symbol.asyncIterator](),
      },
      response,
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Missing port')
  const issuer = `http://127.0.0.1:${address.port}`
  const relay = createRelay(
    { ...config, allowedHosts: ['127.0.0.1'], login: { ...config.login, publicBaseUrl: issuer } },
    executor(() =>
      Layer.succeed(DiscordRest)({
        raw: undefined as never,
        request: () => Effect.succeed({ id: BOT_ID, bot: true }),
      }),
    ),
    oauth.fetch,
  )
  handle = toNodeHandler(relay)
  const { tokens, clientId } = await login(relay, issuer)
  const directory = await mkdtemp(join(tmpdir(), 'discord-mcp-client-'))
  const loginFile = join(directory, 'login.json')
  const saveLogin = (login: object) => writeFile(loginFile, JSON.stringify(login), { mode: 0o600 })
  // Expiring within a day makes every bridge refresh before its first request.
  await saveLogin({
    resource: `${issuer}/mcp`,
    client_id: clientId,
    ...tokens,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  })
  await writeFile(join(directory, 'bot.env'), `DISCORD_BOT_TOKEN=${botToken()}\n`, { mode: 0o600 })
  const bridges = Array.from({ length: 3 }, () => {
    const child = spawn(process.execPath, ['scripts/client.mjs'], {
      env: { ...process.env, DISCORD_MCP_CONFIG_DIR: directory },
    })
    return { child, lines: createInterface({ input: child.stdout })[Symbol.asyncIterator]() }
  })
  const request = async ({ child, lines }: (typeof bridges)[number]) => {
    const params = {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    }
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params })}\n`,
    )
    return JSON.parse((await lines.next()).value ?? '')
  }
  const discordRefreshes = () =>
    oauth.calls.filter((call) => String(call.init?.body).includes('grant_type=refresh_token'))
      .length
  // Signing in already redeemed one refresh; count only the bridges' own.
  const atSignIn = discordRefreshes()
  const refreshes = () => discordRefreshes() - atSignIn
  try {
    // A parse-error reply shows each bridge is running, so the refreshes below overlap.
    for (const { child, lines } of bridges) {
      child.stdin.write('not json\n')
      await lines.next()
    }
    const results = await Promise.all(bridges.map(request))
    for (const result of results) expect(result.result.protocolVersion).toEqual(expect.any(String))
    expect(refreshes()).toBe(1)
    const rotated = JSON.parse(await readFile(loginFile, 'utf8'))
    expect(rotated.refresh_token).not.toBe(tokens.refresh_token)
    expect(rotated.expires_at).toBeGreaterThan(Date.now() / 1000 + 6 * 24 * 3600)
    expect((await stat(loginFile)).mode & 0o777).toBe(0o600)

    // A revoked access token with a live refresh token recovers on the relay's 401.
    await saveLogin({ ...rotated, access_token: tokens.access_token })
    expect((await request(bridges[0])).result.protocolVersion).toEqual(expect.any(String))
    expect(refreshes()).toBe(2)
  } finally {
    for (const { child } of bridges) child.kill()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  }
})

it.each([
  {
    status: 401,
    error: 'invalid_token',
    message: 'Discord login expired. Run the login helper again.',
  },
  {
    status: 403,
    error: 'access_denied',
    message: 'Discord account is not on the relay allowlist. Ask the operator for access.',
  },
  {
    status: 403,
    error: 'invalid_bot_token',
    message: 'Discord rejected the bot token or its permissions.',
  },
])('reports $error without leaking credentials or the server error body', async (failure) => {
  const directory = await mkdtemp(join(tmpdir(), 'discord-mcp-client-'))
  const server = createServer((_request, response) =>
    response
      .writeHead(failure.status, { 'content-type': 'application/json' })
      .end(JSON.stringify({ error: failure.error, detail: 'private-error-body' })),
  )
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Missing port')
  await writeFile(
    join(directory, 'login.json'),
    JSON.stringify({
      resource: `http://127.0.0.1:${address.port}/mcp`,
      access_token: 'private-oauth',
    }),
    { mode: 0o600 },
  )
  await writeFile(join(directory, 'bot.env'), 'DISCORD_BOT_TOKEN=private-bot\n', { mode: 0o600 })
  const child = spawn(process.execPath, ['scripts/client.mjs'], {
    env: { ...process.env, DISCORD_MCP_CONFIG_DIR: directory },
  })
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
  try {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' })}\n`)
    const output = (await lines.next()).value ?? ''
    expect(JSON.parse(output)).toMatchObject({
      id: 7,
      error: { message: failure.message },
    })
    expect(output).not.toContain('private-')
  } finally {
    child.kill()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  }
})
