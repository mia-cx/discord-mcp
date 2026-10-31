import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Pool } from 'pg'
import * as schema from './schema.ts'
import { createStorage, migrationsFolder, rootMessage } from './store.ts'

/** What a workflow revision may do: catalog operation IDs, operation families, outbound hosts. */
export interface WorkflowGrants {
  readonly operations: ReadonlyArray<string>
  readonly families: ReadonlyArray<string>
  readonly hosts: ReadonlyArray<string>
}

/** One immutable revision of a bot's workflow. */
export interface WorkflowRevision {
  readonly botId: string
  readonly name: string
  readonly revision: number
  readonly source: string
  readonly grants: WorkflowGrants
  /** The discord.js events its clients listen for. */
  readonly events: ReadonlyArray<string>
  /** The Gateway intents its clients declare, as a bitfield. */
  readonly intents: number
  /** The Discord user ID of the human who published it. */
  readonly publishedBy: string
  readonly publishedAt: Date
}

export interface WorkflowSummary {
  readonly name: string
  readonly latestRevision: number
  readonly enabledRevision: number | null
}

/** A recorded workflow change and the Discord user who made it. */
export interface WorkflowChange {
  readonly workflowName: string
  readonly action: 'publish' | 'enable' | 'disable' | 'delete'
  readonly revision: number | null
  readonly actorId: string
  readonly at: Date
}

export interface PublishWorkflow {
  readonly botId: string
  readonly name: string
  readonly source: string
  readonly grants: WorkflowGrants
  readonly events: ReadonlyArray<string>
  readonly intents: number
  readonly actorId: string
}

/**
 * The platform's Postgres tables. Callers get plain functions; Drizzle stays inside this package.
 * Every workflow change records its actor in the same transaction.
 */
export interface Storage {
  /** Insert or replace a bot's token vault envelope. */
  readonly storeSealedToken: (botId: string, sealedToken: string) => Promise<void>
  readonly loadSealedToken: (botId: string) => Promise<string | undefined>
  /** Insert or replace a shard's sealed Gateway session. The bot's token must be stored first. */
  readonly storeSealedSession: (
    botId: string,
    shardId: number,
    sealedSession: string,
  ) => Promise<void>
  readonly deleteSession: (botId: string, shardId: number) => Promise<void>
  /** Every stored shard session, with its bot's sealed token. */
  readonly loadSealedSessions: () => Promise<ReadonlyArray<SealedSession>>
  /** Store the workflow's next revision, creating the workflow on its first. */
  readonly publishWorkflow: (input: PublishWorkflow) => Promise<WorkflowRevision>
  readonly listWorkflows: (botId: string) => Promise<ReadonlyArray<WorkflowSummary>>
  /** A revision, or the latest when `revision` is omitted. */
  readonly loadWorkflowRevision: (
    botId: string,
    name: string,
    revision?: number,
  ) => Promise<WorkflowRevision | undefined>
  /** Run `revision`, or nothing when null. False when the workflow or revision does not exist. */
  readonly setEnabledRevision: (
    botId: string,
    name: string,
    revision: number | null,
    actorId: string,
  ) => Promise<boolean>
  /** Delete a workflow and its revisions. False when it does not exist. */
  readonly deleteWorkflow: (botId: string, name: string, actorId: string) => Promise<boolean>
  /** The enabled revision of every workflow, for one bot or for all of them. */
  readonly enabledRevisions: (botId?: string) => Promise<ReadonlyArray<WorkflowRevision>>
  /** A bot's most recent workflow changes, newest first, deleted workflows included. */
  readonly workflowChanges: (botId: string, limit: number) => Promise<ReadonlyArray<WorkflowChange>>
  readonly close: () => Promise<void>
}

export interface SealedSession {
  readonly botId: string
  readonly shardId: number
  readonly sealedSession: string
  readonly sealedToken: string
}

const CONNECT_TIMEOUT_MS = 10_000
const QUERY_TIMEOUT_MS = 30_000

/**
 * Connect to Postgres and apply pending migrations before anything reads or writes.
 * `onError` hears connection failures outside a query, such as Postgres restarting; the pool
 * replaces the lost connection on next use.
 */
export const connectStorage = async (
  url: string,
  onError: (error: Error) => void,
): Promise<Storage> => {
  const pool = new Pool({
    connectionString: url,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    query_timeout: QUERY_TIMEOUT_MS,
  })
  pool.on('error', onError)
  const db = drizzle(pool, { schema })
  try {
    await migrate(db, { migrationsFolder })
  } catch (cause) {
    await pool.end()
    throw new Error(`Could not connect to Postgres or apply migrations: ${rootMessage(cause)}`, {
      cause,
    })
  }
  return createStorage(db, () => pool.end())
}
