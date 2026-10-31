import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { inMemoryStorage } from '@discord-mcp/storage/testing'
import { OperationCatalog } from '@mia-cx/discord-catalog'
import { Effect } from 'effect'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { makeIsolateHost } from '../src/isolate-host.ts'
import { fixtureRegistry } from '../src/testing.ts'
import { makeWorkflowHost } from '../src/workflows.ts'

const BOT = { id: '345678901234567890', username: 'textile', discriminator: '0', bot: true }
const HUMAN = '234567890123456789'
const CHANNEL = '123456789012345678'
const caller = { botId: BOT.id, botUser: BOT, actorId: HUMAN }
/** Guilds, GuildMessages, and MessageContent. */
const INTENTS = 1 | (1 << 9) | (1 << 15)
const ALL_FLAGS = 0xff000
const grants = { operations: [], families: ['message'], hosts: [] }

/**
 * A server the off-registry tarballs live on; npm must never fetch one. Other suites' probes of
 * local ports may land here too, so only tarball requests count.
 */
const elsewhere = createServer((_, response) => response.end())
await new Promise<void>((resolve) => elsewhere.listen(0, '127.0.0.1', resolve))
const elsewhereHits: string[] = []
elsewhere.on('request', ({ url = '' }) => {
  if (url.endsWith('.tgz')) elsewhereHits.push(url)
})
const elsewherePort = (elsewhere.address() as { port: number }).port

/** A file on the relay that no package may bundle. */
const secret = join(await mkdtemp(join(tmpdir(), 'textile-secret-')), 'secret.json')
await writeFile(secret, '{"token":"relay-secret"}')

const registry = await fixtureRegistry([
  {
    name: 'shout',
    version: '1.0.0',
    files: { 'index.js': 'module.exports = (s) => s.toUpperCase()' },
  },
  {
    name: 'shout',
    version: '1.1.0',
    files: { 'index.js': "module.exports = (s) => s.toUpperCase() + '!'" },
  },
  {
    name: 'greet',
    version: '1.0.0',
    dependencies: { shout: '^1.0.0' },
    files: {
      'index.js': "const shout = require('shout'); module.exports = (n) => shout('hello ' + n)",
    },
  },
  {
    name: 'native-thing',
    version: '1.0.0',
    files: { 'index.js': "module.exports = require('./addon.node')", 'addon.node': '\u007fELF' },
  },
  {
    name: 'exotic',
    version: '1.0.0',
    dependencies: { evil: `http://127.0.0.1:${elsewherePort}/evil.tgz` },
    files: { 'index.js': 'module.exports = 1' },
  },
  {
    name: 'snoop',
    version: '1.0.0',
    files: { 'index.js': `module.exports = require(${JSON.stringify(secret)})` },
  },
])
afterAll(async () => {
  await registry.close()
  elsewhere.close()
  await rm(dirname(secret), { recursive: true, force: true })
})

const catalog = await Effect.runPromise(Effect.provide(OperationCatalog, OperationCatalog.layer))

const setup = async () => {
  const storage = await inMemoryStorage()
  const calls: Array<{ route: string; body: unknown }> = []
  const host = makeWorkflowHost({
    storage,
    isolates: makeIsolateHost(),
    bots: { hold: async () => {}, updatePresence: () => {} },
    operations: catalog.all,
    registry: registry.url,
    rest: () => ({
      client: {
        raw: undefined as never,
        request: (call) =>
          Effect.sync(() => {
            calls.push({ route: call.route, body: call.body })
            return call.route === '/users/@me'
              ? BOT
              : { id: '900000000000000002', channel_id: CHANNEL }
          }),
      },
      release: () => {},
    }),
    log: () => {},
  })
  return { storage, host, calls }
}

const GREETER = `
import { Client } from 'discord.js'
import greet from 'greet'

const client = new Client({ intents: [${INTENTS}] })
client.on('messageCreate', (message) => message.channel.send(greet(message.content)))
`

describe('publishing a workflow with npm dependencies', () => {
  it('installs them, records every version, and runs them on events with discord.js’s own collections', async () => {
    const { storage, host, calls } = await setup()

    const revision = await host.publish(caller, {
      name: 'greeter',
      // A package importing @discordjs/collection gets the copy discord.js uses.
      source: `
        import { Collection } from '@discordjs/collection'
        ${GREETER.replace(
          'greet(message.content)',
          "greet(message.content) + ' ' + (client.guilds.cache instanceof Collection)",
        )}`,
      grants,
      dependencies: { greet: '1.0.0' },
    })
    expect(revision.packages).toEqual(['greet@1.0.0', 'shout@1.1.0'])
    expect((await storage.loadWorkflowRevision(BOT.id, 'greeter', 1))?.packages).toEqual([
      'greet@1.0.0',
      'shout@1.1.0',
    ])

    await host.enable(caller, 'greeter', undefined, ALL_FLAGS)
    host.dispatch({
      botId: BOT.id,
      token: 'private-bot-token',
      dispatch: {
        t: 'MESSAGE_CREATE',
        d: {
          id: '900000000000000001',
          channel_id: CHANNEL,
          guild_id: '223456789012345678',
          author: { id: HUMAN, username: 'mia', discriminator: '0' },
          content: 'mia',
          mentions: [],
          attachments: [],
          embeds: [],
          timestamp: '2026-10-31T00:00:00.000Z',
          type: 0,
        },
      },
    })
    await vi.waitFor(
      () =>
        expect(calls).toContainEqual({
          route: `/channels/${CHANNEL}/messages`,
          body: expect.objectContaining({ content: 'HELLO MIA! true' }),
        }),
      { timeout: 15_000 },
    )
    await storage.close()
  }, 60_000)

  it('installs exactly the versions a lockfile pins', async () => {
    const { storage, host } = await setup()
    const lockfile = JSON.stringify({
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': { dependencies: { greet: '1.0.0' } },
        'node_modules/greet': {
          version: '1.0.0',
          resolved: registry.dist('greet', '1.0.0').tarball,
          integrity: registry.dist('greet', '1.0.0').integrity,
          dependencies: { shout: '^1.0.0' },
        },
        'node_modules/shout': {
          version: '1.0.0',
          resolved: registry.dist('shout', '1.0.0').tarball,
          integrity: registry.dist('shout', '1.0.0').integrity,
        },
      },
    })

    const revision = await host.publish(caller, {
      name: 'greeter',
      source: GREETER,
      grants,
      dependencies: { greet: '1.0.0' },
      lockfile,
    })

    expect(revision.packages).toEqual(['greet@1.0.0', 'shout@1.0.0'])
    await storage.close()
  }, 60_000)

  it.each([
    [
      'a package that does not bundle for workerd',
      { dependencies: { 'native-thing': '1.0.0' } },
      GREETER.replace("'greet'", "'native-thing'"),
      "A dependency can't run in a workflow.",
      /addon\.node/,
    ],
    [
      'a URL attachment',
      {},
      `import { Client } from 'discord.js'
       const client = new Client({ intents: [${INTENTS}] })
       client.on('messageCreate', (m) => m.reply({ files: ['https://example.com/cat.png'] }))`,
      "The workflow uses discord.js features workflows can't run.",
      /URL attachment/,
    ],
    [
      'a collector',
      {},
      `import { Client } from 'discord.js'
       const client = new Client({ intents: [${INTENTS}] })
       client.on('messageCreate', async (m) => { await m.channel.awaitMessages({ max: 1 }) })`,
      "The workflow uses discord.js features workflows can't run.",
      /awaitMessages/,
    ],
    [
      'an import no dependency provides',
      {},
      GREETER,
      'The workflow did not build.',
      /"greet".*list it in dependencies/,
    ],
    [
      'a package bundling a file from outside its dependencies',
      { dependencies: { snoop: '1.0.0' } },
      GREETER.replace("'greet'", "'snoop'"),
      "A dependency can't run in a workflow.",
      /resolves outside the workflow's dependencies/,
    ],
    [
      'a dependency fetched from outside the registry',
      { dependencies: { exotic: '1.0.0' } },
      GREETER.replace("'greet'", "'exotic'"),
      'npm could not install the dependencies.',
      /./,
    ],
    [
      'a lockfile installing from outside the registry',
      {
        dependencies: { greet: '1.0.0' },
        lockfile: JSON.stringify({
          lockfileVersion: 3,
          packages: {
            '': { dependencies: { greet: '1.0.0' } },
            'node_modules/greet': {
              version: '1.0.0',
              resolved: `http://127.0.0.1:${elsewherePort}/greet.tgz`,
            },
          },
        }),
      },
      GREETER,
      'The lockfile installs packages from outside the registry.',
      /node_modules\/greet/,
    ],
  ])(
    'refuses %s before storing a revision',
    async (_, extra, source, message, issue) => {
      const { storage, host } = await setup()

      const failure = host.publish(caller, { name: 'broken', source, grants, ...extra })

      await expect(failure).rejects.toMatchObject({
        message,
        issues: expect.arrayContaining([expect.stringMatching(issue)]),
      })
      expect(await storage.listWorkflows(BOT.id)).toEqual([])
      expect(elsewhereHits).toEqual([])
      await storage.close()
    },
    60_000,
  )
})
