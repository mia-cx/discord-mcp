import { randomUUID } from 'node:crypto'
import { createConnection } from 'node:net'
import { SandboxError } from '@discord-mcp/core'
import { Context, Effect, Layer } from 'effect'
import type { SupervisorCommand, SupervisorResponse } from './protocol.ts'

/**
 * The control plane's end of the supervisor socket.
 *
 * This is what the MCP server holds instead of the Docker socket. Everything it can express is a
 * revision reference and a command name; there is no way to ask for a container by name, and so no
 * way for a compromised tool handler to reach one.
 */

export class SupervisorClient extends Context.Service<
  SupervisorClient,
  {
    readonly send: (command: SupervisorCommand) => Effect.Effect<unknown, SandboxError>
  }
>()('sandbox-supervisor/SupervisorClient') {
  static readonly layer = (options: {
    readonly socketPath: string
    readonly serviceCredential: string
    readonly timeoutMs: number
  }): Layer.Layer<SupervisorClient> =>
    Layer.sync(SupervisorClient)(() => ({
      send: (command) =>
        Effect.callback<unknown, SandboxError>((resume) => {
          const id = randomUUID()
          const socket = createConnection(options.socketPath)
          let buffer = ''
          let settled = false

          const settle = (effect: Effect.Effect<unknown, SandboxError>) => {
            if (settled) return
            settled = true
            socket.destroy()
            resume(effect)
          }

          socket.setEncoding('utf8')
          socket.setTimeout(options.timeoutMs, () =>
            settle(
              Effect.fail(
                new SandboxError({
                  message: `The supervisor did not respond within ${options.timeoutMs}ms.`,
                  phase: 'protocol',
                }),
              ),
            ),
          )

          socket.on('error', (cause) =>
            settle(
              Effect.fail(
                new SandboxError({
                  message: `Could not reach the sandbox supervisor at ${options.socketPath}: ${cause.message}`,
                  phase: 'protocol',
                }),
              ),
            ),
          )

          socket.on('connect', () => {
            socket.write(
              `${JSON.stringify({ id, credential: options.serviceCredential, command })}\n`,
            )
          })

          socket.on('data', (chunk: string) => {
            buffer += chunk
            const newline = buffer.indexOf('\n')
            if (newline === -1) return

            const response = JSON.parse(buffer.slice(0, newline)) as SupervisorResponse
            settle(
              response.ok
                ? Effect.succeed(response.result)
                : Effect.fail(
                    new SandboxError({
                      message: response.error.message,
                      // The wire carries a string; the supervisor is the only writer and only ever
                      // sends one of the five phases.
                      phase: response.error.phase as SandboxError['phase'],
                      ...(response.error.diagnostics === undefined
                        ? {}
                        : { diagnostics: response.error.diagnostics }),
                    }),
                  ),
            )
          })

          return Effect.sync(() => {
            socket.destroy()
          })
        }),
    }))
}
