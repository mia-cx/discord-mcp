import {
  type AuthProfiles,
  type DiscordRest,
  dispatch,
  OperationCatalog,
  type PreviewTokens,
} from '@discord-mcp/discord-api'
import { Database } from '@discord-mcp/persistence'
import { Context, Effect, Layer } from 'effect'
import { CapabilityBroker, type CapabilityCredential } from './broker.ts'
import type { CapabilityRequest, CapabilityResponse } from './capability-rpc.ts'
import { MAX_LOG_BYTES } from './capability-rpc.ts'

/**
 * Serving one capability call.
 *
 * The order is: authorize, then act. The broker never holds a Discord credential open across an
 * unauthorized call — `dispatch` resolves the auth profile itself, and it is only reached once the
 * grant check has passed.
 */

export interface ExecutionScope {
  readonly credential: CapabilityCredential
  readonly appendLog: (line: string) => Effect.Effect<void>
}

const denied = (id: string, message: string, suggestion?: string): CapabilityResponse => ({
  id,
  ok: false,
  denied: true,
  message,
  ...(suggestion === undefined ? {} : { suggestion }),
})

const failed = (id: string, message: string): CapabilityResponse => ({
  id,
  ok: false,
  denied: false,
  message,
})

export class CapabilityServer extends Context.Service<
  CapabilityServer,
  {
    readonly handle: (input: {
      readonly request: CapabilityRequest
      readonly scope: ExecutionScope
      readonly now: number
    }) => Effect.Effect<CapabilityResponse>
  }
>()('workflow-runtime/CapabilityServer') {
  static readonly layer = Layer.effect(CapabilityServer)(
    Effect.gen(function* () {
      const broker = yield* CapabilityBroker
      const catalog = yield* OperationCatalog
      const db = yield* Database
      // Captured once. A workflow's Discord call runs against the same REST client, auth profiles,
      // and catalog the MCP tools use — one rate-limit view, one credential store, one classifier.
      const discordServices = yield* Effect.context<
        AuthProfiles | DiscordRest | OperationCatalog | PreviewTokens
      >()

      const runDiscord = (
        id: string,
        call: Extract<CapabilityRequest['call'], { kind: 'discord' }>,
      ) =>
        Effect.gen(function* () {
          const result = yield* Effect.result(
            dispatch(
              {
                operationId: call.operationId,
                authProfile: call.authProfile ?? 'bot',
                path: call.path ?? {},
                query: call.query ?? {},
                ...(call.body === undefined ? {} : { body: call.body }),
              },
              // A workflow has no user to show a preview to. Its grant is the approval, decided by
              // an operator before the workflow ever ran, which is a stronger check than a token
              // minted seconds earlier by the same automated caller.
              {
                allowed: ['read', 'write', 'destructive', 'bot_admin'],
                requirePreviewToken: false,
              },
            ),
          ).pipe(Effect.provide(discordServices))

          return result._tag === 'Success'
            ? ({ id, ok: true as const, result: result.success.data } satisfies CapabilityResponse)
            : failed(id, String(result.failure.message ?? 'The Discord call failed.'))
        })

      const runKv = (
        id: string,
        credential: CapabilityCredential,
        call: Extract<CapabilityRequest['call'], { kind: 'kv' }>,
        now: number,
      ) =>
        Effect.gen(function* () {
          switch (call.op) {
            case 'get': {
              const rows = yield* db.query<{ value_json: string; expires_at: number | null }>(
                'SELECT value_json, expires_at FROM workflow_kv WHERE workflow_id = ? AND key = ?',
                [credential.workflowId, call.key],
              )
              const row = rows[0]
              // An expired row still exists until cleanup runs; treating it as present would make
              // the TTL advisory.
              const live = row !== undefined && (row.expires_at === null || row.expires_at > now)
              return {
                id,
                ok: true as const,
                result: live && row !== undefined ? JSON.parse(row.value_json) : undefined,
              } satisfies CapabilityResponse
            }
            case 'set': {
              yield* db.execute(
                `INSERT INTO workflow_kv (workflow_id, key, value_json, updated_at, expires_at)
                 VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT (workflow_id, key)
                 DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at, expires_at = excluded.expires_at`,
                [
                  credential.workflowId,
                  call.key,
                  JSON.stringify(call.value ?? null),
                  now,
                  call.ttlSeconds === undefined ? null : now + call.ttlSeconds * 1000,
                ],
              )
              return { id, ok: true as const, result: null } satisfies CapabilityResponse
            }
            case 'delete': {
              yield* db.execute('DELETE FROM workflow_kv WHERE workflow_id = ? AND key = ?', [
                credential.workflowId,
                call.key,
              ])
              return { id, ok: true as const, result: null } satisfies CapabilityResponse
            }
          }
        }).pipe(
          Effect.catch((cause) =>
            Effect.succeed(failed(id, `Workflow storage failed: ${cause.message}`)),
          ),
        )

      const runHttp = (id: string, call: Extract<CapabilityRequest['call'], { kind: 'http' }>) =>
        Effect.map(
          Effect.result(
            Effect.tryPromise({
              try: async (signal) => {
                const response = await fetch(call.url, {
                  method: call.method ?? 'GET',
                  ...(call.headers === undefined ? {} : { headers: call.headers }),
                  ...(call.body === undefined ? {} : { body: call.body }),
                  signal,
                })
                return {
                  status: response.status,
                  body: (await response.text()).slice(0, MAX_LOG_BYTES),
                }
              },
              catch: (cause) => new Error(String(cause)),
            }),
          ),
          (result) =>
            result._tag === 'Success'
              ? ({ id, ok: true as const, result: result.success } satisfies CapabilityResponse)
              : failed(id, `The outbound request failed: ${result.failure.message}`),
        )

      return {
        handle: ({ request, scope, now }) =>
          Effect.gen(function* () {
            const call = request.call

            if (call.kind === 'finish') {
              return { id: request.id, ok: true as const, result: call.result }
            }

            const decision = yield* broker.authorize({
              token: request.credential,
              kind: call.kind,
              now,
              ...(call.kind === 'http' ? { url: call.url } : {}),
              ...(call.kind === 'discord' ? yield* discordFacts(catalog, call) : {}),
            })

            if (!decision.allowed) return denied(request.id, decision.reason)

            switch (call.kind) {
              case 'discord':
                return yield* runDiscord(request.id, call)
              case 'http':
                return yield* runHttp(request.id, call)
              case 'kv':
                return yield* runKv(request.id, scope.credential, call, now)
              case 'log':
                return yield* Effect.as(scope.appendLog(`[${call.level}] ${call.message}`), {
                  id: request.id,
                  ok: true as const,
                  result: null,
                })
            }
          }),
      }
    }),
  )
}

/**
 * The facts the grant check needs about a Discord call.
 *
 * Taken from the catalog and the call's own path parameters, never from the workflow: a workflow
 * that could declare its own operation family would be deciding what it is allowed to do.
 */
const discordFacts = (
  catalog: OperationCatalog['Service'],
  call: Extract<CapabilityRequest['call'], { kind: 'discord' }>,
) =>
  Effect.map(Effect.result(catalog.get(call.operationId)), (result) => {
    if (result._tag === 'Failure') {
      // An unknown operation has no family, so no grant can match it and the broker denies.
      return {
        operationId: call.operationId,
        operationFamily: '(unknown)',
        risk: 'destructive' as const,
      }
    }
    const op = result.success
    const path = call.path ?? {}
    return {
      operationId: op.operationId,
      operationFamily: op.family,
      risk: op.risk,
      ...(path.guild_id === undefined ? {} : { guildId: path.guild_id }),
      ...(path.channel_id === undefined ? {} : { channelId: path.channel_id }),
      ...(call.authProfile === undefined ? {} : { authProfile: call.authProfile }),
    }
  })
