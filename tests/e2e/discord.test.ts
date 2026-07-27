import { randomUUID } from 'node:crypto'
import { DiscordApiError, DiscordRestClient, discordJsTransport } from '@discord-mcp/discord-api'
import {
  encodeMessage,
  type MessagePresentation,
  type MessageTemplateDocument,
  renderTemplate,
} from '@discord-mcp/discord-presentations'
import { Effect } from 'effect'
import { afterAll, describe, expect, it } from 'vitest'

interface DiscordIdentity {
  readonly id: string
  readonly username?: string
}

interface DiscordGuild {
  readonly id: string
  readonly name: string
}

interface DiscordChannel {
  readonly id: string
  readonly name: string
  readonly type: number
}

interface DiscordRole {
  readonly id: string
  readonly name: string
}

interface DiscordMessage {
  readonly id: string
  readonly channel_id: string
  readonly content: string
  readonly flags?: number
}

const token = process.env.DISCORD_TOKEN as string
const guildId = process.env.DISCORD_MCP_TEST_GUILD_ID as string
const channelId = process.env.DISCORD_MCP_TEST_CHANNEL_ID as string
const designatedMemberId = process.env.DISCORD_MCP_TEST_MEMBER_ID
const forbiddenChannelId = process.env.DISCORD_MCP_TEST_FORBIDDEN_CHANNEL_ID
const oauthToken = process.env.DISCORD_MCP_TEST_OAUTH_TOKEN
const rest = new DiscordRestClient(discordJsTransport(token))
const createdMessages = new Set<string>()
const createdChannels = new Set<string>()
const createdRoles = new Set<string>()
const run = <A>(effect: Effect.Effect<A, unknown>): Promise<A> => Effect.runPromise(effect)
const suffix = randomUUID().slice(0, 8)

const deleteIgnoringMissing = async (route: string): Promise<void> => {
  await run(rest.request('DELETE', route)).catch((cause: unknown) => {
    if (!(cause instanceof DiscordApiError) || cause.status !== 404) throw cause
  })
}

afterAll(async () => {
  await Promise.allSettled(
    [...createdMessages].map((id) =>
      deleteIgnoringMissing(`/channels/${channelId}/messages/${id}`),
    ),
  )
  await Promise.allSettled(
    [...createdChannels].map((id) => deleteIgnoringMissing(`/channels/${id}`)),
  )
  await Promise.allSettled(
    [...createdRoles].map((id) => deleteIgnoringMissing(`/guilds/${guildId}/roles/${id}`)),
  )
})

describe('opt-in Discord test guild', () => {
  it('authenticates the application and inspects the designated guild and channel', async () => {
    const [application, guild, channels] = await run(
      Effect.all([
        rest.request<DiscordIdentity>('GET', '/applications/@me'),
        rest.request<DiscordGuild>('GET', `/guilds/${guildId}`),
        rest.request<ReadonlyArray<DiscordChannel>>('GET', `/guilds/${guildId}/channels`),
      ]),
    )
    expect(application.id).toMatch(/^\d{17,21}$/)
    expect(guild).toMatchObject({ id: guildId })
    expect(channels.some(({ id }) => id === channelId)).toBe(true)
  })

  it('sends, edits, reacts to, reads, and deletes a guarded legacy message', async () => {
    const created = await run(
      rest.request<DiscordMessage>('POST', `/channels/${channelId}/messages`, {
        body: {
          content: `discord-mcp e2e ${suffix}`,
          allowed_mentions: { parse: [], users: [], roles: [], replied_user: false },
        },
      }),
    )
    createdMessages.add(created.id)
    const edited = await run(
      rest.request<DiscordMessage>('PATCH', `/channels/${channelId}/messages/${created.id}`, {
        body: {
          content: `discord-mcp e2e edited ${suffix}`,
          allowed_mentions: { parse: [], users: [], roles: [], replied_user: false },
        },
      }),
    )
    expect(edited.content).toContain('edited')
    await run(
      rest.request('PUT', `/channels/${channelId}/messages/${created.id}/reactions/%E2%9C%85/@me`),
    )
    const read = await run(
      rest.request<DiscordMessage>('GET', `/channels/${channelId}/messages/${created.id}`),
    )
    expect(read.id).toBe(created.id)
    await deleteIgnoringMissing(`/channels/${channelId}/messages/${created.id}`)
    createdMessages.delete(created.id)
  })

  it('sends a rich Components V2 announcement and a typed template rendering', async () => {
    const presentation: Extract<MessagePresentation, { type: 'components_v2' }> = {
      type: 'components_v2',
      components: [
        {
          type: 'container',
          accentColor: 0x5865f2,
          components: [
            { type: 'text', content: `## Release ${suffix}\nThe e2e build is ready.` },
            {
              type: 'section',
              components: [{ type: 'text', content: 'Validated against the live Discord API.' }],
              accessory: {
                type: 'thumbnail',
                media: { url: 'https://cdn.discordapp.com/embed/avatars/0.png' },
              },
            },
            {
              type: 'mediaGallery',
              items: [
                {
                  media: { url: 'https://cdn.discordapp.com/embed/avatars/1.png' },
                  description: 'Discord MCP release validation',
                },
              ],
            },
            { type: 'separator', spacing: 'large' },
            { type: 'file', file: { url: 'attachment://release.txt' } },
            {
              type: 'actionRow',
              components: [
                {
                  type: 'button',
                  style: 'primary',
                  label: 'Acknowledge',
                  action: { type: 'workflow', key: 'e2e-acknowledge' },
                },
              ],
            },
          ],
        },
      ],
      attachments: [
        {
          source: 'inline',
          filename: 'release.txt',
          mimeType: 'text/plain',
          data: Buffer.from(`release ${suffix}`).toString('base64'),
        },
      ],
    }
    const encoded = encodeMessage(presentation, `e2e:${suffix}`)
    const announcement = await run(
      rest.request<DiscordMessage>('POST', `/channels/${channelId}/messages`, {
        body: encoded.payload,
        files: [
          {
            name: 'release.txt',
            contentType: 'text/plain',
            data: Buffer.from(`release ${suffix}`),
          },
        ],
      }),
    )
    createdMessages.add(announcement.id)
    expect((announcement.flags ?? 0) & 32_768).toBe(32_768)

    const template: MessageTemplateDocument = {
      variableSchema: {
        release: { type: 'string', minLength: 1, maxLength: 80 },
        environment: {
          type: 'enum',
          values: ['staging', 'production'],
          default: 'staging',
        },
      },
      presentation: {
        type: 'components_v2',
        components: [
          {
            type: 'container',
            components: [
              { type: 'text', content: { $variable: 'release', context: 'plainText' } },
              { type: 'text', content: { $variable: 'environment', context: 'inlineCode' } },
            ],
          },
        ],
      },
    }
    const rendered = renderTemplate(template, { release: `Template ${suffix}` })
    const encodedTemplate = encodeMessage(rendered.presentation)
    const templateMessage = await run(
      rest.request<DiscordMessage>('POST', `/channels/${channelId}/messages`, {
        body: encodedTemplate.payload,
      }),
    )
    createdMessages.add(templateMessage.id)
    expect((templateMessage.flags ?? 0) & 32_768).toBe(32_768)
  })

  it('creates, orders, protects, and removes temporary role/category/text/forum/voice resources', async () => {
    const role = await run(
      rest.request<DiscordRole>('POST', `/guilds/${guildId}/roles`, {
        body: {
          name: `dcmcp-e2e-${suffix}`,
          permissions: '0',
          hoist: false,
          mentionable: false,
        },
        reason: 'discord-mcp v1 e2e validation',
      }),
    )
    createdRoles.add(role.id)
    const category = await run(
      rest.request<DiscordChannel>('POST', `/guilds/${guildId}/channels`, {
        body: { name: `dcmcp-e2e-${suffix}`, type: 4 },
        reason: 'discord-mcp v1 e2e validation',
      }),
    )
    createdChannels.add(category.id)
    const channels: Array<DiscordChannel> = []
    for (const body of [
      { name: `dcmcp-text-${suffix}`, type: 0, parent_id: category.id },
      { name: `dcmcp-forum-${suffix}`, type: 15, parent_id: category.id },
      { name: `dcmcp-voice-${suffix}`, type: 2, parent_id: category.id },
    ]) {
      const channel = await run(
        rest.request<DiscordChannel>('POST', `/guilds/${guildId}/channels`, {
          body,
          reason: 'discord-mcp v1 e2e validation',
        }),
      )
      channels.push(channel)
      createdChannels.add(channel.id)
    }
    const text = channels[0]
    if (!text) throw new Error('temporary text channel was not created')
    await run(
      rest.request('PUT', `/channels/${text.id}/permissions/${role.id}`, {
        body: { type: 0, allow: '1024', deny: '2048' },
        reason: 'discord-mcp v1 e2e validation',
      }),
    )
    await run(
      rest.request('PATCH', `/guilds/${guildId}/channels`, {
        body: channels.map((channel, position) => ({
          id: channel.id,
          position,
          parent_id: category.id,
        })),
      }),
    )
    await run(
      rest.request('PATCH', `/guilds/${guildId}/roles`, {
        body: [{ id: role.id, position: 1 }],
      }),
    )
    await Promise.all(
      [...channels].reverse().map(({ id }) => deleteIgnoringMissing(`/channels/${id}`)),
    )
    for (const channel of channels) createdChannels.delete(channel.id)
    await deleteIgnoringMissing(`/channels/${category.id}`)
    createdChannels.delete(category.id)
    await deleteIgnoringMissing(`/guilds/${guildId}/roles/${role.id}`)
    createdRoles.delete(role.id)
  })

  it.skipIf(!designatedMemberId)(
    'times out and bans only the explicitly designated disposable member, then removes the ban',
    async () => {
      const memberId = designatedMemberId as string
      await run(
        rest.request('PATCH', `/guilds/${guildId}/members/${memberId}`, {
          body: { communication_disabled_until: new Date(Date.now() + 5_000).toISOString() },
          reason: 'discord-mcp designated-member e2e validation',
        }),
      )
      await run(
        rest.request('PATCH', `/guilds/${guildId}/members/${memberId}`, {
          body: { communication_disabled_until: null },
          reason: 'discord-mcp designated-member e2e cleanup',
        }),
      )
      await run(
        rest.request('PUT', `/guilds/${guildId}/bans/${memberId}`, {
          body: { delete_message_seconds: 0 },
          reason: 'discord-mcp designated-member e2e validation',
        }),
      )
      await deleteIgnoringMissing(`/guilds/${guildId}/bans/${memberId}`)
    },
  )

  it.skipIf(!forbiddenChannelId)(
    'returns an actionable 403 for the explicitly designated forbidden channel',
    async () => {
      await expect(
        run(
          rest.request('POST', `/channels/${forbiddenChannelId}/messages`, {
            body: {
              content: `permission probe ${suffix}`,
              allowed_mentions: { parse: [], users: [], roles: [] },
            },
          }),
        ),
      ).rejects.toMatchObject({ status: 403 })
    },
  )

  it.skipIf(!oauthToken)('calls a user-scoped endpoint with an OAuth bearer profile', async () => {
    const oauth = new DiscordRestClient(discordJsTransport(oauthToken as string, 'Bearer'))
    const user = await run(oauth.request<DiscordIdentity>('GET', '/users/@me'))
    expect(user.id).toMatch(/^\d{17,21}$/)
    expect(user.username).toBeTruthy()
  })
})
