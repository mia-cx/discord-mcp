import type { AnyToolDef } from '@discord-mcp/core'
import { DiscordRest, RateGuard } from '@discord-mcp/discord-api'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { createMcpHandler } from '@modelcontextprotocol/server'
import { type Effect, Layer, ManagedRuntime, Redacted } from 'effect'
import { stdioAuthorize } from '../../src/app.ts'
import type { ServerConfig } from '../../src/config.ts'
import { buildMcpServer } from '../../src/mcp-server.ts'

export const testConfig: ServerConfig = {
  transport: 'stdio',
  databasePath: ':memory:',
  // `off` so the tool suite never opens a socket; gateway-gated tools stay unregistered, which is
  // exactly what a deployment with the Gateway disabled sees.
  gateway: { mode: 'off', intents: [], bufferSize: 10, maxWaitMs: 1000 },
  masterKey: Buffer.alloc(32),
  discordOAuth: undefined,
  oidc: undefined,
  http: {
    host: '127.0.0.1',
    port: 3000,
    publicBaseUrl: undefined,
    allowedHosts: [],
    trustProxyIdentity: false,
    trustedProxyCidrs: [],
  },
  toolsets: new Set(['operator', 'automation', 'api']),
  rest: {
    token: Redacted.make('test-token'),
    timeoutMs: 1000,
    retries: 0,
    maxRateLimitWaitMs: 1000,
  },
}

export interface StubbedRequest {
  readonly method: string
  readonly route: string
}

/**
 * A `DiscordRest` that never touches the network.
 *
 * Layer-swapping the real service is what makes the entire tool surface testable offline: handlers,
 * schemas, and the result path are exercised unchanged.
 */
export const stubRest = (
  respond: (req: StubbedRequest) => Effect.Effect<unknown, never>,
  recorded?: Array<StubbedRequest>,
) =>
  Layer.succeed(DiscordRest)({
    request: (req) => {
      const seen = { method: req.method, route: String(req.route) }
      recorded?.push(seen)
      return respond(seen)
    },
    // The Gateway seam. No test in this suite reaches for it.
    raw: undefined as never,
  })

/**
 * Drive a real MCP `Client` against a real `createMcpHandler` — no port, no socket, no mock
 * transport. `handler.fetch` takes a `Request`, while the client's `FetchLike` is `(url, init)`,
 * so the adapter below is required.
 */
export const withClient = async <A>(
  layer: Layer.Layer<DiscordRest>,
  tools: ReadonlyArray<AnyToolDef>,
  use: (client: Client) => Promise<A>,
): Promise<A> => {
  const runtime = ManagedRuntime.make(Layer.provide(layer, RateGuard.layer()))
  const server = buildMcpServer({ config: testConfig, runtime, authorize: stdioAuthorize, tools })
  const handler = createMcpHandler(() => server, { onerror: () => {} })

  const client = new Client({ name: 'test', version: '0.0.0' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL('http://mcp.test/mcp'), {
      fetch: ((url: string | URL, init?: RequestInit) =>
        handler.fetch(new Request(url, init))) as typeof fetch,
    }),
  )

  try {
    return await use(client)
  } finally {
    await client.close()
    await handler.close()
    await runtime.dispose()
  }
}

export const guildFixture = {
  id: '123456789012345678',
  name: 'Test Guild',
  description: null,
  owner_id: '987654321098765432',
  icon: null,
  features: ['COMMUNITY'],
  premium_tier: 2,
}
