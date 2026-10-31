#!/usr/bin/env node
import { randomBytes } from 'node:crypto'
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'

// A private, per-user stdio connection to the hosted relay. No credentials in agent configs.
const directory = process.env.DISCORD_MCP_CONFIG_DIR ?? join(homedir(), '.config', 'discord-mcp')
const loginFile = join(directory, 'login.json')
const REFRESH_EARLY_SECONDS = 24 * 3600
// A refresh request times out after 15 seconds, so an older lock belongs to a crashed bridge.
const LOCK_STALE_MS = 30_000
const controllers = new Map()
let protocol = '2025-06-18'

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)
const failure = (id, message) => send({ jsonrpc: '2.0', id, error: { code: -32000, message } })
const now = () => Math.floor(Date.now() / 1000)
const readLogin = async () => JSON.parse(await readFile(loginFile, 'utf8'))
const credentials = async () => {
  try {
    const login = await readLogin()
    const bot = /^DISCORD_BOT_TOKEN=(\S+)$/m.exec(
      await readFile(join(directory, 'bot.env'), 'utf8'),
    )?.[1]
    const resource = new URL(login.resource)
    if (
      !bot ||
      typeof login.access_token !== 'string' ||
      resource.username ||
      resource.password ||
      (resource.protocol !== 'https:' &&
        !(resource.protocol === 'http:' && resource.hostname === '127.0.0.1'))
    ) {
      throw new Error('Invalid credentials')
    }
    return { login, bot }
  } catch {
    throw new Error('Discord MCP needs setup. Follow the agent setup instructions in README.md.')
  }
}

/** Run `task` while holding a lock file shared by every bridge using this login. */
const locked = async (task) => {
  const lock = `${loginFile}.lock`
  for (;;) {
    try {
      await writeFile(lock, String(process.pid), { flag: 'wx', mode: 0o600 })
      break
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const age = await stat(lock).then(
        (lockStat) => Date.now() - lockStat.mtimeMs,
        () => 0,
      )
      if (age > LOCK_STALE_MS) await rm(lock, { force: true })
      else await delay(50)
    }
  }
  try {
    return await task()
  } finally {
    await rm(lock, { force: true })
  }
}

/**
 * Replace `stale` with a rotated login. A refresh revokes the previous tokens, so bridges
 * take turns: whoever finds login.json already rotated uses that result instead.
 */
const refresh = (stale) =>
  locked(async () => {
    const current = await readLogin()
    if (current.refresh_token !== stale.refresh_token) return current
    const response = await fetch(new URL('/token', current.resource), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: current.refresh_token,
        client_id: current.client_id,
        resource: current.resource,
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) {
      const error = await response.json().catch(() => undefined)
      if (error?.error !== 'invalid_grant')
        throw new Error(`Discord login refresh failed (HTTP ${response.status}).`)
      // A sign-in with --replace does not take the lock and may have rotated the file meanwhile.
      const latest = await readLogin()
      if (latest.refresh_token !== current.refresh_token) return latest
      throw new Error('Discord login expired. Run the login helper again.')
    }
    const tokens = await response.json()
    if (
      typeof tokens.access_token !== 'string' ||
      typeof tokens.refresh_token !== 'string' ||
      !Number.isInteger(tokens.expires_in)
    )
      throw new Error('Discord login refresh failed (invalid response).')
    // Copy only token fields, so a response cannot redirect `resource` or swap `client_id`.
    const next = {
      ...current,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: now() + tokens.expires_in,
    }
    const temporary = `${loginFile}.${randomBytes(16).toString('hex')}.tmp`
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
    await rename(temporary, loginFile)
    return next
  })

const forward = async (message) => {
  if (message.method === 'notifications/cancelled') {
    controllers.get(message.params?.requestId)?.abort()
    return
  }
  const controller = new AbortController()
  if (message.id !== undefined) controllers.set(message.id, controller)
  try {
    // Re-read on every request so replacing credentials also updates running agents.
    const { login, bot } = await credentials()
    const post = (current) =>
      fetch(current.resource, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${current.access_token}`,
          'x-discord-bot-token': bot,
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
          'mcp-protocol-version': protocol,
        },
        body: JSON.stringify(message),
        redirect: 'error',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]),
      })
    let current = login
    if (current.refresh_token && current.expires_at - now() < REFRESH_EARLY_SECONDS)
      // The current grant still works until the relay rejects it, so an early failure can wait.
      current = await refresh(current).catch(() => current)
    let response = await post(current)
    if (
      response.status === 401 &&
      current.refresh_token &&
      response.headers.get('www-authenticate')?.includes('error="invalid_token"')
    )
      response = await post(await refresh(current))
    if (response.status === 401)
      throw new Error('Discord login expired. Run the login helper again.')
    if (response.status === 403) {
      const error = await response.json().catch(() => undefined)
      if (error?.error === 'access_denied')
        throw new Error(
          'Discord account is not on the relay allowlist. Ask the operator for access.',
        )
      throw new Error('Discord rejected the bot token or its permissions.')
    }
    if (!response.ok) throw new Error(`Discord MCP request failed (HTTP ${response.status}).`)
    const body = await response.text()
    if (!body.trim()) return
    // The hosted relay completes bounded SSE responses before returning them to this client.
    const messages = response.headers.get('content-type')?.includes('text/event-stream')
      ? body
          .split(/\r?\n\r?\n/)
          .map((event) =>
            event
              .split(/\r?\n/)
              .filter((line) => line.startsWith('data:'))
              .map((line) => line.slice(5).replace(/^ /, ''))
              .join('\n'),
          )
          .filter(Boolean)
          .map((data) => JSON.parse(data))
      : [JSON.parse(body)]
    for (const result of messages) {
      if (message.method === 'initialize' && typeof result.result?.protocolVersion === 'string') {
        protocol = result.result.protocolVersion
      }
      send(result)
    }
  } catch (error) {
    if (message.id !== undefined) {
      const reason =
        error instanceof Error && /^(Discord|Invalid credentials)/.test(error.message)
          ? error.message
          : 'Discord MCP transport failed. Check the connection and sign in again if needed.'
      failure(message.id, reason)
    }
  } finally {
    if (message.id !== undefined) controllers.delete(message.id)
  }
}

const pending = new Set()
for await (const line of createInterface({
  input: process.stdin,
  crlfDelay: Number.POSITIVE_INFINITY,
})) {
  if (!line.trim()) continue
  try {
    const message = JSON.parse(line)
    if (message === null || typeof message !== 'object' || Array.isArray(message)) {
      throw new Error('Invalid message')
    }
    const request = forward(message).finally(() => pending.delete(request))
    pending.add(request)
  } catch {
    send({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Invalid JSON-RPC message.' },
    })
  }
}
await Promise.all(pending)
