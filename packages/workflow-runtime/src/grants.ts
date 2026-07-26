import type { WorkflowGrant } from '@discord-mcp/workflow-sdk'

/**
 * Grant matching — what the capability broker checks on every call.
 *
 * The rule that shapes everything here: **an empty target list means no access.** The usual
 * convention is that an empty list means unrestricted, and its failure mode is a workflow reaching
 * every guild because a field was left out of a grant. Inverting it means the failure mode is a
 * workflow that cannot do anything, which is loud and safe.
 */

export type Denial = { readonly allowed: false; readonly reason: string }
export type Decision = { readonly allowed: true } | Denial

const allow: Decision = { allowed: true }
const deny = (reason: string): Denial => ({ allowed: false, reason })

export interface DiscordCallRequest {
  readonly operationId: string
  readonly operationFamily: string
  readonly guildId?: string
  readonly channelId?: string
  readonly authProfile?: string
  readonly risk: 'read' | 'write' | 'destructive' | 'bot_admin' | 'credential'
}

export const checkDiscordCall = (grant: WorkflowGrant, request: DiscordCallRequest): Decision => {
  // Credential operations are never exposed to anything, workflow or otherwise.
  if (request.risk === 'credential') {
    return deny(
      `Operation "${request.operationId}" handles credentials and is never callable from a workflow.`,
    )
  }

  if (request.risk === 'bot_admin' && !grant.discord.botAdmin) {
    return deny(
      `Operation "${request.operationId}" changes bot or application configuration, which affects every guild this bot is in. Grant discord.botAdmin explicitly if that is intended.`,
    )
  }

  const byId = grant.discord.operationIds.includes(request.operationId)
  const byFamily = grant.discord.operationFamilies.includes(request.operationFamily)
  if (!byId && !byFamily) {
    return deny(
      `Operation "${request.operationId}" (family "${request.operationFamily}") is not granted. Add it to discord.operationIds or grant the whole family.`,
    )
  }

  // Empty means none. A workflow granted no guilds reaches no guilds.
  if (request.guildId !== undefined && !grant.discord.guildIds.includes(request.guildId)) {
    return deny(
      `Guild ${request.guildId} is not in this revision's granted guilds. An empty guild list grants no guilds, not all of them.`,
    )
  }

  if (request.channelId !== undefined && grant.discord.channelIds.length > 0) {
    // Only enforced when the grant names channels: naming guilds but not channels means the whole
    // guild, which is a distinction a grant author can actually express.
    if (!grant.discord.channelIds.includes(request.channelId)) {
      return deny(`Channel ${request.channelId} is not in this revision's granted channels.`)
    }
  }

  if (
    request.authProfile !== undefined &&
    request.authProfile !== 'bot' &&
    !grant.discord.oauthProfileIds.includes(request.authProfile)
  ) {
    return deny(
      `The OAuth2 profile "${request.authProfile}" is not granted to this revision. A workflow may only use a profile its grant names.`,
    )
  }

  return allow
}

export const checkGatewayEvent = (
  grant: WorkflowGrant,
  event: { readonly type: string; readonly botAuthored: boolean; readonly guildId?: string },
): Decision => {
  if (!grant.gateway.eventTypes.includes(event.type)) {
    return deny(`Event type ${event.type} is not granted to this revision.`)
  }

  // The loop hazard. A workflow that posts a message and reacts to MESSAGE_CREATE triggers itself
  // forever unless self-authored events are excluded by default.
  if (event.botAuthored && !grant.gateway.includeBotAuthoredEvents) {
    return deny(
      'This event was caused by the bot itself. Self-authored events are excluded by default, because a workflow that reacts to its own actions never stops.',
    )
  }

  if (event.guildId !== undefined && !grant.discord.guildIds.includes(event.guildId)) {
    return deny(`Guild ${event.guildId} is not granted to this revision.`)
  }

  return allow
}

export const checkOutboundHttp = (grant: WorkflowGrant, url: string): Decision => {
  let host: string
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return deny(`Only http and https are reachable; "${parsed.protocol}" is not.`)
    }
    host = parsed.hostname
  } catch {
    return deny(`"${url}" is not a valid URL.`)
  }

  return grant.network.allowedOutboundHosts.includes(host)
    ? allow
    : deny(
        `Host "${host}" is not in this revision's allowed outbound hosts. A workflow has no direct network access; every request goes through the broker.`,
      )
}

export const checkCommandPublishing = (
  grant: WorkflowGrant,
  scope: 'guild' | 'global',
): Decision => {
  if (scope === 'global') {
    return grant.interactions.globalCommandPublishing
      ? allow
      : deny(
          'Global command publishing is not granted. A global command appears in every guild this bot is in, so it needs an explicit grant and workflow:admin.',
        )
  }
  return grant.interactions.guildCommandPublishing
    ? allow
    : deny('Guild command publishing is not granted to this revision.')
}

/**
 * A rolling per-minute action budget.
 *
 * Separate from `RateGuard`, which counts *rejections*. This counts everything: a workflow in a
 * tight loop making perfectly valid calls is still a workflow that will exhaust a rate limit and
 * degrade every other user of the same token.
 */
export interface ActionBudget {
  readonly consume: (workflowRevision: string, now: number) => Decision
}

export const makeActionBudget = (grant: WorkflowGrant): ActionBudget => {
  const windows = new Map<string, number[]>()
  const WINDOW_MS = 60_000

  return {
    consume: (key, now) => {
      const recent = (windows.get(key) ?? []).filter((t) => t > now - WINDOW_MS)
      if (recent.length >= grant.discord.maxActionsPerMinute) {
        return deny(
          `This revision has made ${recent.length} Discord calls in the last minute, which is its granted budget. Raise discord.maxActionsPerMinute if the workflow legitimately needs more.`,
        )
      }
      recent.push(now)
      windows.set(key, recent)
      return allow
    },
  }
}

/**
 * Causal depth: how many workflow executions caused this one.
 *
 * A workflow that posts a message, which triggers a workflow, which posts a message, is a cycle
 * that no single check catches. Capping the chain does.
 */
export const checkCausalDepth = (depth: number, max: number): Decision =>
  depth < max
    ? allow
    : deny(
        `Causal depth ${depth} reached the limit of ${max}. A workflow triggered this chain and it is not converging; the execution was stopped rather than allowed to recurse.`,
      )
