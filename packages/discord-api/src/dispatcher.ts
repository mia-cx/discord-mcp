import { createHash, randomBytes } from 'node:crypto'
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js'
import formatsPlugin from 'ajv-formats'
import { Effect, Schema } from 'effect'
import {
  type CatalogOperation,
  type OperationAuth,
  type OperationRisk,
  operationCatalog,
} from './catalog.js'
import schemasJson from './generated/schemas.json' with { type: 'json' }
import type { DiscordRestClient } from './rest.js'

export interface DispatchFile {
  readonly blobId?: string
  /** Internal capability-broker path. Never exposed by the MCP dispatch schemas. */
  readonly data?: Uint8Array
  readonly filename?: string
  readonly contentType?: string
}

export interface DispatchBlobResolver {
  read(
    blobId: string,
    principalId: string,
  ): Promise<{
    readonly data: Uint8Array
    readonly filename: string
    readonly contentType?: string
  }>
}

export interface DispatchAuthResolver {
  resolve(
    profileId: string,
    principalId: string,
    authMode: OperationAuth,
  ): Promise<DiscordRestClient>
}

export interface DispatchSecretResolver {
  resolve(reference: string, principalId: string): Promise<string>
}

export interface DispatchInput {
  readonly operationId: string
  readonly authProfile?: string
  readonly authMode?: OperationAuth
  readonly path?: Readonly<Record<string, string>>
  readonly query?: Readonly<Record<string, unknown>>
  readonly body?: unknown
  readonly secretRefs?: Readonly<Record<string, string>>
  readonly auditLogReason?: string
  readonly previewToken?: string
  readonly files?: ReadonlyArray<DispatchFile>
}

export class DispatchValidationError extends Schema.TaggedErrorClass<DispatchValidationError>()(
  'DispatchValidationError',
  { message: Schema.String },
) {
  constructor(message: string) {
    super({ message })
  }
}

interface PreviewRecord {
  readonly token: string
  readonly principalId: string
  readonly operationId: string
  readonly argumentsDigest: string
  readonly authProfile: string
  readonly expiresAt: number
}

export interface OperationPreviewStore {
  issue(
    principalId: string,
    operation: CatalogOperation,
    input: DispatchInput,
    now?: number,
  ): string
  consume(
    token: string | undefined,
    principalId: string,
    operation: CatalogOperation,
    input: DispatchInput,
    now?: number,
  ): void
}

export class OperationPreviews implements OperationPreviewStore {
  readonly #records = new Map<string, PreviewRecord>()

  issue(
    principalId: string,
    operation: CatalogOperation,
    input: DispatchInput,
    now = Date.now(),
  ): string {
    const token = randomBytes(32).toString('base64url')
    this.#records.set(token, {
      token,
      principalId,
      operationId: operation.operationId,
      argumentsDigest: dispatchDigest(input),
      authProfile: input.authProfile ?? 'bot',
      expiresAt: now + 60_000,
    })
    return token
  }

  consume(
    token: string | undefined,
    principalId: string,
    operation: CatalogOperation,
    input: DispatchInput,
    now = Date.now(),
  ): void {
    if (!token)
      throw new DispatchValidationError('A preview token is required; preview this call first')
    const record = this.#records.get(token)
    this.#records.delete(token)
    if (!record || record.expiresAt <= now) {
      throw new DispatchValidationError('Preview token is missing, expired, or already used')
    }
    if (
      record.principalId !== principalId ||
      record.operationId !== operation.operationId ||
      record.argumentsDigest !== dispatchDigest(input) ||
      record.authProfile !== (input.authProfile ?? 'bot')
    ) {
      throw new DispatchValidationError('Preview token does not match this exact call')
    }
  }
}

const normalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(normalize)
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== 'previewToken')
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, normalize(child)]),
    )
  }
  return value
}

const dispatchDigest = (input: DispatchInput): string =>
  createHash('sha256')
    .update(JSON.stringify(normalize(input)))
    .digest('hex')

const ajv = new Ajv2020({ allErrors: true, strict: false })
const addFormats = formatsPlugin as unknown as (instance: Ajv2020) => Ajv2020
addFormats(ajv)
ajv.addFormat('snowflake', /^\d{17,21}$/)
ajv.addFormat('nonce', /^[A-Za-z0-9._~-]+$/)
const validators = new Map<string, ValidateFunction>()

const bodyValidator = (
  operation: CatalogOperation,
  contentType: string,
): ValidateFunction | undefined => {
  const schema = operation.body[contentType]
  if (!schema) return undefined
  const key = `${operation.operationId}\0${contentType}`
  const existing = validators.get(key)
  if (existing) return existing
  const compiled = ajv.compile({
    ...schema,
    components: { schemas: schemasJson },
  })
  validators.set(key, compiled)
  return compiled
}

const parameterValidator = (
  operation: CatalogOperation,
  parameter: CatalogOperation['parameters'][number],
): ValidateFunction => {
  const key = `${operation.operationId}\0${parameter.in}\0${parameter.name}`
  const existing = validators.get(key)
  if (existing) return existing
  const compiled = ajv.compile({
    ...parameter.schema,
    components: { schemas: schemasJson },
  })
  validators.set(key, compiled)
  return compiled
}

const renderAjv = (errors: ReadonlyArray<ErrorObject> | null | undefined): string =>
  (errors ?? [])
    .map((error) => `${error.instancePath || '/'}: ${error.message ?? error.keyword}`)
    .join('; ')

const stringifyQueryValue = (value: unknown): string => {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  throw new DispatchValidationError('Query values must be strings, numbers, or booleans')
}

const queryParameters = (query: Readonly<Record<string, unknown>>): URLSearchParams => {
  const output = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (Array.isArray(value)) {
      for (const item of value) output.append(key, stringifyQueryValue(item))
    } else {
      output.append(key, stringifyQueryValue(value))
    }
  }
  return output
}

const bodyForValidation = (body: unknown, multipart: boolean): unknown => {
  if (!multipart || typeof body !== 'object' || body === null || Array.isArray(body)) return body
  const record = body as Readonly<Record<string, unknown>>
  if (!Array.isArray(record.attachments)) return body
  return {
    ...record,
    // Discord multipart upload descriptors use a zero-based numeric id even though the
    // preview OpenAPI component currently declares a Snowflake string.
    attachments: record.attachments.map((attachment) =>
      typeof attachment === 'object' &&
      attachment !== null &&
      !Array.isArray(attachment) &&
      typeof (attachment as Readonly<Record<string, unknown>>).id === 'number'
        ? {
            ...(attachment as Readonly<Record<string, unknown>>),
            // Validate the rest of the descriptor against the preview schema while preserving
            // the actual zero-based numeric id in the outbound body.
            id: '10000000000000000',
          }
        : attachment,
    ),
  }
}

export class DiscordDispatcher {
  constructor(
    readonly rest: DiscordRestClient,
    readonly previews: OperationPreviewStore = new OperationPreviews(),
    readonly blobs?: DispatchBlobResolver,
    readonly authProfiles?: DispatchAuthResolver,
    readonly secrets?: DispatchSecretResolver,
  ) {}

  preview(
    principalId: string,
    input: DispatchInput,
  ): {
    readonly operation: CatalogOperation
    readonly normalized: { route: string; query: Readonly<Record<string, unknown>>; body: unknown }
    readonly previewToken?: string
    readonly expiresInMs?: number
  } {
    const operation = operationCatalog.describe(input.operationId)
    if (operation.risk === 'credential') {
      throw new DispatchValidationError(
        `${operation.operationId} is credential-sensitive and is available only through a dedicated service`,
      )
    }
    const normalized = this.#validate(operation, input)
    const guarded = operation.risk === 'destructive' || operation.risk === 'bot_admin'
    return {
      operation,
      normalized,
      ...(guarded
        ? {
            previewToken: this.previews.issue(principalId, operation, input),
            expiresInMs: 60_000,
          }
        : {}),
    }
  }

  dispatch<A>(
    principalId: string,
    expectedRisk: OperationRisk,
    input: DispatchInput,
  ): Effect.Effect<A, unknown> {
    const operation = operationCatalog.describe(input.operationId)
    if (operation.risk === 'credential') {
      throw new DispatchValidationError(
        `${operation.operationId} is credential-sensitive and is available only through a dedicated service`,
      )
    }
    if (operation.risk !== expectedRisk) {
      throw new DispatchValidationError(
        `${operation.operationId} is ${operation.risk}, not ${expectedRisk}; use the matching dispatcher`,
      )
    }
    const normalized = this.#validate(operation, input)
    if (operation.risk === 'destructive' || operation.risk === 'bot_admin') {
      this.previews.consume(input.previewToken, principalId, operation, input)
    }
    return Effect.flatMap(
      Effect.tryPromise({
        try: async () => {
          const authMode = input.authMode ?? 'bot'
          const client =
            input.authProfile === undefined || input.authProfile === 'bot'
              ? this.rest
              : await this.authProfiles?.resolve(input.authProfile, principalId, authMode)
          if (!client) throw new DispatchValidationError('the selected auth profile is unavailable')
          const files = await Promise.all(
            (input.files ?? []).map(async (file) => {
              if (file.data !== undefined) {
                if (!file.filename) {
                  throw new DispatchValidationError('inline dispatch files require a filename')
                }
                return {
                  data: file.data,
                  name: file.filename,
                  ...(file.contentType === undefined ? {} : { contentType: file.contentType }),
                }
              }
              if (!file.blobId) {
                throw new DispatchValidationError('dispatch files require a blob reference')
              }
              if (!this.blobs) {
                throw new DispatchValidationError('blob-backed attachments are not configured')
              }
              const resolved = await this.blobs.read(file.blobId, principalId)
              return {
                data: resolved.data,
                name: file.filename ?? resolved.filename,
                ...((file.contentType ?? resolved.contentType) === undefined
                  ? {}
                  : { contentType: file.contentType ?? resolved.contentType }),
              }
            }),
          )
          let route = normalized.route
          let body = normalized.body
          for (const parameter of operation.parameters.filter(
            ({ in: location, sensitive }) => location === 'path' && sensitive,
          )) {
            const reference = input.secretRefs?.[parameter.name]
            if (!reference || !this.secrets) {
              throw new DispatchValidationError(
                `sensitive path parameter ${parameter.name} requires a configured named secret reference`,
              )
            }
            const sentinel = encodeURIComponent(`[secret:${parameter.name}:${reference}]`)
            const secret = await this.secrets.resolve(reference, principalId)
            route = route.replace(sentinel, encodeURIComponent(secret))
          }
          if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
            const resolvedBody = { ...(body as Readonly<Record<string, unknown>>) }
            for (const field of operation.sensitiveBodyFields) {
              const reference = input.secretRefs?.[field]
              if (!reference) continue
              if (!this.secrets) {
                throw new DispatchValidationError(
                  `sensitive body field ${field} requires configured named secrets`,
                )
              }
              resolvedBody[field.slice('body.'.length)] = await this.secrets.resolve(
                reference,
                principalId,
              )
            }
            body = resolvedBody
          }
          return { client, files, route, body }
        },
        catch: (cause) => cause,
      }),
      ({ client, files, route, body }) =>
        client.request<A>(operation.method, route, {
          ...(input.authMode === 'webhook' || input.authMode === 'interaction'
            ? { auth: false }
            : {}),
          query: queryParameters(normalized.query),
          ...(body === undefined ? {} : { body }),
          ...(input.auditLogReason === undefined ? {} : { reason: input.auditLogReason }),
          ...(files.length === 0 ? {} : { files }),
        }),
    )
  }

  #validate(
    operation: CatalogOperation,
    input: DispatchInput,
  ): { route: string; query: Readonly<Record<string, unknown>>; body: unknown } {
    const authMode = input.authMode ?? 'bot'
    if (authMode === 'oauth2' && (input.authProfile === undefined || input.authProfile === 'bot')) {
      throw new DispatchValidationError(
        'OAuth2 authentication requires a named OAuth profile; the bot profile is not OAuth2',
      )
    }
    if (authMode !== 'oauth2' && input.authProfile !== undefined && input.authProfile !== 'bot') {
      throw new DispatchValidationError(
        `named OAuth profile ${input.authProfile} requires authMode oauth2`,
      )
    }
    if (!operation.auth.includes(authMode)) {
      throw new DispatchValidationError(
        `${operation.operationId} cannot use ${authMode} authentication; allowed: ${operation.auth.join(', ')}`,
      )
    }
    if (operation.botIncompatible && authMode === 'bot') {
      throw new DispatchValidationError(
        `${operation.operationId} rejects bot tokens; select an OAuth2 profile`,
      )
    }
    const pathInput = input.path ?? {}
    let route = operation.path
    const pathParameters = operation.parameters.filter((parameter) => parameter.in === 'path')
    for (const parameter of pathParameters) {
      const value = pathInput[parameter.name]
      const secretReference = input.secretRefs?.[parameter.name]
      if (parameter.sensitive) {
        if (value !== undefined) {
          throw new DispatchValidationError(
            `${parameter.name} is sensitive; use secretRefs.${parameter.name} instead of path`,
          )
        }
        if (parameter.required && secretReference === undefined) {
          throw new DispatchValidationError(`Missing named secret reference: ${parameter.name}`)
        }
        if (secretReference !== undefined) {
          if (!/^[A-Za-z0-9._:-]{1,128}$/.test(secretReference)) {
            throw new DispatchValidationError(
              `Secret reference ${parameter.name} has an invalid name`,
            )
          }
          route = route.replace(
            `{${parameter.name}}`,
            encodeURIComponent(`[secret:${parameter.name}:${secretReference}]`),
          )
        }
        continue
      }
      if (parameter.required && value === undefined) {
        throw new DispatchValidationError(`Missing path parameter: ${parameter.name}`)
      }
      if (value !== undefined) {
        if (parameter.name.endsWith('_id') && !/^\d{17,21}$/.test(value)) {
          throw new DispatchValidationError(`${parameter.name} must be a Discord snowflake`)
        }
        const validator = parameterValidator(operation, parameter)
        if (!validator(value)) {
          throw new DispatchValidationError(
            `Invalid path parameter ${parameter.name}: ${renderAjv(validator.errors)}`,
          )
        }
        route = route.replace(`{${parameter.name}}`, encodeURIComponent(value))
      }
    }
    const knownPath = new Set(pathParameters.map(({ name }) => name))
    for (const key of Object.keys(pathInput)) {
      if (!knownPath.has(key)) throw new DispatchValidationError(`Unknown path parameter: ${key}`)
    }
    const sensitiveParameters = new Set([
      ...operation.sensitiveBodyFields,
      ...pathParameters.filter(({ sensitive }) => sensitive).map(({ name }) => name),
    ])
    for (const key of Object.keys(input.secretRefs ?? {})) {
      if (!sensitiveParameters.has(key)) {
        throw new DispatchValidationError(`Unknown sensitive parameter reference: ${key}`)
      }
    }
    const query = input.query ?? {}
    const queryDefinitions = operation.parameters.filter((parameter) => parameter.in === 'query')
    const knownQuery = new Set(queryDefinitions.map(({ name }) => name))
    for (const parameter of queryDefinitions) {
      const value = query[parameter.name]
      if (parameter.required && value === undefined) {
        throw new DispatchValidationError(`Missing query parameter: ${parameter.name}`)
      }
      if (value === undefined) continue
      const validator = parameterValidator(operation, parameter)
      if (!validator(value)) {
        throw new DispatchValidationError(
          `Invalid query parameter ${parameter.name}: ${renderAjv(validator.errors)}`,
        )
      }
    }
    for (const key of Object.keys(query)) {
      if (!knownQuery.has(key)) throw new DispatchValidationError(`Unknown query parameter: ${key}`)
      const value = query[key]
      if (Array.isArray(value)) {
        for (const item of value) stringifyQueryValue(item)
      } else {
        stringifyQueryValue(value)
      }
    }
    if (input.auditLogReason !== undefined && !operation.auditLogReason) {
      throw new DispatchValidationError(
        `${operation.operationId} does not accept an audit-log reason`,
      )
    }
    if (
      input.auditLogReason !== undefined &&
      (input.auditLogReason.length < 1 || encodeURIComponent(input.auditLogReason).length > 512)
    ) {
      throw new DispatchValidationError(
        'Audit-log reason must be 1–512 URL-encoded UTF-8 characters',
      )
    }
    let body = input.body
    if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
      const sanitized = { ...(body as Readonly<Record<string, unknown>>) }
      for (const field of operation.sensitiveBodyFields) {
        const key = field.slice('body.'.length)
        if (sanitized[key] !== undefined && sanitized[key] !== null) {
          throw new DispatchValidationError(
            `${field} is sensitive; use secretRefs.${field} instead of body`,
          )
        }
        const reference = input.secretRefs?.[field]
        if (reference !== undefined) {
          if (!/^[A-Za-z0-9._:-]{1,128}$/.test(reference)) {
            throw new DispatchValidationError(`${field} has an invalid secret reference name`)
          }
          sanitized[key] = `[secret:${field}:${reference}]`
        }
      }
      body = sanitized
    }
    if (body !== undefined) {
      const validator =
        (input.files?.length ?? 0) > 0
          ? (bodyValidator(operation, 'multipart/form-data') ??
            bodyValidator(operation, 'application/json'))
          : (bodyValidator(operation, 'application/json') ??
            bodyValidator(operation, 'application/x-www-form-urlencoded') ??
            bodyValidator(operation, 'multipart/form-data'))
      if (!validator) {
        throw new DispatchValidationError(`${operation.operationId} does not accept a request body`)
      }
      if (!validator(bodyForValidation(body, (input.files?.length ?? 0) > 0))) {
        throw new DispatchValidationError(`Invalid request body: ${renderAjv(validator.errors)}`)
      }
    }
    if ((input.files?.length ?? 0) > 10) {
      throw new DispatchValidationError('Discord requests accept at most 10 attached files')
    }
    for (const [index, file] of (input.files ?? []).entries()) {
      if ((file.blobId === undefined) === (file.data === undefined)) {
        throw new DispatchValidationError(
          `File ${index} must contain exactly one internal data source`,
        )
      }
      if (file.data !== undefined && file.data.byteLength > 25 * 1024 * 1024) {
        throw new DispatchValidationError(`File ${index} exceeds the 25 MiB broker limit`)
      }
    }
    if ((input.files?.length ?? 0) > 0 && !operation.body['multipart/form-data']) {
      throw new DispatchValidationError(`${operation.operationId} does not accept multipart files`)
    }
    return { route, query, body }
  }
}
