import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { Database } from '@discord-mcp/persistence'
import type { RouteAuthentication } from '@discord-mcp/workflow-sdk'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { Schema } from 'effect'
import ipaddr from 'ipaddr.js'

export interface WorkflowRoutePolicy {
  readonly authentication: RouteAuthentication
  readonly allowedHosts: ReadonlyArray<string>
  readonly allowedOrigins: ReadonlyArray<string>
  readonly allowedSourceCidrs: ReadonlyArray<string>
  readonly maxBodyBytes: number
  readonly responseMaxBytes?: number
  readonly requestSchema?: Readonly<Record<string, unknown>>
}

export interface WorkflowRouteRequest {
  readonly method: string
  readonly path: string
  readonly host: string
  readonly origin?: string
  readonly peerAddress: string
  readonly headers: Readonly<Record<string, string | undefined>>
  readonly rawBody: Uint8Array
}

export interface WorkflowRouteResponse {
  readonly status: number
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: Uint8Array | string
}

export interface RouteSecretResolver {
  resolve(reference: string, workflowId: string): Promise<string>
}

export interface WorkflowRouteInvoker {
  invoke(input: {
    readonly workflowId: string
    readonly revision: number
    readonly method: string
    readonly relativePath: string
    readonly rawBody: Uint8Array
    readonly headers: Readonly<Record<string, string | undefined>>
  }): Promise<WorkflowRouteResponse>
}

export class RoutePolicyError extends Schema.TaggedErrorClass<RoutePolicyError>()(
  'RoutePolicyError',
  { message: Schema.String },
) {
  constructor(message: string) {
    super({ message })
  }
}

interface RouteRow {
  readonly [key: string]: unknown
  readonly workflow_id: string
  readonly revision: number
  readonly method: string
  readonly path: string
  readonly policy_json: string
}

const safeEqual = (left: string, right: string): boolean => {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

const inCidrs = (address: string, cidrs: ReadonlyArray<string>): boolean => {
  if (cidrs.length === 0) return false
  const parsed = ipaddr.process(address)
  return cidrs.some((cidr) => {
    const [range, bits] = ipaddr.parseCIDR(cidr)
    return range.kind() === parsed.kind() && parsed.match(range, bits)
  })
}

export class WorkflowRouteRegistry {
  constructor(
    readonly database: Database,
    readonly secrets: RouteSecretResolver,
    readonly invoker: WorkflowRouteInvoker,
    readonly now = () => Date.now(),
    readonly observer: {
      readonly authenticationFailed?: (event: {
        readonly workflowId: string
        readonly authenticationType: RouteAuthentication['type']
      }) => void
    } = {},
  ) {}

  register(input: {
    readonly workflowId: string
    readonly revision: number
    readonly method: string
    readonly path: string
    readonly policy: WorkflowRoutePolicy
    readonly publicRouteGranted: boolean
  }): void {
    if (!/^(?:GET|POST|PUT|PATCH|DELETE)$/.test(input.method)) {
      throw new RoutePolicyError('workflow route method is invalid')
    }
    if (
      !input.path.startsWith('/') ||
      input.path.includes('..') ||
      input.path.startsWith('/mcp') ||
      input.path.startsWith('/discord/') ||
      input.path.startsWith('/oauth/') ||
      input.path.startsWith('/health/') ||
      input.path.startsWith('/metrics') ||
      input.path.startsWith('/.well-known/')
    ) {
      throw new RoutePolicyError('workflow route path is invalid or reserved')
    }
    if (input.policy.authentication.type === 'none' && !input.publicRouteGranted) {
      throw new RoutePolicyError('unauthenticated workflow routes require an explicit public grant')
    }
    if (input.policy.maxBodyBytes < 1 || input.policy.maxBodyBytes > 10 * 1024 * 1024) {
      throw new RoutePolicyError('workflow route body limit is invalid')
    }
    this.database.run(
      `INSERT INTO workflow_routes(workflow_id, revision, method, path, policy_json)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(workflow_id, revision, method, path)
       DO UPDATE SET policy_json = excluded.policy_json`,
      input.workflowId,
      input.revision,
      input.method,
      input.path,
      JSON.stringify(input.policy),
    )
  }

  getBodyLimit(method: string, path: string): number {
    const row = this.#find(method, path)
    const policy = JSON.parse(row.policy_json) as WorkflowRoutePolicy
    return policy.maxBodyBytes
  }

  preflight(input: {
    readonly path: string
    readonly requestedMethod: string
    readonly host: string
    readonly origin: string
    readonly peerAddress: string
  }): WorkflowRouteResponse {
    const row = this.#find(input.requestedMethod, input.path)
    const policy = JSON.parse(row.policy_json) as WorkflowRoutePolicy
    if (!policy.allowedHosts.includes(input.host))
      throw new RoutePolicyError('route host is not allowed')
    if (!policy.allowedOrigins.includes(input.origin)) {
      throw new RoutePolicyError('route origin is not allowed')
    }
    if (!inCidrs(input.peerAddress, policy.allowedSourceCidrs)) {
      throw new RoutePolicyError('route source address is not allowed')
    }
    return {
      status: 204,
      headers: {
        'access-control-allow-origin': input.origin,
        'access-control-allow-methods': input.requestedMethod,
        'access-control-allow-headers':
          'content-type,authorization,x-api-key,x-discord-mcp-timestamp,x-discord-mcp-signature',
        'access-control-max-age': '600',
        vary: 'Origin',
      },
    }
  }

  async handle(request: WorkflowRouteRequest): Promise<WorkflowRouteResponse> {
    const row = this.#find(request.method, request.path)
    const match = /^\/workflows\/([a-z][a-z0-9-]{0,62})(\/.*)$/.exec(request.path)
    const relativePath = match?.[2]
    if (!relativePath) throw new RoutePolicyError('invalid workflow route')
    const policy = JSON.parse(row.policy_json) as WorkflowRoutePolicy
    if (!policy.allowedHosts.includes(request.host))
      throw new RoutePolicyError('route host is not allowed')
    if (!inCidrs(request.peerAddress, policy.allowedSourceCidrs)) {
      throw new RoutePolicyError('route source address is not allowed')
    }
    if (request.rawBody.byteLength > policy.maxBodyBytes) {
      throw new RoutePolicyError('workflow route body exceeds its limit')
    }
    const originAllowed =
      request.origin === undefined || policy.allowedOrigins.includes(request.origin)
    if (request.origin !== undefined && !originAllowed) {
      throw new RoutePolicyError('route origin is not allowed')
    }
    try {
      await this.#authenticate(row.workflow_id, policy.authentication, request)
    } catch (cause) {
      this.observer.authenticationFailed?.({
        workflowId: row.workflow_id,
        authenticationType: policy.authentication.type,
      })
      throw cause
    }
    if (policy.requestSchema) {
      let value: unknown
      try {
        value =
          request.rawBody.byteLength === 0
            ? undefined
            : JSON.parse(Buffer.from(request.rawBody).toString('utf8'))
      } catch {
        throw new RoutePolicyError('workflow route request body must be valid JSON')
      }
      const validator = new Ajv2020({ allErrors: true, strict: false }).compile(
        policy.requestSchema,
      )
      if (!validator(value)) {
        throw new RoutePolicyError(
          `workflow route request schema failed: ${(validator.errors ?? [])
            .map((error) => `${error.instancePath || '/'} ${error.message}`)
            .join('; ')}`,
        )
      }
    }
    const result = await this.invoker.invoke({
      workflowId: row.workflow_id,
      revision: row.revision,
      method: request.method,
      relativePath,
      rawBody: request.rawBody,
      headers: request.headers,
    })
    if (!Number.isInteger(result.status) || result.status < 100 || result.status > 599) {
      throw new RoutePolicyError('workflow returned an invalid HTTP status')
    }
    const bodyBytes =
      typeof result.body === 'string'
        ? Buffer.byteLength(result.body)
        : (result.body?.byteLength ?? 0)
    if (bodyBytes > (policy.responseMaxBytes ?? 1_048_576)) {
      throw new RoutePolicyError('workflow route response exceeds its limit')
    }
    const headers = { ...(result.headers ?? {}) }
    for (const name of Object.keys(headers)) {
      if (/^(?:connection|transfer-encoding|content-length)$/i.test(name)) {
        throw new RoutePolicyError(`workflow response header ${name} is prohibited`)
      }
    }
    if (request.origin !== undefined && originAllowed) {
      headers['access-control-allow-origin'] = request.origin
      headers.vary = 'Origin'
    }
    return { ...result, headers }
  }

  #find(method: string, path: string): RouteRow {
    const match = /^\/workflows\/([a-z][a-z0-9-]{0,62})(\/.*)$/.exec(path)
    if (!match) throw new RoutePolicyError('not a workflow route')
    const slug = match[1]
    const relativePath = match[2]
    if (!slug || !relativePath) throw new RoutePolicyError('invalid workflow route')
    const row = this.database.get<RouteRow>(
      `SELECT r.* FROM workflow_routes r
       JOIN workflows w ON w.id = r.workflow_id AND w.enabled_revision = r.revision
       WHERE w.slug = ? AND r.method = ? AND r.path = ? AND w.deleted_at IS NULL`,
      slug,
      method,
      relativePath,
    )
    if (!row) throw new RoutePolicyError('workflow route does not exist or is disabled')
    return row
  }

  async #authenticate(
    workflowId: string,
    authentication: RouteAuthentication,
    request: WorkflowRouteRequest,
  ): Promise<void> {
    if (authentication.type === 'none') return
    const secret = await this.secrets.resolve(authentication.secretRef, workflowId)
    if (authentication.type === 'apiKey') {
      if (!safeEqual(request.headers['x-api-key'] ?? '', secret)) {
        throw new RoutePolicyError('invalid route API key')
      }
      return
    }
    if (authentication.type === 'bearer') {
      if (!safeEqual(request.headers.authorization ?? '', `Bearer ${secret}`)) {
        throw new RoutePolicyError('invalid route bearer token')
      }
      return
    }
    const timestamp = request.headers['x-discord-mcp-timestamp']
    const signature = request.headers['x-discord-mcp-signature']
    const timestampMs = Number(timestamp) * 1_000
    if (
      !timestamp ||
      !signature ||
      !Number.isFinite(timestampMs) ||
      Math.abs(this.now() - timestampMs) > 5 * 60_000
    ) {
      throw new RoutePolicyError('invalid or stale route HMAC timestamp')
    }
    const expected = createHmac('sha256', secret)
      .update(timestamp)
      .update('.')
      .update(request.rawBody)
      .digest('hex')
    if (!safeEqual(signature, expected)) throw new RoutePolicyError('invalid route HMAC signature')
    const replayId = createHash('sha256')
      .update(`${workflowId}:${timestamp}:${signature}`)
      .digest('hex')
    try {
      this.database.run(
        'INSERT INTO webhook_replay_protection(replay_id, expires_at) VALUES (?, ?)',
        replayId,
        new Date(this.now() + 10 * 60_000).toISOString(),
      )
    } catch {
      throw new RoutePolicyError('route HMAC request was already used')
    }
  }
}
