import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { toNodeHandler } from '@modelcontextprotocol/node'
import { expect, it } from 'vitest'
import { createRelay } from '../src/relay.ts'
import { config, discordOAuth } from './login-fixture.ts'

it('requires an operator-supplied relay URL before starting login', () => {
  const child = spawnSync(process.execPath, ['scripts/login.mjs', '--no-open'], {
    encoding: 'utf8',
    timeout: 1000,
  })
  expect(child.status).toBe(1)
  expect(child.stdout).toBe('')
  expect(child.stderr).toContain('Ask your relay operator for its MCP URL.')
  expect(child.stderr).toContain('Usage: node scripts/login.mjs https://HOST/mcp')
})

it('logs in through the CLI loopback callback and writes an owner-only credential file without bot secrets', async () => {
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
  if (address === null || typeof address === 'string') throw new Error('Missing test port')
  const issuer = `http://127.0.0.1:${address.port}`
  const relay = createRelay(
    { ...config, allowedHosts: ['127.0.0.1'], login: { ...config.login, publicBaseUrl: issuer } },
    undefined,
    oauth.fetch,
  )
  handle = toNodeHandler(relay)
  const directory = await mkdtemp(join(tmpdir(), 'discord-mcp-login-'))
  const output = join(directory, 'login.json')
  const child = spawn(
    process.execPath,
    ['scripts/login.mjs', `${issuer}/mcp`, '--no-open', '--output', output],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => {
    stdout += String(chunk)
  })
  const exited = new Promise<number | null>((resolve) => child.once('exit', resolve))
  try {
    const authorization = await new Promise<string>((resolve) => {
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk)
        const url = /http:\/\/127\.0\.0\.1:\d+\/authorize\?[^\s]+/.exec(stderr)?.[0]
        if (url !== undefined) resolve(url)
      })
    })
    const consent = await fetch(authorization)
    const cookie = consent.headers.get('set-cookie')?.split(';')[0] ?? ''
    const flow = /name="flow" value="([^"]+)"/.exec(await consent.text())?.[1] ?? ''
    const approved = await fetch(`${issuer}/authorize`, {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie, origin: issuer },
      body: new URLSearchParams({ flow, decision: 'allow' }),
    })
    const discord = new URL(approved.headers.get('location') ?? '')
    const callback = new URL(`${issuer}/auth/discord/callback`)
    callback.search = new URLSearchParams({
      state: discord.searchParams.get('state') ?? '',
      code: 'discord-code',
      iss: 'https://discord.com',
    }).toString()
    const completed = await fetch(callback, { headers: { cookie }, redirect: 'manual' })
    const received = await fetch(completed.headers.get('location') ?? '')
    expect(received.status).toBe(200)
    expect(await exited).toBe(0)
    expect(stdout).toBe('')
    const credentials = JSON.parse(await readFile(output, 'utf8'))
    expect(credentials.resource).toBe(`${issuer}/mcp`)
    expect(credentials.access_token).toEqual(expect.any(String))
    expect(credentials.refresh_token).toBeUndefined()
    expect(JSON.stringify(credentials)).not.toContain('private-')
    expect((await stat(output)).mode & 0o777).toBe(0o600)
  } finally {
    child.kill()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  }
})
