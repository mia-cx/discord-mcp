export interface WorkflowGrant {
  readonly discord: {
    readonly operationIds: ReadonlyArray<string>
    readonly operationFamilies: ReadonlyArray<string>
    readonly guildIds: ReadonlyArray<string>
    readonly channelIds: ReadonlyArray<string>
    readonly oauthProfileIds: ReadonlyArray<string>
    readonly botAdmin: boolean
    readonly broadMentions: boolean
    readonly maxActionsPerMinute: number
  }
  readonly gateway: {
    readonly eventTypes: ReadonlyArray<string>
    readonly includeBotAuthoredEvents: boolean
  }
  readonly interactions: {
    readonly guildCommandPublishing: boolean
    readonly globalCommandPublishing: boolean
  }
  readonly routes: {
    readonly public: boolean
    readonly allowedHosts: ReadonlyArray<string>
    readonly allowedOrigins: ReadonlyArray<string>
    readonly allowedSourceCidrs: ReadonlyArray<string>
    readonly maxBodyBytes: number
  }
  readonly network: { readonly allowedOutboundHosts: ReadonlyArray<string> }
  readonly runtime: {
    readonly allowNpmInstallScripts: boolean
    readonly timeoutSeconds: number
    readonly concurrency: number
  }
}

export const defaultWorkflowGrant = (): WorkflowGrant => ({
  discord: {
    operationIds: [],
    operationFamilies: [],
    guildIds: [],
    channelIds: [],
    oauthProfileIds: [],
    botAdmin: false,
    broadMentions: false,
    maxActionsPerMinute: 60,
  },
  gateway: { eventTypes: [], includeBotAuthoredEvents: false },
  interactions: { guildCommandPublishing: false, globalCommandPublishing: false },
  routes: {
    public: false,
    allowedHosts: [],
    allowedOrigins: [],
    allowedSourceCidrs: [],
    maxBodyBytes: 1_048_576,
  },
  network: { allowedOutboundHosts: [] },
  runtime: { allowNpmInstallScripts: false, timeoutSeconds: 30, concurrency: 1 },
})

export interface CompiledWorkflowManifest {
  readonly triggers: ReadonlyArray<Readonly<Record<string, unknown>>>
  readonly requestedGrants?: Readonly<Record<string, unknown>>
}

export interface WorkflowBuildResult {
  readonly artifactDigest: string
  readonly lockfile: string
  readonly manifest: CompiledWorkflowManifest
  readonly diagnostics: ReadonlyArray<{
    readonly severity: 'warning' | 'error'
    readonly message: string
  }>
}

export interface WorkflowBuilder {
  build(input: {
    readonly workflowId: string
    readonly revision: number
    readonly source: string
    readonly dependencies: Readonly<Record<string, string>>
    readonly allowNpmInstallScripts: boolean
  }): Promise<WorkflowBuildResult>
}

const triggerTypes = new Set([
  'gateway',
  'interactionCommand',
  'interactionComponent',
  'interactionModal',
  'interactionAutocomplete',
  'http',
  'schedule',
  'manual',
])

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const nonEmptyString = (value: unknown, field: string, maximum = 256): string => {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum) {
    throw new Error(`${field} must be a non-empty string of at most ${maximum} characters`)
  }
  return value
}

const stringArray = (value: unknown, field: string): ReadonlyArray<string> => {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== 'string' || entry.length === 0) ||
    new Set(value).size !== value.length
  ) {
    throw new Error(`${field} must be an array of unique non-empty strings`)
  }
  return value
}

const validateRequestedGrants = (value: unknown): void => {
  if (!isRecord(value)) throw new Error('requestedGrants must be an object')
  const fields: Readonly<Record<string, ReadonlySet<string>>> = {
    discord: new Set([
      'operationIds',
      'operationFamilies',
      'guildIds',
      'channelIds',
      'oauthProfileIds',
      'botAdmin',
      'broadMentions',
      'maxActionsPerMinute',
    ]),
    gateway: new Set(['eventTypes', 'includeBotAuthoredEvents']),
    interactions: new Set(['guildCommandPublishing', 'globalCommandPublishing']),
    routes: new Set([
      'public',
      'allowedHosts',
      'allowedOrigins',
      'allowedSourceCidrs',
      'maxBodyBytes',
    ]),
    network: new Set(['allowedOutboundHosts']),
    runtime: new Set(['allowNpmInstallScripts', 'timeoutSeconds', 'concurrency']),
  }
  for (const [section, policy] of Object.entries(value)) {
    if (!fields[section] || !isRecord(policy)) {
      throw new Error(`requestedGrants.${section} is not a supported capability policy`)
    }
    for (const [field, requested] of Object.entries(policy)) {
      if (!fields[section].has(field)) {
        throw new Error(`requestedGrants.${section}.${field} is not supported`)
      }
      if (Array.isArray(requested)) {
        stringArray(requested, `requestedGrants.${section}.${field}`)
      } else if (
        typeof requested !== 'boolean' &&
        !(typeof requested === 'number' && Number.isInteger(requested) && requested > 0)
      ) {
        throw new Error(`requestedGrants.${section}.${field} has an invalid value`)
      }
    }
  }
}

const validateTrigger = (
  trigger: Readonly<Record<string, unknown>>,
  index: number,
  unique: Set<string>,
): void => {
  if (!triggerTypes.has(String(trigger.type)))
    throw new Error(`trigger ${index} has an invalid type`)
  if (trigger.index !== index) throw new Error(`trigger ${index} has an invalid compiled index`)
  const addUnique = (key: string): void => {
    if (unique.has(key)) throw new Error(`duplicate workflow trigger: ${key}`)
    unique.add(key)
  }
  switch (trigger.type) {
    case 'gateway': {
      const eventTypes = stringArray(trigger.eventTypes, `trigger ${index} eventTypes`)
      if (eventTypes.length === 0) throw new Error(`trigger ${index} has no gateway event types`)
      break
    }
    case 'interactionCommand': {
      const name = nonEmptyString(trigger.name, `trigger ${index} command name`, 32)
      if (!/^[a-z0-9_-]{1,32}$/.test(name))
        throw new Error(`trigger ${index} command name is invalid`)
      const commandType = trigger.commandType ?? 'chatInput'
      if (!['chatInput', 'user', 'message'].includes(String(commandType))) {
        throw new Error(`trigger ${index} command type is invalid`)
      }
      if (commandType === 'chatInput') {
        nonEmptyString(trigger.description, `trigger ${index} command description`, 100)
      } else if (trigger.description !== undefined) {
        throw new Error(`trigger ${index} context command cannot have a description`)
      }
      if (trigger.global !== undefined && typeof trigger.global !== 'boolean') {
        throw new Error(`trigger ${index} global flag must be boolean`)
      }
      addUnique(`command:${trigger.global === true ? 'global' : 'guild'}:${commandType}:${name}`)
      break
    }
    case 'interactionComponent':
    case 'interactionModal': {
      const action = nonEmptyString(trigger.action, `trigger ${index} action`, 100)
      if (!/^[A-Za-z0-9_.:-]+$/.test(action)) throw new Error(`trigger ${index} action is invalid`)
      addUnique(`action:${trigger.type}:${action}`)
      break
    }
    case 'interactionAutocomplete': {
      const command = nonEmptyString(trigger.command, `trigger ${index} command`, 32)
      addUnique(`autocomplete:${command}`)
      break
    }
    case 'http': {
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(String(trigger.method))) {
        throw new Error(`trigger ${index} HTTP method is invalid`)
      }
      const path = nonEmptyString(trigger.path, `trigger ${index} HTTP path`, 512)
      if (
        !path.startsWith('/') ||
        path.includes('..') ||
        path.includes('?') ||
        path.includes('#') ||
        path.startsWith('//')
      ) {
        throw new Error(`trigger ${index} HTTP path is invalid`)
      }
      if (
        !isRecord(trigger.auth) ||
        !['apiKey', 'bearer', 'hmacSha256', 'none'].includes(String(trigger.auth.type))
      ) {
        throw new Error(`trigger ${index} HTTP authentication is invalid`)
      }
      if (trigger.auth.type !== 'none') {
        nonEmptyString(trigger.auth.secretRef, `trigger ${index} route secret reference`, 128)
      }
      if (trigger.requestSchema !== undefined && !isRecord(trigger.requestSchema)) {
        throw new Error(`trigger ${index} request schema is invalid`)
      }
      addUnique(`route:${trigger.method}:${path}`)
      break
    }
    case 'schedule': {
      const schedule = nonEmptyString(trigger.schedule, `trigger ${index} schedule`, 128)
      if (schedule.trim().split(/\s+/).length !== 5) {
        throw new Error(`trigger ${index} schedule must contain five cron fields`)
      }
      addUnique(`schedule:${schedule}`)
      break
    }
    case 'manual':
      addUnique(`manual:${nonEmptyString(trigger.key, `trigger ${index} manual key`, 100)}`)
      break
  }
}

export const validateCompiledManifest = (value: unknown): CompiledWorkflowManifest => {
  if (!isRecord(value) || !Array.isArray(value.triggers)) {
    throw new Error('compiled workflow manifest must contain a triggers array')
  }
  if (value.triggers.length === 0 || value.triggers.length > 1_000) {
    throw new Error('compiled workflow manifest must contain 1–1000 triggers')
  }
  const unique = new Set<string>()
  value.triggers.forEach((trigger, index) => {
    if (!isRecord(trigger)) throw new Error(`trigger ${index} must be an object`)
    validateTrigger(trigger, index, unique)
  })
  if (value.requestedGrants !== undefined) validateRequestedGrants(value.requestedGrants)
  const serialized = JSON.stringify(value)
  if (Buffer.byteLength(serialized) > 1024 * 1024) {
    throw new Error('compiled workflow manifest exceeds 1 MiB')
  }
  return value as unknown as CompiledWorkflowManifest
}

export const assertGrantCoversRequested = (
  grant: WorkflowGrant,
  requested: Readonly<Record<string, unknown>>,
): void => {
  validateRequestedGrants(requested)
  for (const [section, policy] of Object.entries(requested)) {
    const approvedPolicy = grant[section as keyof WorkflowGrant] as unknown
    if (!isRecord(approvedPolicy) || !isRecord(policy)) {
      throw new Error(`approved grant does not cover requestedGrants.${section}`)
    }
    for (const [field, value] of Object.entries(policy)) {
      const approved = approvedPolicy[field]
      const path = `requestedGrants.${section}.${field}`
      if (Array.isArray(value)) {
        if (
          !Array.isArray(approved) ||
          value.some((entry) => typeof entry !== 'string' || !approved.includes(entry))
        ) {
          throw new Error(`approved grant does not cover ${path}`)
        }
      } else if (typeof value === 'boolean') {
        if (value && approved !== true) throw new Error(`approved grant does not cover ${path}`)
      } else if (typeof value === 'number') {
        if (typeof approved !== 'number' || approved < value) {
          throw new Error(`approved grant does not cover ${path}`)
        }
      }
    }
  }
}
