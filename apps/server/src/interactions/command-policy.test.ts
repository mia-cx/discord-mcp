import { describe, expect, it } from 'vitest'
import { assertCommandPublishingGranted } from './command-policy.js'

describe('workflow command publishing grants', () => {
  it('allows global-only and guild-only grants independently', () => {
    expect(() =>
      assertCommandPublishingGranted(
        true,
        { guildCommandPublishing: false, globalCommandPublishing: true },
        'global-command',
      ),
    ).not.toThrow()
    expect(() =>
      assertCommandPublishingGranted(
        false,
        { guildCommandPublishing: true, globalCommandPublishing: false },
        'guild-command',
      ),
    ).not.toThrow()
  })

  it('rejects each command scope without its matching explicit grant', () => {
    expect(() =>
      assertCommandPublishingGranted(
        true,
        { guildCommandPublishing: true, globalCommandPublishing: false },
        'global-command',
      ),
    ).toThrow(/global-command grant/)
    expect(() =>
      assertCommandPublishingGranted(
        false,
        { guildCommandPublishing: false, globalCommandPublishing: true },
        'guild-command',
      ),
    ).toThrow(/guild-command grant/)
  })
})
