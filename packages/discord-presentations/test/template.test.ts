import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  escapeFor,
  type MessageTemplate,
  renderTemplate,
  type VariableNodeType,
  validateVariables,
} from '../src/template.ts'

const render = (template: MessageTemplate, variables: unknown) =>
  Effect.runPromiseExit(renderTemplate(template, variables))

const textTemplate = (
  content: string,
  variables: Record<string, VariableNodeType>,
): MessageTemplate =>
  ({
    variables,
    presentation: { type: 'components_v2', components: [{ type: 'text', content }] },
  }) as MessageTemplate

const renderedText = (exit: { _tag: string; value?: unknown }): string => {
  const presentation = exit.value as { components: Array<{ content: string }> }
  return presentation.components[0]?.content ?? ''
}

describe('contextual escaping', () => {
  it('neutralises markdown and mentions in plain text', () => {
    // The default context, and the one a template author gets without thinking about it.
    const escaped = escapeFor('**bold** @everyone', 'plainText')
    expect(escaped).not.toContain('**bold**')
    expect(escaped).not.toBe('**bold** @everyone')
    // A zero-width space after @ stops the client resolving a mention.
    expect(escaped).toContain('@​')
  })

  it('passes markdown through only when the author asked for it', () => {
    expect(escapeFor('**bold**', 'discordMarkdown')).toBe('**bold**')
  })

  it('cannot be escaped out of an inline code span', () => {
    // A backtick in the value would otherwise close the span and let the rest render as markdown.
    expect(escapeFor('a`b', 'inlineCode')).toBe('`ab`')
    expect(escapeFor('x```y', 'codeBlock')).toContain('xy')
  })

  it('builds mentions from digits only, so a value cannot forge markup', () => {
    expect(escapeFor('123456789012345678', 'userMention')).toBe('<@123456789012345678>')
    expect(escapeFor('123> <@everyone', 'userMention')).toBe('<@123>')
  })

  it('percent-encodes a URL', () => {
    expect(escapeFor('https://x.test/a b', 'url')).toBe('https://x.test/a%20b')
  })
})

describe('variable validation', () => {
  const check = (declared: Record<string, VariableNodeType>, supplied: unknown) =>
    Effect.runPromiseExit(validateVariables(declared, supplied))

  it('applies defaults and requires what is required', async () => {
    const declared: Record<string, VariableNodeType> = {
      title: { kind: 'string', required: true },
      tone: { kind: 'enum', values: ['calm', 'urgent'], default: 'calm' },
    }

    const missing = await check(declared, {})
    expect(missing._tag).toBe('Failure')
    expect(JSON.stringify(missing)).toContain('title')

    const ok = await check(declared, { title: 'Release' })
    expect(ok._tag).toBe('Success')
    if (ok._tag === 'Success') expect(ok.value.tone).toBe('calm')
  })

  it('rejects an undeclared variable rather than ignoring it', async () => {
    // Silently dropping it would render a template that quietly omits what the caller supplied.
    const exit = await check({ a: { kind: 'string' } }, { a: 'x', typo: 'y' })
    expect(exit._tag).toBe('Failure')
    expect(JSON.stringify(exit)).toContain('not declared by this template')
  })

  it('validates snowflakes, urls, timestamps, and enums by kind', async () => {
    const cases: Array<[VariableNodeType, unknown, boolean]> = [
      [{ kind: 'snowflake' }, '123456789012345678', true],
      [{ kind: 'snowflake' }, 'not-an-id', false],
      [{ kind: 'url' }, 'https://x.test', true],
      [{ kind: 'url' }, 'javascript:alert(1)', false],
      [{ kind: 'timestamp' }, '2026-07-26T00:00:00Z', true],
      [{ kind: 'timestamp' }, 'yesterday', false],
      [{ kind: 'enum', values: ['a'] }, 'a', true],
      [{ kind: 'enum', values: ['a'] }, 'b', false],
      [{ kind: 'number', minimum: 1, maximum: 5 }, 3, true],
      [{ kind: 'number', minimum: 1, maximum: 5 }, 9, false],
    ]

    for (const [node, value, shouldPass] of cases) {
      const exit = await check({ v: node }, { v: value })
      expect(exit._tag === 'Success', `${node.kind} with ${JSON.stringify(value)}`).toBe(shouldPass)
    }
  })

  it('validates nested arrays and objects', async () => {
    const declared: Record<string, VariableNodeType> = {
      items: { kind: 'array', items: { kind: 'string', maxLength: 3 } },
      meta: { kind: 'object', properties: { id: { kind: 'snowflake', required: true } } },
    }

    expect(
      (await check(declared, { items: ['ab'], meta: { id: '123456789012345678' } }))._tag,
    ).toBe('Success')
    expect(
      (await check(declared, { items: ['toolong'], meta: { id: '123456789012345678' } }))._tag,
    ).toBe('Failure')
    expect((await check(declared, { items: [], meta: {} }))._tag).toBe('Failure')
  })
})

describe('rendering', () => {
  it('substitutes placeholders and escapes per declared context', async () => {
    const template = textTemplate('## {{title}}\nby {{author}}', {
      title: { kind: 'string', required: true, context: 'discordMarkdown' },
      author: { kind: 'string', required: true },
    })

    const exit = await render(template, { title: 'Release **2.1**', author: '@everyone' })
    expect(exit._tag).toBe('Success')

    const text = renderedText(exit)
    // The author chose markdown for the title, so it passes through.
    expect(text).toContain('Release **2.1**')
    // The author is plainText by default, so its @ is neutralised.
    expect(text).not.toMatch(/by @everyone$/)
  })

  it('renders deterministically', async () => {
    const template = textTemplate('{{a}}-{{b}}', {
      a: { kind: 'string', required: true },
      b: { kind: 'number', required: true },
    })
    const first = await render(template, { a: 'x', b: 1 })
    const second = await render(template, { a: 'x', b: 1 })
    expect(renderedText(first)).toBe(renderedText(second))
  })

  it('resolves dotted paths into object variables', async () => {
    const template = textTemplate('Deployed {{release.version}}', {
      release: {
        kind: 'object',
        required: true,
        properties: { version: { kind: 'string', required: true } },
      },
    })
    const exit = await render(template, { release: { version: '2.1.0' } })
    expect(renderedText(exit)).toBe('Deployed 2.1.0')
  })

  it('fails on a placeholder with no value rather than emitting an empty string', async () => {
    const template = textTemplate('Hello {{missing}}', { present: { kind: 'string' } })
    const exit = await render(template, {})
    expect(exit._tag).toBe('Failure')
    expect(JSON.stringify(exit)).toContain('{{missing}}')
  })

  it('passes the rendered result through the ordinary presentation validator', async () => {
    // A template must not be able to produce something a hand-authored send could not.
    const template: MessageTemplate = {
      variables: { body: { kind: 'string', required: true } },
      presentation: { type: 'components_v2', components: [{ type: 'text', content: '{{body}}' }] },
    } as MessageTemplate

    const tooLong = await render(template, { body: 'x'.repeat(4001) })
    expect(tooLong._tag).toBe('Failure')
    expect(JSON.stringify(tooLong)).toContain('not a valid presentation')
  })

  it('never evaluates anything in a placeholder', async () => {
    // Templates are agent-supplied data. Anything that looked like an expression must render as
    // the literal it is, or the control plane would be executing agent code next to a bot token.
    const template = textTemplate('{{a}}', { a: { kind: 'string', required: true } })
    // Assembled rather than written literally, so the lint rule that catches an accidental
    // template literal does not fire on a string that is deliberately not one.
    const looksLikeAnExpression = `${'$'}{process.env.DISCORD_TOKEN}`
    const exit = await render(template, { a: looksLikeAnExpression })

    const text = renderedText(exit)
    // Rendered as the literal it is. The underscore is backslash-escaped because plainText
    // neutralises markdown, which is the point: it is text, not an expression and not markup.
    expect(text).toContain('process.env.DISCORD')
    expect(text).toContain('${')
    expect(text).not.toContain(process.env.DISCORD_TOKEN ?? '\u0000never')
  })
})
