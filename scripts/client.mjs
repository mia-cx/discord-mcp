#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

// A private, per-user stdio connection to the hosted relay. No credentials in agent configs.
const directory = process.env.DISCORD_MCP_CONFIG_DIR ?? join(homedir(), '.config', 'discord-mcp')
const controllers = new Map()
let protocol = '2025-06-18'

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)
const failure = (id, message) => send({ jsonrpc: '2.0', id, error: { code: -32000, message } })
const credentials = async () => {
  try {
    const login = JSON.parse(await readFile(join(directory, 'login.json'), 'utf8'))
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
    return {
      resource,
      headers: { Authorization: `Bearer ${login.access_token}`, 'X-Discord-Bot-Token': bot },
    }
  } catch {
    throw new Error('Discord MCP needs setup. Follow the agent setup instructions in README.md.')
  }
}

const forward = async (message) => {
  if (message.method === 'notifications/cancelled') {
    controllers.get(message.params?.requestId)?.abort()
    return
  }
  const controller = new AbortController()
  if (message.id !== undefined) controllers.set(message.id, controller)
  try {
    // Re-read on every request so replacing credentials also updates running agents.
    const { resource, headers } = await credentials()
    const response = await fetch(resource, {
      method: 'POST',
      headers: {
        ...headers,
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-protocol-version': protocol,
      },
      body: JSON.stringify(message),
      redirect: 'error',
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]),
    })
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
