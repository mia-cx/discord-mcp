import { describe, expect, it } from 'vitest'
import { botIdFromToken, ownerOf } from '../src/router.ts'

const BOT_ID = '345678901234567890'
const segment = (text: string) => Buffer.from(text).toString('base64url')

describe('botIdFromToken', () => {
  it.each([
    ['a bot token', `${segment(BOT_ID)}.GhJkLm.secret-part`, BOT_ID],
    ['padded base64', `${Buffer.from(BOT_ID).toString('base64')}=.x.y`, BOT_ID],
    ['a 17-digit ID', `${segment('81384788765712384')}.x.y`, '81384788765712384'],
    ['no segments', 'not-a-bot-token', undefined],
    ['an empty token', '', undefined],
    ['a non-numeric first segment', `${segment('bot-a')}.x.y`, undefined],
    ['a too-short ID', `${segment('1234')}.x.y`, undefined],
    ['characters outside base64', `${segment(BOT_ID)}!.x.y`, undefined],
  ])('reads %s', (_, token, expected) => {
    expect(botIdFromToken(token)).toBe(expected)
  })
})

describe('ownerOf', () => {
  const bots = Array.from({ length: 300 }, (_, i) => String(345678901234567890n + BigInt(i)))
  const owners = (hosts: string[]) => new Map(bots.map((bot) => [bot, ownerOf(hosts, bot)]))
  const A = 'http://bot-host-0:3001'
  const B = 'http://bot-host-1:3001'
  const C = 'http://bot-host-2:3001'

  it('has no owner without hosts', () => {
    expect(ownerOf([], BOT_ID)).toBeUndefined()
  })

  it('agrees whatever order the hosts are listed in, and uses every host', () => {
    const forward = owners([A, B, C])
    expect(owners([C, A, B])).toEqual(forward)
    expect(new Set(forward.values())).toEqual(new Set([A, B, C]))
  })

  it.each([
    { change: 'adding a host moves bots only to it', before: [A, B], after: [A, B, C], to: C },
    { change: 'removing a host moves only its bots', before: [A, B, C], after: [A, C], from: B },
  ])('$change', ({ before, after, from, to }) => {
    const old = owners(before)
    const moved = [...owners(after)].filter(([bot, owner]) => old.get(bot) !== owner)
    expect(moved.length).toBeGreaterThan(0)
    for (const [bot, owner] of moved) {
      if (to !== undefined) expect(owner).toBe(to)
      if (from !== undefined) expect(old.get(bot)).toBe(from)
    }
  })
})
