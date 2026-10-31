import { describe, expect, it } from 'vitest'
import { unsupportedUses } from '../src/unsupported.ts'

const COLLECTOR = expect.stringContaining('collectors and awaitMessages')
const ATTACHMENT = expect.stringContaining('URL attachment')

describe('finding what a fresh isolate per event cannot run', () => {
  it.each([
    ['awaitMessages', 'm.channel.awaitMessages({ max: 1 })', [COLLECTOR]],
    [
      'a collector imported under another name',
      "import { MessageCollector as C } from 'discord.js'; new C(m.channel)",
      [COLLECTOR],
    ],
    [
      'a collector through a namespace',
      "import * as Discord from 'discord.js'; new Discord.InteractionCollector(client)",
      [COLLECTOR],
    ],
    [
      'a collector beside a decorator, which esbuild accepts and acorn alone would not',
      'const log = (c: unknown) => c\n@log class Bot {}\nm.channel.createMessageCollector()',
      [COLLECTOR],
    ],
    [
      'a destructured collector class',
      "const { MessageCollector } = require('discord.js'); new MessageCollector(m.channel)",
      [COLLECTOR],
    ],
    [
      'a collector class destructured under another name',
      "const { MessageCollector: C } = require('discord.js'); new C(m.channel)",
      [COLLECTOR],
    ],
    [
      'a collector after a top-level return, which CommonJS allows',
      'if (!m) return\nm.channel.awaitMessages()',
      [COLLECTOR],
    ],
    ['a computed collector method', "m.channel['createMessageCollector']()", [COLLECTOR]],
    [
      'a URL in files',
      "m.reply({ files: ['a.png', 'https://example.com/cat.png'] })",
      [ATTACHMENT],
    ],
    ['a quoted files key', `m.reply({ "files": ["https://example.com/cat.png"] })`, [ATTACHMENT]],
    [
      'a URL attachment object',
      "m.reply({ files: [{ attachment: 'http://x.test/a' }] })",
      [ATTACHMENT],
    ],
    [
      'an AttachmentBuilder from a URL built by concatenation',
      "import { AttachmentBuilder } from 'discord.js'; new AttachmentBuilder('https://x.test/' + id)",
      [ATTACHMENT],
    ],
    // Text that only mentions them creates nothing.
    ['a message that mentions awaitMessages', "m.reply('Example: .awaitMessages()')", []],
    ['a data key named awaitMessages', 'm.reply(JSON.stringify({ awaitMessages: false }))', []],
    ['a URL sent as text', "m.reply({ content: 'https://example.com/cat.png' })", []],
    ['a local file', "m.reply({ files: ['./cat.png'] })", []],
    ['source that does not compile', 'm.reply(', []],
    // Bundling, not this check, decides whether such source publishes.
    [
      'source nested past the parser’s stack',
      `m.reply(${'['.repeat(5_000)}${']'.repeat(5_000)})`,
      [],
    ],
  ])('%s', async (_, source, issues) => {
    expect(await unsupportedUses(source)).toEqual(issues)
  })

  it('reads hostile input in linear time', async () => {
    // Unclosed `files: [` fragments made the earlier pattern rescan the rest of the source each time.
    const source = `const s = "${'files: ['.repeat(28_000)}"`
    const started = performance.now()

    expect(await unsupportedUses(source)).toEqual([])
    expect(performance.now() - started).toBeLessThan(1_000)
  })
})
