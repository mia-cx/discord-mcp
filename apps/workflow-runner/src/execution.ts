import { Effect } from '@discord-mcp/workflow-sdk'

/**
 * Workflow handlers may return a plain value, a Promise, or an Effect program.
 * Keep this boundary in the runner so Effect programs execute inside the
 * sandbox rather than being serialized as ordinary objects.
 */
export const resolveWorkflowResult = async (result: unknown): Promise<unknown> => {
  if (Effect.isEffect(result)) {
    return Effect.runPromise(result as Effect.Effect<unknown, unknown, never>)
  }
  return result
}

export interface SerializedWorkflowFailure {
  readonly tag: string
  readonly message: string
  readonly retryable: boolean
}

/** Preserve tagged capability/Effect failures across the runner socket. */
export const serializeWorkflowFailure = (cause: unknown): SerializedWorkflowFailure => {
  const record =
    typeof cause === 'object' && cause !== null
      ? (cause as Readonly<Record<string, unknown>>)
      : undefined
  const tag =
    typeof record?.tag === 'string'
      ? record.tag
      : typeof record?._tag === 'string'
        ? record._tag
        : cause instanceof Error && cause.name
          ? cause.name
          : 'Error'
  return {
    tag,
    message: cause instanceof Error ? cause.message : String(cause),
    retryable: typeof record?.retryable === 'boolean' ? record.retryable : false,
  }
}
