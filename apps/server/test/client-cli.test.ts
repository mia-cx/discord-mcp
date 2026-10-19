import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { expect, it } from 'vitest'

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

it('reports an expired login to the agent without leaking credentials or the server error body', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'discord-mcp-client-'))
  const server = createServer((_request, response) =>
    response.writeHead(401).end('private-error-body'),
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
      error: { message: 'Discord login expired. Run the login helper again.' },
    })
    expect(output).not.toContain('private-')
  } finally {
    child.kill()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  }
})
