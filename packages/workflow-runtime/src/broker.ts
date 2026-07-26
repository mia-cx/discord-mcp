import { randomBytes, timingSafeEqual } from 'node:crypto'
import { WORKFLOW_LIMITS, type WorkflowGrant } from '@discord-mcp/workflow-sdk'
import { Context, Effect, Layer, Ref } from 'effect'
import {
  type ActionBudget,
  checkCausalDepth,
  checkDiscordCall,
  checkOutboundHttp,
  type Decision,
  type Denial,
  makeActionBudget,
} from './grants.ts'

/**
 * The capability broker.
 *
 * A workflow container has no Discord credential and no network. It holds one credential that is
 * useless anywhere but here, and every call it makes is checked against its revision's grants
 * before the broker performs the call *on its behalf* — injecting the real credential only for the
 * duration.
 *
 * The credential is revision-specific. A workflow cannot use another revision's, including an
 * earlier revision of itself whose grants were wider.
 */

export interface CapabilityCredential {
  readonly token: string
  readonly workflowId: string
  readonly revision: number
  readonly executionId: string
  readonly expiresAt: number
  readonly causalDepth: number
}

export interface BrokerRequest {
  readonly token: string
  readonly kind: 'discord' | 'http' | 'kv' | 'log'
  readonly operationId?: string
  readonly operationFamily?: string
  readonly guildId?: string
  readonly channelId?: string
  readonly authProfile?: string
  readonly risk?: 'read' | 'write' | 'destructive' | 'bot_admin' | 'credential'
  readonly url?: string
  readonly now: number
}

const constantTimeEquals = (a: string, b: string): boolean => {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

const deny = (reason: string): Denial => ({ allowed: false, reason })
const allow: Decision = { allowed: true }

export interface BrokerState {
  readonly credentials: ReadonlyMap<string, CapabilityCredential>
  readonly grants: ReadonlyMap<string, WorkflowGrant>
  /** Revisions currently enabled. A disabled revision's in-flight calls stop immediately. */
  readonly enabled: ReadonlySet<string>
}

export const revisionKey = (workflowId: string, revision: number) => `${workflowId}:${revision}`

interface Caller {
  readonly credential: CapabilityCredential
  readonly grant: WorkflowGrant
  readonly key: string
}

/**
 * Establish who is calling: credential, expiry, enablement, grant.
 *
 * Separate from the call check because these four are about the caller's standing and hold for
 * every kind of call, while the checks that follow depend on what is being asked for.
 */
const resolveCaller = (state: BrokerState, request: BrokerRequest): Caller | Denial => {
  // Constant-time, so a token cannot be discovered by measuring how long a rejection takes.
  const entry = [...state.credentials.entries()].find(([token]) =>
    constantTimeEquals(token, request.token),
  )
  if (entry === undefined) {
    return deny('The capability credential is unknown, expired, or revoked.')
  }

  const credential = entry[1]
  if (credential.expiresAt <= request.now) {
    return deny(
      'The capability credential has expired. Its execution passed its deadline; any work still in flight is no longer authorized.',
    )
  }

  const key = revisionKey(credential.workflowId, credential.revision)

  // Disabling a workflow stops in-flight calls, not just new dispatch. A handler that was
  // mid-execution when an operator disabled it should not finish acting.
  if (!state.enabled.has(key)) {
    return deny(
      `Revision ${credential.revision} of this workflow is no longer enabled. Disabling stops calls already in flight, not only new dispatch.`,
    )
  }

  const grant = state.grants.get(key)
  return grant === undefined
    ? deny('This revision has no grant. An ungranted revision cannot act at all.')
    : { credential, grant, key }
}

/** Check the call itself, by kind. */
const checkCall = (grant: WorkflowGrant, request: BrokerRequest): Decision => {
  // Storage and logging are scoped to the workflow by construction and need no further check.
  if (request.kind === 'kv' || request.kind === 'log') return allow

  if (request.kind === 'http') {
    return request.url === undefined
      ? deny('No URL supplied.')
      : checkOutboundHttp(grant, request.url)
  }

  if (
    request.operationId === undefined ||
    request.operationFamily === undefined ||
    request.risk === undefined
  ) {
    return deny('A Discord call must name an operation, its family, and its risk class.')
  }

  return checkDiscordCall(grant, {
    operationId: request.operationId,
    operationFamily: request.operationFamily,
    risk: request.risk,
    ...(request.guildId === undefined ? {} : { guildId: request.guildId }),
    ...(request.channelId === undefined ? {} : { channelId: request.channelId }),
    ...(request.authProfile === undefined ? {} : { authProfile: request.authProfile }),
  })
}

export class CapabilityBroker extends Context.Service<
  CapabilityBroker,
  {
    /** Mint a credential for one execution. Expires with the handler's deadline. */
    readonly issue: (input: {
      readonly workflowId: string
      readonly revision: number
      readonly executionId: string
      readonly grant: WorkflowGrant
      readonly causalDepth: number
      readonly now: number
    }) => Effect.Effect<CapabilityCredential>
    /** Every check, in order. Returns a denial with a reason a workflow author can act on. */
    readonly authorize: (request: BrokerRequest) => Effect.Effect<Decision>
    readonly revoke: (token: string) => Effect.Effect<void>
    readonly setEnabled: (
      workflowId: string,
      revision: number,
      enabled: boolean,
    ) => Effect.Effect<void>
  }
>()('workflow-runtime/CapabilityBroker') {
  static readonly layer = Layer.effect(CapabilityBroker)(
    Effect.gen(function* () {
      const state = yield* Ref.make<BrokerState>({
        credentials: new Map(),
        grants: new Map(),
        enabled: new Set(),
      })
      const budgets = new Map<string, ActionBudget>()

      const budgetFor = (key: string, grant: WorkflowGrant) => {
        const existing = budgets.get(key)
        if (existing !== undefined) return existing
        const created = makeActionBudget(grant)
        budgets.set(key, created)
        return created
      }

      return {
        issue: (input) =>
          Effect.gen(function* () {
            const token = randomBytes(32).toString('base64url')
            const key = revisionKey(input.workflowId, input.revision)
            const credential: CapabilityCredential = {
              token,
              workflowId: input.workflowId,
              revision: input.revision,
              executionId: input.executionId,
              // Expires with the handler. A credential that outlived its execution would let a
              // leaked one be replayed by anything that captured it.
              expiresAt: input.now + input.grant.runtime.timeoutSeconds * 1000,
              causalDepth: input.causalDepth,
            }

            yield* Ref.update(state, (s) => ({
              credentials: new Map(s.credentials).set(token, credential),
              grants: new Map(s.grants).set(key, input.grant),
              enabled: new Set(s.enabled).add(key),
            }))

            return credential
          }),

        authorize: (request) =>
          Effect.map(Ref.get(state), (current) => {
            const caller = resolveCaller(current, request)
            if ('reason' in caller) return caller

            const { credential, grant, key } = caller

            const depth = checkCausalDepth(credential.causalDepth, WORKFLOW_LIMITS.maxCausalDepth)
            if (!depth.allowed) return depth

            const call = checkCall(grant, request)
            if (!call.allowed) return call

            // Budget last, and only for Discord: a denied call must not consume one, or a workflow
            // could exhaust its own budget probing for what it may do.
            return request.kind === 'discord'
              ? budgetFor(key, grant).consume(key, request.now)
              : call
          }),

        revoke: (token) =>
          Ref.update(state, (s) => {
            const credentials = new Map(s.credentials)
            credentials.delete(token)
            return { ...s, credentials }
          }),

        setEnabled: (workflowId, revision, enabled) =>
          Ref.update(state, (s) => {
            const key = revisionKey(workflowId, revision)
            const next = new Set(s.enabled)
            if (enabled) next.add(key)
            else next.delete(key)
            return { ...s, enabled: next }
          }),
      }
    }),
  )
}
