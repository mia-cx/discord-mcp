import { describe, expect, it } from 'vitest'
import { type MessageTemplateDocument, renderTemplate, TemplateError } from './template.js'

const document: MessageTemplateDocument = {
  variableSchema: {
    title: { type: 'string', minLength: 1, maxLength: 80 },
    user: { type: 'snowflake' },
    environment: { type: 'enum', values: ['staging', 'production'], default: 'staging' },
  },
  presentation: {
    type: 'components_v2',
    components: [
      {
        type: 'container',
        components: [
          { type: 'text', content: { $variable: 'title', context: 'plainText' } },
          { type: 'text', content: { $variable: 'user', context: 'mentionUser' } },
          { type: 'text', content: { $variable: 'environment', context: 'inlineCode' } },
        ],
      },
    ],
  },
}

describe('message templates', () => {
  it('decodes variables, applies defaults, escapes context, and validates the result', () => {
    const rendered = renderTemplate(document, {
      title: '**unsafe**',
      user: '12345678901234567',
    })
    expect(rendered.presentation).toMatchObject({
      type: 'components_v2',
      components: [
        {
          components: [
            { content: '\\*\\*unsafe\\*\\*' },
            { content: '<@12345678901234567>' },
            { content: 'staging' },
          ],
        },
      ],
    })
    expect(rendered.digest).toMatch(/^[a-f0-9]{64}$/)
  })

  it('rejects undeclared inputs and invalid typed variables deterministically', () => {
    expect(() =>
      renderTemplate(document, {
        title: 'Hello',
        user: 'not-a-snowflake',
      }),
    ).toThrow(TemplateError)
    expect(() =>
      renderTemplate(document, {
        title: 'Hello',
        user: '12345678901234567',
        executable: 'process.exit()',
      }),
    ).toThrow(/not declared/)
  })
})
