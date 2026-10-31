import { ConfigurationError } from '@discord-mcp/core'
import { ConfigProvider, Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { loadServerConfig } from '../src/config.ts'

const load = (env: Record<string, string>) =>
  loadServerConfig.pipe(
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
    Effect.flip,
    Effect.runPromise,
  )

describe('loadServerConfig', () => {
  it('refuses to enable workflows while no execution backend exists', async () => {
    const error = await load({ DISCORD_TOKEN: 'test-token', DISCORD_MCP_WORKFLOWS_ENABLED: 'true' })

    expect(error).toBeInstanceOf(ConfigurationError)
    expect(error).toMatchObject({ variable: 'DISCORD_MCP_WORKFLOWS_ENABLED' })
  })
})
