import { randomBytes } from 'node:crypto'
import { PermissionFlagsBits } from 'discord-api-types/v10'
import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import { explainPermissions } from './permissions.js'
import { digest, planBlueprint } from './planner.js'
import { PreviewTokenError, PreviewTokens } from './preview-token.js'
import { GuildSnapshotSchema, ServerBlueprintSchema } from './schemas.js'
import type { GuildSnapshot, ServerBlueprint } from './types.js'

const guildId = '12345678901234567'
const snapshot: GuildSnapshot = {
  guildId,
  ownerId: '12345678901234568',
  botMemberId: '12345678901234569',
  botRoleIds: ['12345678901234570'],
  roles: [
    {
      id: guildId,
      name: '@everyone',
      permissions: PermissionFlagsBits.ViewChannel.toString(),
      color: 0,
      hoist: false,
      mentionable: false,
      position: 0,
      managed: false,
    },
    {
      id: '12345678901234570',
      name: 'Bot',
      permissions: (
        PermissionFlagsBits.ViewChannel |
        PermissionFlagsBits.ManageRoles |
        PermissionFlagsBits.ManageChannels |
        PermissionFlagsBits.ManageMessages |
        PermissionFlagsBits.SendMessages
      ).toString(),
      color: 0,
      hoist: false,
      mentionable: false,
      position: 10,
      managed: true,
    },
    {
      id: '12345678901234571',
      name: 'Member',
      permissions: PermissionFlagsBits.SendMessages.toString(),
      color: 0,
      hoist: false,
      mentionable: false,
      position: 1,
      managed: false,
    },
  ],
  channels: [
    {
      id: '12345678901234572',
      kind: 'text',
      name: 'general',
      position: 0,
      topic: null,
      nsfw: false,
      rateLimitPerUser: 0,
      overwrites: [],
    },
  ],
}

const converged: ServerBlueprint = {
  id: 'workspace',
  revision: 1,
  guildId,
  roles: [
    {
      key: 'member',
      name: 'Member',
      permissions: ['SendMessages'],
      order: 0,
    },
  ],
  channels: [
    {
      key: 'general',
      kind: 'text',
      name: 'general',
      topic: null,
      nsfw: false,
      rateLimitPerUser: 0,
      order: 0,
    },
  ],
}

const generalChannel = snapshot.channels[0]
if (generalChannel === undefined) throw new Error('test fixture requires a channel')
const convergedGeneral = converged.channels[0]
if (convergedGeneral === undefined) throw new Error('test fixture requires a blueprint channel')

describe('declarative server blueprints', () => {
  it('advertises strict blueprint and snapshot structures', async () => {
    const blueprintSchema = Schema.toStandardSchemaV1(ServerBlueprintSchema)
    const snapshotSchema = Schema.toStandardSchemaV1(GuildSnapshotSchema)
    expect(await blueprintSchema['~standard'].validate(converged)).toHaveProperty('value')
    expect(
      await blueprintSchema['~standard'].validate({
        ...converged,
        channels: [{ key: 'bad', kind: 'made-up', name: 'Invalid' }],
      }),
    ).toHaveProperty('issues')
    expect(await snapshotSchema['~standard'].validate(snapshot)).toHaveProperty('value')
  })

  it('produces a zero-action diff for converged managed resources', () => {
    const plan = planBlueprint({
      blueprint: converged,
      snapshot,
      bindings: {
        roles: { member: '12345678901234571' },
        channels: { general: '12345678901234572' },
      },
    })
    expect(plan.actions).toEqual([])
    expect(plan.destructive).toBe(false)
  })

  it('does not reconcile already-converged permission overwrites', () => {
    const blueprint: ServerBlueprint = {
      ...converged,
      channels: [
        {
          ...convergedGeneral,
          overwrites: [
            {
              target: { type: 'role', roleKey: 'member' },
              allow: ['ViewChannel'],
              deny: ['SendMessages'],
            },
          ],
        },
      ],
    }
    const actual: GuildSnapshot = {
      ...snapshot,
      channels: [
        {
          ...generalChannel,
          overwrites: [
            {
              id: '12345678901234571',
              type: 'role',
              allow: PermissionFlagsBits.ViewChannel.toString(),
              deny: PermissionFlagsBits.SendMessages.toString(),
            },
          ],
        },
      ],
    }
    const plan = planBlueprint({
      blueprint,
      snapshot: actual,
      bindings: {
        roles: { member: '12345678901234571' },
        channels: { general: '12345678901234572' },
      },
    })
    expect(plan.actions).toEqual([])
  })

  it('removes stale overwrites when the managed channel declares an empty set', () => {
    const plan = planBlueprint({
      blueprint: converged,
      snapshot: {
        ...snapshot,
        channels: [
          {
            ...generalChannel,
            overwrites: [
              {
                id: '12345678901234574',
                type: 'member',
                allow: PermissionFlagsBits.ViewChannel.toString(),
                deny: '0',
              },
            ],
          },
        ],
      },
      bindings: {
        roles: { member: '12345678901234571' },
        channels: { general: '12345678901234572' },
      },
    })
    expect(plan.actions).toContainEqual({
      type: 'channel.overwrites',
      key: 'general',
      channelId: '12345678901234572',
      overwrites: [],
      deleteOverwriteIds: ['12345678901234574'],
    })
  })

  it('orders roles before categories and their child channels', () => {
    const plan = planBlueprint({
      blueprint: {
        ...converged,
        roles: [{ key: 'moderator', name: 'Moderator', permissions: ['ManageMessages'] }],
        channels: [
          { key: 'staff', kind: 'category', name: 'Staff' },
          {
            key: 'staff-chat',
            kind: 'text',
            name: 'staff-chat',
            parentKey: 'staff',
            overwrites: [
              {
                target: { type: 'role', roleKey: 'moderator' },
                allow: ['ViewChannel'],
                deny: ['SendMessages'],
              },
            ],
          },
        ],
      },
      snapshot,
      bindings: { roles: {}, channels: {} },
    })
    expect(plan.actions.map(({ type }) => type)).toEqual([
      'role.create',
      'role.reorder',
      'channel.create',
      'channel.create',
      'channel.overwrites',
      'channel.reorder',
    ])
  })

  it('represents and orders forum, guild, onboarding, welcome, and AutoMod reconciliation', () => {
    const plan = planBlueprint({
      blueprint: {
        id: 'community',
        revision: 1,
        guildId,
        settings: {
          verificationLevel: 'medium',
          systemChannelKey: 'general',
          rulesChannelKey: 'general',
        },
        roles: [{ key: 'member', name: 'Member', permissions: ['SendMessages'] }],
        channels: [
          { key: 'general', kind: 'text', name: 'general' },
          {
            key: 'support',
            kind: 'forum',
            name: 'support',
            defaultForumLayout: 'list',
            defaultSortOrder: 'latestActivity',
            forumTags: [
              { key: 'question', name: 'Question', emojiName: '❓' },
              { key: 'resolved', name: 'Resolved', moderated: true },
            ],
          },
        ],
        welcomeScreen: {
          enabled: true,
          description: 'Welcome',
          channels: [{ channelKey: 'general', description: 'Start here' }],
        },
        onboarding: {
          enabled: true,
          defaultChannelKeys: ['general'],
          prompts: [
            {
              key: 'interests',
              title: 'What are you interested in?',
              type: 'multipleChoice',
              options: [
                {
                  key: 'community',
                  title: 'Community',
                  channelKeys: ['general'],
                  roleKeys: ['member'],
                },
              ],
            },
          ],
        },
        autoModerationRules: [
          {
            key: 'mention-spam',
            name: 'Mention spam',
            trigger: { type: 'mentionSpam', mentionTotalLimit: 5 },
            actions: [
              { type: 'blockMessage', customMessage: 'Too many mentions.' },
              { type: 'sendAlert', channelKey: 'general' },
            ],
          },
        ],
      },
      snapshot,
      bindings: { roles: {}, channels: {}, autoModerationRules: {} },
    })
    expect(plan.actions.map(({ type }) => type)).toEqual(
      expect.arrayContaining([
        'channel.create',
        'guild.update',
        'welcome.update',
        'onboarding.update',
        'automod.create',
      ]),
    )
    expect(plan.actions.findIndex(({ type }) => type === 'channel.create')).toBeLessThan(
      plan.actions.findIndex(({ type }) => type === 'guild.update'),
    )
  })

  it('preserves omitted managed and all unmanaged resources by default', () => {
    const plan = planBlueprint({
      blueprint: { ...converged, roles: [], channels: [] },
      snapshot,
      bindings: {
        roles: { old: '12345678901234571' },
        channels: { old: '12345678901234572' },
      },
    })
    expect(plan.actions).toEqual([])
    expect(plan.warnings[0]).toContain('preserved')
  })

  it('reports role hierarchy failures during planning', () => {
    expect(() =>
      planBlueprint({
        blueprint: converged,
        snapshot: {
          ...snapshot,
          roles: snapshot.roles.map((role) =>
            role.id === '12345678901234571' ? { ...role, position: 10 } : role,
          ),
        },
        bindings: {
          roles: { member: '12345678901234571' },
          channels: { general: '12345678901234572' },
        },
      }),
    ).toThrow(/at or above the bot's highest role/)
  })

  it('reports permissions the bot cannot grant during planning', () => {
    expect(() =>
      planBlueprint({
        blueprint: {
          ...converged,
          roles: [
            {
              key: 'administrator',
              name: 'Administrator',
              permissions: ['Administrator'],
            },
          ],
          channels: [],
        },
        snapshot,
        bindings: { roles: {}, channels: {} },
      }),
    ).toThrow(/permissions the bot does not hold: Administrator/)
  })

  it('computes channel overwrites in Discord order', () => {
    const explained = explainPermissions({
      snapshot: {
        ...snapshot,
        channels: [
          {
            ...generalChannel,
            overwrites: [
              {
                id: guildId,
                type: 'role',
                allow: '0',
                deny: PermissionFlagsBits.ViewChannel.toString(),
              },
              {
                id: '12345678901234571',
                type: 'role',
                allow: PermissionFlagsBits.ViewChannel.toString(),
                deny: '0',
              },
            ],
          },
        ],
      },
      memberId: '12345678901234573',
      roleIds: ['12345678901234571'],
      channelId: '12345678901234572',
    })
    expect(explained.permissions).toContain('ViewChannel')
    expect(explained.permissions).toContain('SendMessages')
  })

  it('binds preview tokens to exact principal, state, and action digest', () => {
    const tokens = new PreviewTokens(randomBytes(32))
    const expected = {
      principalId: 'local',
      guildId,
      blueprintDigest: digest(converged),
      snapshotDigest: digest(snapshot),
      actionsDigest: digest([]),
    }
    const token = tokens.issue(expected, 1_000)
    expect(tokens.verify(token, expected, 30_000).principalId).toBe('local')
    expect(() =>
      tokens.verify(token, { ...expected, actionsDigest: digest(['changed']) }, 30_000),
    ).toThrow(PreviewTokenError)
    expect(() => tokens.verify(token, expected, 62_000)).toThrow(/expired/)
  })
})
