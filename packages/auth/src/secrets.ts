import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { ConfigurationError, PersistenceError } from '@discord-mcp/core'
import { Database } from '@discord-mcp/persistence'
import { Config, Context, Effect, Layer, Redacted } from 'effect'

/**
 * Encrypted secret storage.
 *
 * AES-256-GCM under a master key held only in the environment. GCM rather than CBC because it
 * authenticates: a tampered ciphertext fails to decrypt rather than yielding plausible garbage,
 * which for a stored OAuth refresh token is the difference between a clear failure and a confusing
 * one.
 *
 * **Losing `DISCORD_MCP_MASTER_KEY` makes every stored credential unrecoverable.** Back it up
 * separately from the SQLite file, or a single restore restores ciphertext nobody can read.
 */

const ALGORITHM = 'aes-256-gcm'
const KEY_BYTES = 32
const IV_BYTES = 12

export const masterKeyConfig = Config.redacted('DISCORD_MCP_MASTER_KEY')

export const decodeMasterKey = (
  encoded: Redacted.Redacted<string>,
): Effect.Effect<Buffer, ConfigurationError> => {
  const raw = Buffer.from(Redacted.value(encoded), 'base64')
  return raw.length === KEY_BYTES
    ? Effect.succeed(raw)
    : Effect.fail(
        new ConfigurationError({
          variable: 'DISCORD_MCP_MASTER_KEY',
          message: `Expected ${KEY_BYTES} bytes base64-encoded, got ${raw.length}. Generate one with: openssl rand -base64 32`,
        }),
      )
}

export interface Sealed {
  readonly ciphertext: Buffer
  readonly iv: Buffer
  readonly authTag: Buffer
}

export const seal = (key: Buffer, plaintext: string): Sealed => {
  // A fresh IV per encryption. Reusing one under GCM is catastrophic — it leaks the keystream.
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return { ciphertext, iv, authTag: cipher.getAuthTag() }
}

export const unseal = (key: Buffer, sealed: Sealed): string => {
  const decipher = createDecipheriv(ALGORITHM, key, sealed.iv)
  decipher.setAuthTag(sealed.authTag)
  return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]).toString('utf8')
}

export class SecretStore extends Context.Service<
  SecretStore,
  {
    readonly put: (name: string, value: string) => Effect.Effect<void, PersistenceError>
    /** Redacted, so a secret cannot reach a log through an accidental interpolation. */
    readonly get: (
      name: string,
    ) => Effect.Effect<Redacted.Redacted<string> | undefined, PersistenceError>
    readonly delete: (name: string) => Effect.Effect<void, PersistenceError>
    readonly list: () => Effect.Effect<ReadonlyArray<string>, PersistenceError>
  }
>()('auth/SecretStore') {
  static readonly layer = (key: Buffer) =>
    Layer.effect(SecretStore)(
      Effect.gen(function* () {
        const db = yield* Database
        const now = Effect.clockWith((c) => c.currentTimeMillis)

        return {
          put: (name, value) =>
            Effect.gen(function* () {
              const at = yield* now
              const sealed = seal(key, value)
              yield* db.execute(
                `INSERT INTO encrypted_secrets (name, ciphertext, iv, auth_tag, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?)
                 ON CONFLICT (name) DO UPDATE SET
                   ciphertext = excluded.ciphertext,
                   iv = excluded.iv,
                   auth_tag = excluded.auth_tag,
                   updated_at = excluded.updated_at`,
                [name, sealed.ciphertext, sealed.iv, sealed.authTag, at, at],
              )
            }),

          get: (name) =>
            Effect.gen(function* () {
              const rows = yield* db.query<{
                ciphertext: Uint8Array
                iv: Uint8Array
                auth_tag: Uint8Array
              }>('SELECT ciphertext, iv, auth_tag FROM encrypted_secrets WHERE name = ?', [name])

              const row = rows[0]
              if (row === undefined) return undefined

              return yield* Effect.try({
                try: () =>
                  Redacted.make(
                    unseal(key, {
                      ciphertext: Buffer.from(row.ciphertext),
                      iv: Buffer.from(row.iv),
                      authTag: Buffer.from(row.auth_tag),
                    }),
                  ),
                catch: () =>
                  // GCM authentication failed. Either the master key changed or the row was
                  // tampered with; both are worth saying out loud rather than returning nothing.
                  new PersistenceError({
                    operation: `decrypt secret "${name}"`,
                    message:
                      'Decryption failed. DISCORD_MCP_MASTER_KEY does not match the key this secret was encrypted with, or the stored value was altered. Stored credentials cannot be recovered without the original key.',
                  }),
              })
            }),

          delete: (name) => db.execute('DELETE FROM encrypted_secrets WHERE name = ?', [name]),

          list: () =>
            Effect.map(
              db.query<{ name: string }>('SELECT name FROM encrypted_secrets ORDER BY name'),
              (rows) => rows.map((r) => r.name),
            ),
        }
      }),
    )
}
