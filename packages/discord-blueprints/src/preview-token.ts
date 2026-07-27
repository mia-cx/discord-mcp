import { createHmac, timingSafeEqual } from 'node:crypto'
import { Schema } from 'effect'

export interface PreviewClaims {
  readonly principalId: string
  readonly guildId: string
  readonly blueprintDigest: string
  readonly snapshotDigest: string
  readonly actionsDigest: string
  readonly expiresAt: number
}

const base64url = (value: string | Buffer): string => Buffer.from(value).toString('base64url')

export class PreviewTokenError extends Schema.TaggedErrorClass<PreviewTokenError>()(
  'PreviewTokenError',
  { message: Schema.String },
) {
  constructor(message: string) {
    super({ message })
  }
}

export class PreviewTokens {
  constructor(
    readonly key: Buffer,
    readonly lifetimeMs = 60_000,
  ) {
    if (key.length < 32) throw new Error('preview token signing key must contain at least 32 bytes')
  }

  issue(claims: Omit<PreviewClaims, 'expiresAt'>, now = Date.now()): string {
    const payload = base64url(JSON.stringify({ ...claims, expiresAt: now + this.lifetimeMs }))
    const signature = createHmac('sha256', this.key).update(payload).digest('base64url')
    return `${payload}.${signature}`
  }

  verify(
    token: string,
    expected: Omit<PreviewClaims, 'expiresAt'>,
    now = Date.now(),
  ): PreviewClaims {
    const [payload, suppliedSignature, extra] = token.split('.')
    if (!payload || !suppliedSignature || extra !== undefined) {
      throw new PreviewTokenError('Malformed preview token')
    }
    const expectedSignature = createHmac('sha256', this.key).update(payload).digest()
    let supplied: Buffer
    try {
      supplied = Buffer.from(suppliedSignature, 'base64url')
    } catch {
      throw new PreviewTokenError('Malformed preview token signature')
    }
    if (
      supplied.length !== expectedSignature.length ||
      !timingSafeEqual(supplied, expectedSignature)
    ) {
      throw new PreviewTokenError('Invalid preview token signature')
    }
    let claims: PreviewClaims
    try {
      claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as PreviewClaims
    } catch {
      throw new PreviewTokenError('Malformed preview token payload')
    }
    if (claims.expiresAt < now) throw new PreviewTokenError('Preview token expired; plan again')
    for (const [key, value] of Object.entries(expected)) {
      if (claims[key as keyof PreviewClaims] !== value) {
        throw new PreviewTokenError(`Preview token no longer matches ${key}; plan again`)
      }
    }
    return claims
  }
}
