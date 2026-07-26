import { mkdtemp, rm, stat } from 'node:fs/promises'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AuthProfiles,
  DiscordRest,
  OperationCatalog,
  PreviewTokens,
} from '@discord-mcp/discord-api'
import { PersistenceLayer } from '@discord-mcp/persistence'
import { DEFAULT_GRANT, type WorkflowGrant } from '@discord-mcp/workflow-sdk'
import { Effect, Layer, ManagedRuntime } from 'effect'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CapabilityBroker } from '../src/broker.ts'
import { CapabilityServer } from '../src/capability-server.ts'
import { CapabilitySockets } from '../src/capability-socket.ts'

/**
 * The socket a workflow container actually connects to.
 *
 * The tests above this one check the broker's decisions; these check that the decisions survive the
 * wire — a socket that answered before checking, or leaked one execution's channel to another,
 * would pass every unit test and fail in the only way that matters.
 */

const GUILD = '111111111111111111'
const CHANNEL = '222222222222222222'

let directory: string
let runtime: ManagedRuntime.ManagedRuntime<
  CapabilitySockets | CapabilityBroker | CapabilityServer,
  never
>

const stubRest = Layer.succeed(DiscordRest)({
  request: () => Effect.succeed({ id: '999' }),
  raw: undefined as never,
})

const stubProfiles = Layer.succeed(AuthProfiles)({
  resolve: (name: string) => Effect.succeed({ name, kind: 'bot' as const }),
})

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'capability-socket-'))
  runtime = ManagedRuntime.make(
    Layer.mergeAll(
      CapabilitySockets.layer({ directory }),
      CapabilityServer.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            CapabilityBroker.layer,
            OperationCatalog.layer,
            PreviewTokens.layer,
            stubRest,
            stubProfiles,
            Layer.orDie(PersistenceLayer(':memory:')),
          ),
        ),
      ),
      CapabilityBroker.layer,
    ),
  )
})

afterAll(async () => {
  await runtime.dispose()
  await rm(directory, { recursive: true, force: true })
})

const grantFor = (overrides: Partial<WorkflowGrant['discord']> = {}): WorkflowGrant => ({
  ...DEFAULT_GRANT,
  discord: { ...DEFAULT_GRANT.discord, guildIds: [GUILD], channelIds: [CHANNEL], ...overrides },
})

const open = (executionId: string, grant: WorkflowGrant) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const broker = yield* CapabilityBroker
      const credential = yield* broker.issue({
        workflowId: 'wf',
        revision: 1,
        executionId,
        grant,
        causalDepth: 0,
        now: Date.now(),
      })

      const sockets = yield* CapabilitySockets
      const socket = yield* sockets.open(credential)
      return { credential, socket }
    }),
  )

/** Speak the protocol the way the runner does, over a real connection. */
const speak = (
  socketPath: string,
  credential: string,
  call: Record<string, unknown>,
): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    const socket = connect(socketPath)
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('error', reject)
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ id: 'x1', credential, call })}\n`)
    })
    socket.on('data', (chunk: string) => {
      buffer += chunk
      const newline = buffer.indexOf('\n')
      if (newline === -1) return
      socket.destroy()
      resolve(JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>)
    })
  })

describe('the capability socket', () => {
  it('performs a granted call and refuses an ungranted one over the same channel', async () => {
    const { credential, socket } = await open(
      'exec-granted',
      grantFor({ operationIds: ['create_message'] }),
    )

    const allowed = await speak(socket.containerPath, credential.token, {
      kind: 'discord',
      operationId: 'create_message',
      path: { channel_id: CHANNEL },
      body: { content: 'hi' },
    })
    expect(allowed).toMatchObject({ ok: true })

    const refused = await speak(socket.containerPath, credential.token, {
      kind: 'discord',
      operationId: 'delete_guild',
      path: { guild_id: GUILD },
    })
    expect(refused).toMatchObject({ ok: false, denied: true })

    await runtime.runPromise(socket.close())
  })

  it('refuses a caller presenting the wrong credential, even on the right socket', async () => {
    const { socket } = await open(
      'exec-wrong-token',
      grantFor({ operationIds: ['create_message'] }),
    )

    // Finding the socket is not the same as being authorized on it: the credential is checked per
    // call rather than inferred from the connection.
    const response = await speak(socket.containerPath, 'not-the-credential', {
      kind: 'discord',
      operationId: 'create_message',
      path: { channel_id: CHANNEL },
    })

    expect(response).toMatchObject({ ok: false, denied: true })
    await runtime.runPromise(socket.close())
  })

  it('refuses a malformed call without dropping the connection', async () => {
    const { socket } = await open('exec-malformed', grantFor())

    const response = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const client = connect(socket.containerPath)
      let buffer = ''
      client.setEncoding('utf8')
      client.on('error', reject)
      client.on('connect', () => client.write('{"id":"x","credential":"c"}\n'))
      client.on('data', (chunk: string) => {
        buffer += chunk
        const newline = buffer.indexOf('\n')
        if (newline === -1) return
        client.destroy()
        resolve(JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>)
      })
    })

    expect(response).toMatchObject({ ok: false })
    await runtime.runPromise(socket.close())
  })

  it('collects what the workflow logged, bounded', async () => {
    const { credential, socket } = await open('exec-logs', grantFor())

    await speak(socket.containerPath, credential.token, {
      kind: 'log',
      level: 'warn',
      message: 'something happened',
    })

    expect(socket.logs()).toContain('[warn] something happened')
    await runtime.runPromise(socket.close())
  })

  it('is gone once the execution ends', async () => {
    const { socket } = await open('exec-closed', grantFor())
    const path = socket.containerPath

    await runtime.runPromise(socket.close())

    // A socket outliving its execution would be a way back in for a container that somehow
    // survived its deadline.
    await expect(stat(path)).rejects.toThrow()
  })

  it('gives each execution its own directory', async () => {
    const first = await open('exec-a', grantFor())
    const second = await open('exec-b', grantFor())

    expect(first.socket.containerPath).not.toBe(second.socket.containerPath)
    expect(first.socket.containerPath).toContain('exec-a')
    expect(second.socket.containerPath).toContain('exec-b')

    await runtime.runPromise(first.socket.close())
    await runtime.runPromise(second.socket.close())
  })
})
