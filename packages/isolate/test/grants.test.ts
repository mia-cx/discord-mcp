import { OperationCatalog } from '@mia-cx/discord-catalog'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { checkOperation, matchOperation, type ScriptGrants } from '../src/grants.ts'

const catalog = await Effect.runPromise(Effect.provide(OperationCatalog, OperationCatalog.layer))

const grants: ScriptGrants = {
  operations: ['delete_message', 'update_my_user', 'execute_webhook', 'get_my_oauth2_application'],
  families: ['message', 'channel'],
  hosts: [],
}

describe('script grants', () => {
  it.each([
    ['GET', '/channels/1/messages/2', 'get_message', true, 'a family grants reads'],
    ['POST', '/channels/1/messages', 'create_message', true, 'a family grants writes'],
    ['DELETE', '/channels/1', 'delete_channel', false, 'a family never grants a destructive call'],
    ['DELETE', '/channels/1/messages/2', 'delete_message', true, 'a named destructive call runs'],
    ['PATCH', '/users/@me', 'update_my_user', true, 'a named admin call runs'],
    ['GET', '/guilds/1', 'get_guild', false, 'an ungranted family is refused'],
    ['POST', '/webhooks/1/token', 'execute_webhook', false, 'a token route is refused even if named'],
    ['GET', '/oauth2/applications/@me', 'get_my_oauth2_application', false, 'credentials stay out'],
    ['POST', '/channels/1/messages/bulk-delete', 'bulk_delete_messages', false, 'literal beats param'],
    ['GET', '/users/@me', 'get_my_user', false, '@me beats {user_id}'],
  ])('%s %s is %s: allowed %s (%s)', (method, path, operationId, allowed) => {
    const operation = matchOperation(catalog.all, method, path)
    expect(operation?.operationId).toBe(operationId)
    expect(operation && checkOperation(grants, operation).allowed).toBe(allowed)
  })

  it('matches no operation for an uncataloged route', () => {
    expect(matchOperation(catalog.all, 'GET', '/gateway/bot/extra')).toBeUndefined()
  })
})
