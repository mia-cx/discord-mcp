/**
 * Runs the bundled smoke Worker in workerd through Miniflare and checks what it returns.
 * Invoked by `scripts/verify-package.ts` inside the throwaway consumer workspace.
 */
import { deepStrictEqual, ok } from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { Miniflare } from 'miniflare'

const config = JSON.parse(await readFile('wrangler.json', 'utf8'))
const mf = new Miniflare({
  modules: true,
  scriptPath: 'out/worker.js',
  compatibilityDate: config.compatibility_date,
  compatibilityFlags: config.compatibility_flags ?? [],
})

try {
  const response = await mf.dispatchFetch('http://smoke.test/')
  const facts = await response.json()
  ok(response.ok, `worker answered ${response.status}: ${JSON.stringify(facts)}`)

  const { kick, bodyRef, bodyDefs, ...exact } = facts
  ok(kick.includes('delete_guild_member'), `search for a kick found ${kick}`)
  ok(bodyRef.startsWith('#/$defs/'), `body schema root is ${bodyRef}`)
  ok(bodyDefs > 0, 'body schema has an empty $defs closure')
  deepStrictEqual(exact, {
    operations: 242,
    createMessage: 'POST /channels/{channel_id}/messages',
    bodyRefsResolve: true,
    hasDetails: true,
    missing: 'OperationNotFoundError',
    apiVersion: '10',
    canSend: false,
    canManageMessages: true,
    whyNotSend:
      'SendMessages is denied by @everyone channel overwrite (channel stage). It was granted earlier by @everyone role.',
    canManageEveryone: false,
    canManageMods: true,
    kickRequires: {
      requires: 'any-of',
      anyOf: [{ permissions: ['KickMembers'], scope: { level: 'guild', pathParam: 'guild_id' } }],
      hierarchy: [{ rule: 'member-below', target: 'user_id' }],
      sources: [
        'https://docs.discord.com/developers/resources/guild#remove-guild-member',
        'https://docs.discord.com/developers/topics/permissions#permission-hierarchy',
      ],
    },
    permissionEntries: 242,
    authMode: 'bot',
    riskClass: 'destructive',
  })
  process.stdout.write('workerd smoke passed\n')
} finally {
  await mf.dispose()
}
