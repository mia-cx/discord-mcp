#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { parseArgs } from 'node:util'

// Dependency-free OAuth client. Bot tokens never enter the login flow or its output file.
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    output: { type: 'string' },
    replace: { type: 'boolean' },
    'no-open': { type: 'boolean' },
    help: { type: 'boolean' },
  },
})
const usage =
  'Usage: node scripts/login.mjs https://HOST/mcp [--output PATH] [--replace] [--no-open]\n'
if (values.help) {
  process.stdout.write(usage)
  process.exit(0)
}
if (positionals.length !== 1) {
  process.stderr.write(`Ask your relay operator for its MCP URL.\n${usage}`)
  process.exit(1)
}
const endpoint = new URL(positionals[0])
if (
  endpoint.protocol !== 'https:' &&
  !(
    endpoint.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)
  )
) {
  throw new Error('Use HTTPS for a remote relay.')
}
const issuer = endpoint.origin
const resource = `${issuer}/mcp`
const output = values.output ?? join(homedir(), '.config', 'discord-mcp', 'login.json')
const random = () => randomBytes(32).toString('base64url')
const post = async (path, body, type = 'application/x-www-form-urlencoded') => {
  const response = await fetch(`${issuer}${path}`, {
    method: 'POST',
    headers: { 'content-type': type },
    body,
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok)
    throw new Error(`OAuth request ${path} failed (${response.status}). Start login again.`)
  return response.json()
}
const store = async (credentials, replace = false) => {
  await mkdir(dirname(output), { recursive: true, mode: 0o700 })
  const target = replace ? `${output}.${random()}.tmp` : output
  await writeFile(target, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  if (replace) await rename(target, output)
  process.stderr.write(`Login saved to ${output} (owner-only permissions).\n`)
}

{
  // Do not consume a login only to discover an existing file at the end.
  if (!values.replace)
    try {
      await readFile(output)
      throw new Error(
        `Login file exists. Use --replace, or choose another --output path: ${output}`,
      )
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  const verifier = random()
  const state = random()
  let receive
  let fail
  const received = new Promise((resolve, reject) => {
    receive = resolve
    fail = reject
  })
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    response.setHeader('cache-control', 'no-store')
    response.setHeader('content-type', 'text/plain; charset=utf-8')
    response.setHeader('referrer-policy', 'no-referrer')
    if (
      request.method !== 'GET' ||
      url.pathname !== '/callback' ||
      url.searchParams.get('state') !== state ||
      url.searchParams.get('iss') !== issuer
    ) {
      response.writeHead(400).end('Invalid login callback. Return to the original login tab.')
      return
    }
    if (url.searchParams.has('error')) {
      response.writeHead(400).end('Login cancelled. Run the login command to try again.')
      fail(new Error('Discord login cancelled.'))
      return
    }
    const code = url.searchParams.get('code')
    if (!code) {
      response.writeHead(400).end('Missing authorization code.')
      return
    }
    response.end('Discord login received. Return to your terminal.')
    receive(code)
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  let timeout
  // Attach the rejection handler before network I/O, including an early cancellation.
  const codePromise = Promise.race([
    received,
    new Promise((_, reject) => {
      timeout = setTimeout(
        () => reject(new Error('Login timed out. Run the command again.')),
        300_000,
      )
    }),
  ])
  codePromise.catch(() => {}) // Awaited below; an early callback must not become an unhandled rejection.
  try {
    const redirect = `http://127.0.0.1:${server.address().port}/callback`
    const client = await post(
      '/register',
      JSON.stringify({
        client_name: 'discord-mcp login helper',
        redirect_uris: [redirect],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      }),
      'application/json',
    )
    const authorization = new URL('/authorize', issuer)
    authorization.search = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: redirect,
      response_type: 'code',
      code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      scope: 'mcp',
      resource,
      state,
    }).toString()
    process.stderr.write(`Open this URL and continue with Discord:\n${authorization}\n`)
    if (!values['no-open']) {
      const opener = process.platform === 'darwin' ? 'open' : 'xdg-open'
      const child = spawn(opener, [authorization.href], { stdio: 'ignore' })
      child.on('error', () => process.stderr.write('Open the printed URL in your browser.\n'))
    }
    const tokens = await post(
      '/token',
      new URLSearchParams({
        grant_type: 'authorization_code',
        code: await codePromise,
        code_verifier: verifier,
        client_id: client.client_id,
        redirect_uri: redirect,
        resource,
      }),
    )
    // The bridge refreshes from `expires_at` and rewrites this file in the same shape.
    await store(
      {
        resource,
        client_id: client.client_id,
        ...tokens,
        expires_at: Math.floor(Date.now() / 1000) + tokens.expires_in,
      },
      values.replace,
    )
  } finally {
    clearTimeout(timeout)
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
}
