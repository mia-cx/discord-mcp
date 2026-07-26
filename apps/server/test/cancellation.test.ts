import { defineTool, requestSignal, Snowflake } from '@discord-mcp/core'
import { DiscordRest, RateGuard } from '@discord-mcp/discord-api'
import { Effect, Layer, ManagedRuntime, Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import { stdioAuthorize } from '../src/app.ts'
import { buildMcpServer } from '../src/mcp-server.ts'
import { testConfig } from './support/harness.ts'

/**
 * The plan's phase-1 acceptance criterion: client cancellation must interrupt **both** the Effect
 * fiber and the in-flight Discord request. Abandoning the HTTP request instead of aborting it
 * leaves Discord doing work nobody will read, and on a write it leaves the outcome unknown.
 *
 * This drives the boundary directly rather than through a client, because the point under test is
 * what the runtime does with the signal, not how the transport delivers it.
 */
describe('client cancellation', () => {
  it('interrupts the fiber and runs finalizers', async () => {
    const runtime = ManagedRuntime.make(Layer.empty)
    const controller = new AbortController()
    let interrupted = false

    const program = Effect.never.pipe(
      Effect.onInterrupt(() =>
        Effect.sync(() => {
          interrupted = true
        }),
      ),
    )

    setTimeout(() => controller.abort(), 20)
    const exit = await runtime.runPromiseExit(program, { signal: controller.signal })

    expect(exit._tag).toBe('Failure')
    expect(interrupted).toBe(true)
    await runtime.dispose()
  })

  it('hands the caller signal to the Discord request rather than abandoning it', async () => {
    // The signal DiscordRest observed, captured from inside a handler.
    let observed: AbortSignal | undefined
    let aborted: boolean | undefined

    const probe = defineTool<{ guildId: string }, { seen: boolean }, never>({
      name: 'probe',
      title: 'probe',
      description: 'Captures the request signal the way DiscordRest does.',
      toolset: 'operator',
      risk: 'read',
      scopes: ['mcp:read'],
      annotations: { readOnlyHint: true },
      input: Schema.Struct({ guildId: Snowflake }),
      handler: () =>
        Effect.gen(function* () {
          // Exactly the read DiscordRest performs before issuing an HTTP request.
          observed = yield* requestSignal
          aborted = observed?.aborted
          return { seen: observed !== undefined }
        }),
    })

    const runtime = ManagedRuntime.make(
      Layer.provide(
        Layer.succeed(DiscordRest)({ request: () => Effect.succeed({}), raw: undefined as never }),
        RateGuard.layer(),
      ),
    )
    const server = buildMcpServer({
      config: testConfig,
      runtime,
      authorize: stdioAuthorize,
      tools: [probe],
    })

    const { createMcpHandler } = await import('@modelcontextprotocol/server')
    const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client')
    const handler = createMcpHandler(() => server, { onerror: () => {} })
    const client = new Client({ name: 'test', version: '0.0.0' })
    await client.connect(
      new StreamableHTTPClientTransport(new URL('http://mcp.test/mcp'), {
        fetch: ((url: string | URL, init?: RequestInit) =>
          handler.fetch(new Request(url, init))) as typeof fetch,
      }),
    )

    await client.callTool({ name: 'probe', arguments: { guildId: '123456789012345678' } })

    // A signal must reach the handler; without it @discordjs/rest cannot abort anything.
    expect(observed).toBeInstanceOf(AbortSignal)
    expect(aborted).toBe(false)

    await client.close()
    await handler.close()
    await runtime.dispose()
  })

  it('reads the signal optionally, so REST works outside a tool call', async () => {
    // Startup probes, workflow handlers, and tests have no MCP request in context.
    const runtime = ManagedRuntime.make(Layer.empty)
    const signal = await runtime.runPromise(requestSignal)
    expect(signal).toBeUndefined()
    await runtime.dispose()
  })
})
