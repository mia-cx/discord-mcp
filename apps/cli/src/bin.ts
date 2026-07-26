#!/usr/bin/env node
import { decodeMasterKey, masterKeyConfig, PrincipalStore, SecretStore } from '@discord-mcp/auth'
import { AuditRepository, PersistenceLayer } from '@discord-mcp/persistence'
import { NodeRuntime } from '@effect/platform-node'
import { Config, Effect, Layer } from 'effect'
import type { Services } from './commands.ts'
import {
  auditTail,
  blobPut,
  migrate,
  principalCreate,
  principalList,
  secretDelete,
  secretList,
  secretPut,
  tokenCreate,
  tokenList,
  tokenRevoke,
} from './commands.ts'

/**
 * `discord-mcp` — secrets, blobs, principals, tokens, migrations, diagnostics.
 *
 * Separate from the server so credential administration never needs the server running, and so the
 * one process that reads local files is the one the operator invoked directly.
 */

const USAGE = `discord-mcp — administration for a Discord MCP control plane

  principal create <id> <display-name> <scope>...   Create or update a principal
  principal list                                    List principals and their scopes

  auth token create <principal-id> <name> [days]    Issue a token; shown once
  auth token list <principal-id>                    List a principal's tokens
  auth token revoke <token-id>                      Revoke immediately, no restart

  secret put <name> <value>                         Store an AES-256-GCM encrypted secret
  secret list                                       List secret names (never values)
  secret delete <name>                              Delete a secret

  blob put <path>                                   Store a local file for use as an attachment

  migrate                                           Apply pending migrations and report
  audit tail [limit]                                Recent audit entries

Environment: DATABASE_PATH (default ./discord-mcp.sqlite), DISCORD_MCP_MASTER_KEY (32 bytes base64).
Back the master key up separately from the database: without it, stored credentials are
unrecoverable.`

const databasePath = Config.string('DATABASE_PATH').pipe(Config.withDefault('./discord-mcp.sqlite'))

/**
 * The master key is only needed for secret commands.
 *
 * Requiring it for `migrate` or `token list` would make routine administration impossible on a
 * machine that legitimately does not hold it.
 */
const requiresMasterKey = (argv: ReadonlyArray<string>) => argv[0] === 'secret'

/** Every command's requirements, unioned, so the layer below provably satisfies all of them. */
type CommandEffect = Effect.Effect<void, unknown, Services>

const run = (argv: ReadonlyArray<string>): CommandEffect => {
  const [group, action, ...rest] = argv

  switch (`${group ?? ''} ${action ?? ''}`.trim()) {
    case 'principal create': {
      const [id, name, ...scopes] = rest
      return id === undefined || name === undefined
        ? usage('principal create needs an id and a display name.')
        : principalCreate({ id, name, scopes })
    }
    case 'principal list':
      return principalList

    case 'auth token': {
      const [subAction, ...tokenArgs] = rest
      return tokenCommand(subAction, tokenArgs)
    }

    case 'secret put': {
      const [name, value] = rest
      return name === undefined || value === undefined
        ? usage('secret put needs a name and a value.')
        : secretPut({ name, value })
    }
    case 'secret list':
      return secretList
    case 'secret delete': {
      const [name] = rest
      return name === undefined ? usage('secret delete needs a name.') : secretDelete(name)
    }

    case 'blob put': {
      const [path] = rest
      return path === undefined
        ? usage('blob put needs a path.')
        : blobPut({ path, principalId: 'stdio-local' })
    }

    case 'migrate':
      return migrate
    case 'audit tail':
      return auditTail(Number(rest[0] ?? 20))

    default:
      return usage()
  }
}

const tokenCommand = (action: string | undefined, args: ReadonlyArray<string>): CommandEffect => {
  switch (action) {
    case 'create': {
      const [principalId, name, days] = args
      return principalId === undefined || name === undefined
        ? usage('auth token create needs a principal id and a name.')
        : tokenCreate({
            principalId,
            name,
            ...(days === undefined ? {} : { expiryDays: Number(days) }),
          })
    }
    case 'list': {
      const [principalId] = args
      return principalId === undefined
        ? usage('auth token list needs a principal id.')
        : tokenList(principalId)
    }
    case 'revoke': {
      const [tokenId] = args
      return tokenId === undefined
        ? usage('auth token revoke needs a token id.')
        : tokenRevoke(tokenId)
    }
    default:
      return usage()
  }
}

const usage = (problem?: string): CommandEffect =>
  Effect.sync(() => {
    if (problem !== undefined) process.stderr.write(`${problem}\n\n`)
    process.stdout.write(`${USAGE}\n`)
    process.exitCode = problem === undefined ? 0 : 2
  })

const main = Effect.gen(function* () {
  const argv = process.argv.slice(2)
  const path = yield* Effect.orDie(databasePath)

  // Only decoded when a secret command needs it, and Redacted throughout, so it cannot reach a log.
  const key = requiresMasterKey(argv)
    ? yield* Effect.flatMap(Effect.orDie(masterKeyConfig), decodeMasterKey)
    : Buffer.alloc(32)

  const layer = Layer.mergeAll(
    PrincipalStore.layer,
    SecretStore.layer(key),
    AuditRepository.layer,
  ).pipe(Layer.provideMerge(PersistenceLayer(path)))

  yield* Effect.provide(run(argv), layer) as Effect.Effect<void, unknown>
})

NodeRuntime.runMain(main)
