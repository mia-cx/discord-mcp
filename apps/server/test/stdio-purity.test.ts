import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const BIN = fileURLToPath(new URL('../src/bin.ts', import.meta.url))
const TSX = fileURLToPath(new URL('../../../node_modules/.bin/tsx', import.meta.url))

interface Captured {
  readonly stdoutLines: ReadonlyArray<string>
  readonly stderr: string
  readonly exitCode: number | null
}

/**
 * Run the real binary as a subprocess, feed it JSON-RPC on stdin, and capture both streams.
 *
 * Nothing short of a subprocess proves this: an in-process test shares the parent's stdout and
 * would never notice a stray write.
 */
const runServer = (stdin: string, env: Record<string, string>): Promise<Captured> =>
  new Promise((resolve) => {
    const child = spawn(TSX, [BIN], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c: Buffer) => {
      stdout += c.toString()
    })
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString()
    })

    child.stdin.write(stdin)

    const finish = (exitCode: number | null) =>
      resolve({
        stdoutLines: stdout.split('\n').filter((l) => l.trim().length > 0),
        stderr,
        exitCode,
      })

    // 'close' rather than 'exit': stdio streams flush after the process exits, and a startup
    // failure's stderr arrives in that window.
    child.on('close', finish)
    // The server holds its scope open deliberately, so end the test on its own terms.
    setTimeout(() => {
      child.kill('SIGTERM')
      setTimeout(() => finish(null), 300)
    }, 6000)
  })

const initialize = `${JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'purity-test', version: '0.0.0' },
  },
})}\n`

const listTools = `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`

describe('stdio purity', () => {
  it('writes only JSON-RPC to stdout and every log to stderr', async () => {
    const { stdoutLines, stderr } = await runServer(initialize + listTools, {
      DISCORD_TOKEN: 'test-token-not-used-without-a-call',
      MCP_TRANSPORT: 'stdio',
    })

    expect(stdoutLines.length).toBeGreaterThan(0)

    // The load-bearing assertion: one console.log anywhere in the process corrupts the stream
    // for every subsequent message, and the failure is opaque from the client's side.
    for (const line of stdoutLines) {
      expect(() => JSON.parse(line) as unknown).not.toThrow()
      expect((JSON.parse(line) as { jsonrpc?: string }).jsonrpc).toBe('2.0')
    }

    // The readiness log must exist, and must be on the other stream.
    expect(stderr).toContain('discord-mcp ready on stdio')
    expect(stdoutLines.join('\n')).not.toContain('discord-mcp ready')
  }, 20_000)

  it('advertises the tracer-bullet tool over the real stdio transport', async () => {
    const { stdoutLines } = await runServer(initialize + listTools, {
      DISCORD_TOKEN: 'test-token-not-used-without-a-call',
      MCP_TRANSPORT: 'stdio',
    })

    const responses = stdoutLines.map((l) => JSON.parse(l) as { id?: number; result?: unknown })
    const toolsList = responses.find((r) => r.id === 2)?.result as
      | { tools?: Array<{ name: string }> }
      | undefined

    expect(toolsList?.tools?.map((t) => t.name)).toContain('discord_guild_get')
  }, 20_000)

  it('fails at startup naming the offending variable', async () => {
    const { stderr, exitCode, stdoutLines } = await runServer('', {
      DISCORD_TOKEN: 'present-so-the-transport-is-what-fails',
      MCP_TRANSPORT: 'nonsense',
    })

    expect(stderr).toContain('MCP_TRANSPORT')
    expect(exitCode).not.toBe(0)
    // runMain's built-in reporter runs outside the program's own layers, so it would write the
    // failure to stdout. On stdio that corrupts the JSON-RPC stream; bin.ts reports the cause
    // inside the logging layer instead. This assertion is what keeps that fix in place.
    expect(stdoutLines).toEqual([])
  }, 20_000)
})
