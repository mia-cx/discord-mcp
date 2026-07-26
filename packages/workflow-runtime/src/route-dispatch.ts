import { randomUUID } from 'node:crypto'
import { SecretStore } from '@discord-mcp/auth'
import { Context, Effect, Layer, Redacted } from 'effect'
import { CapabilityBroker } from './broker.ts'
import type { CapabilityServer } from './capability-server.ts'
import { CapabilitySockets } from './capability-socket.ts'
import { WorkflowRepository } from './repository.ts'
import { RouteRegistry } from './route-registry.ts'
import {
  authenticateRoute,
  checkRoutePolicy,
  checkWorkflowResponse,
  parseMountedPath,
  type RequestFacts,
} from './routes.ts'
import { SandboxSupervisor } from './sandbox.ts'

/**
 * Serving one public workflow request.
 *
 * The order below is the point of this module: host, then source address, then body size, then
 * authentication, and only then the workflow. Each step is cheaper than the one after it, and each
 * one that runs late is one an unauthenticated stranger gets to spend the server's resources on.
 */

export interface WorkflowHttpResponse {
  readonly status: number
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
}

export interface IncomingRouteRequest extends RequestFacts {
  /** The bytes exactly as received. Re-serialising before verifying breaks the signature. */
  readonly rawBody: string
  /** Present only when a trusted proxy identified the client. */
  readonly trustedSourceIp: string | undefined
  readonly now: number
}

const problem = (status: number, reason: string): WorkflowHttpResponse => ({
  status,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ error: reason }),
})

export class WorkflowRoutes extends Context.Service<
  WorkflowRoutes,
  {
    /** Returns undefined when no workflow route matches, so the caller can 404 as it likes. */
    readonly handle: (
      request: IncomingRouteRequest,
    ) => Effect.Effect<WorkflowHttpResponse | undefined>
  }
>()('workflow-runtime/WorkflowRoutes') {
  static readonly layer = Layer.effect(WorkflowRoutes)(
    Effect.gen(function* () {
      const registry = yield* RouteRegistry
      const repository = yield* WorkflowRepository
      const broker = yield* CapabilityBroker
      const sockets = yield* CapabilitySockets
      const supervisor = yield* SandboxSupervisor
      const secrets = yield* SecretStore
      // Captured so `handle` needs nothing from its caller's context: it is invoked from the HTTP
      // server, which has no Effect environment of its own.
      const capability = yield* Effect.context<CapabilityServer>()

      return {
        handle: (request) =>
          Effect.gen(function* () {
            const mounted = parseMountedPath(request.path)
            if (mounted === undefined) return undefined

            const route = yield* Effect.orElseSucceed(
              registry.resolve({ method: request.method, path: request.path }),
              () => undefined,
            )
            if (route === undefined) return undefined

            const grant = yield* Effect.orElseSucceed(
              repository.getGrant(route.workflowId, route.revision),
              () => undefined,
            )
            if (grant === undefined) {
              // A route without a grant belongs to a revision nobody approved. It should not have
              // been registered, and serving it would be worse than admitting the inconsistency.
              return problem(503, 'This route is not currently served.')
            }

            if (!grant.routes.public) {
              return problem(
                404,
                'This route is not public. Grant routes.public to expose it, and choose an authentication scheme deliberately.',
              )
            }

            const policy = checkRoutePolicy({
              grant,
              request,
              trustedSourceIp: request.trustedSourceIp,
            })
            if (!policy.allowed) return problem(policy.status, policy.reason)

            const authenticated = yield* authenticate(request, route, secrets, registry)
            if (!authenticated.allowed) return problem(authenticated.status, authenticated.reason)

            const outcome = yield* runHandler({
              broker,
              sockets,
              supervisor,
              repository,
              route,
              grant,
              request,
            }).pipe(Effect.provide(capability))

            const rejection = checkWorkflowResponse(outcome)
            if (rejection !== undefined) {
              // The workflow produced something that is not safe to return. Its own logs carry the
              // detail; the caller gets no useful signal from a handler that misbehaved.
              return problem(500, 'The workflow returned a response this server will not send.')
            }

            return policy.corsOrigin === undefined
              ? outcome
              : {
                  ...outcome,
                  headers: {
                    ...outcome.headers,
                    // Added after the decision, never as part of it.
                    'access-control-allow-origin': policy.corsOrigin,
                    vary: 'Origin',
                  },
                }
          }),
      }
    }),
  )
}

const authenticate = (
  request: IncomingRouteRequest,
  route: { readonly id: string; readonly auth: Parameters<typeof authenticateRoute>[0]['auth'] },
  secrets: SecretStore['Service'],
  registry: RouteRegistry['Service'],
) =>
  Effect.gen(function* () {
    // Resolved before the check so the comparison itself is synchronous and constant-time; an
    // async lookup inside the comparison would leak whether the secret exists through timing.
    const reference = 'secretRef' in route.auth ? route.auth.secretRef : undefined
    const resolved =
      reference === undefined
        ? undefined
        : yield* Effect.orElseSucceed(secrets.get(reference), () => undefined)

    const replayClaims = new Map<string, boolean>()
    const signature = request.headers['x-signature']
    if (signature !== undefined) {
      const claimed = yield* Effect.orElseSucceed(
        registry.claimReplayId({ routeId: route.id, replayId: signature, now: request.now }),
        () => false,
      )
      replayClaims.set(signature, !claimed)
    }

    return authenticateRoute({
      auth: route.auth,
      headers: request.headers,
      rawBody: request.rawBody,
      now: request.now,
      secret: (name) =>
        name === reference && resolved !== undefined ? Redacted.value(resolved) : undefined,
      seenReplayId: (id) => replayClaims.get(id) ?? false,
    })
  })

/**
 * Run the workflow and turn whatever it returns into an HTTP response.
 *
 * A handler that fails, times out, or returns nothing usable becomes a 502 rather than a 500: the
 * control plane is working, the thing behind it is not, and the distinction matters to whoever is
 * looking at the logs.
 */
const runHandler = (input: {
  readonly broker: CapabilityBroker['Service']
  readonly sockets: CapabilitySockets['Service']
  readonly supervisor: SandboxSupervisor['Service']
  readonly repository: WorkflowRepository['Service']
  readonly route: {
    readonly workflowId: string
    readonly revision: number
    readonly triggerIndex: number
  }
  readonly grant: { readonly runtime: { readonly timeoutSeconds: number } }
  readonly request: IncomingRouteRequest
}) =>
  Effect.gen(function* () {
    const executionId = yield* Effect.orElseSucceed(
      input.repository.recordExecution({
        workflowId: input.route.workflowId,
        revision: input.route.revision,
        triggerKind: 'http',
        correlationId: randomUUID(),
        causalDepth: 0,
      }),
      () => randomUUID(),
    )

    const credential = yield* input.broker.issue({
      workflowId: input.route.workflowId,
      revision: input.route.revision,
      executionId,
      grant: input.grant as never,
      causalDepth: 0,
      now: input.request.now,
    })

    const socket = yield* input.sockets.open(credential)

    const result = yield* Effect.result(
      Effect.ensuring(
        input.supervisor.run({
          workflowId: input.route.workflowId,
          revision: input.route.revision,
          executionId,
          capabilityCredential: credential.token,
          payload: {
            index: input.route.triggerIndex,
            input: {
              method: input.request.method,
              path: input.request.path,
              headers: redactHeaders(input.request.headers),
              request: input.request.rawBody,
            },
          },
          timeoutSeconds: input.grant.runtime.timeoutSeconds,
        }),
        Effect.andThen(socket.close(), input.broker.revoke(credential.token)),
      ),
    )

    if (result._tag === 'Failure') {
      yield* Effect.orElseSucceed(
        input.repository.finishExecution({
          executionId,
          status: 'failed',
          error: result.failure.message,
          logs: socket.logs(),
        }),
        () => undefined,
      )
      return problem(502, 'The workflow behind this route could not be run.')
    }

    const status = result.success.timedOut
      ? 'timeout'
      : result.success.exitCode === 0
        ? 'succeeded'
        : 'failed'

    yield* Effect.orElseSucceed(
      input.repository.finishExecution({
        executionId,
        status,
        logs: `${socket.logs()}${result.success.logs}`,
      }),
      () => undefined,
    )

    if (status !== 'succeeded') {
      return problem(
        504,
        status === 'timeout'
          ? 'The workflow behind this route did not finish in time.'
          : 'The workflow behind this route failed.',
      )
    }

    // What the handler returned through `Http.json`, or an empty object if it returned nothing.
    // A handler that finished without reporting a result still succeeded; it simply has no body.
    const returned = socket.result()
    const shaped =
      typeof returned === 'object' && returned !== null && 'status' in returned
        ? (returned as { status: number; body: unknown })
        : { status: 200, body: returned ?? {} }

    return {
      status: shaped.status,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(shaped.body ?? {}),
    }
  })

/**
 * What a handler is told about the request that reached it.
 *
 * Authorization headers are removed: the route already authenticated the caller, and a workflow
 * that could read the credential could replay it against something else.
 */
const REDACTED_REQUEST_HEADERS: ReadonlyArray<string> = [
  'authorization',
  'cookie',
  'x-api-key',
  'x-signature',
]

const redactHeaders = (
  headers: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> =>
  Object.fromEntries(
    Object.entries(headers).filter(
      ([name]) => !REDACTED_REQUEST_HEADERS.includes(name.toLowerCase()),
    ),
  )
