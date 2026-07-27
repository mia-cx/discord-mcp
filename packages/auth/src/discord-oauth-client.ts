import type { DiscordOAuthClient, DiscordTokenSet } from './discord-oauth.js'
import { AuthenticationError } from './principal.js'

export class DiscordOAuthHttpClient implements DiscordOAuthClient {
  constructor(
    readonly clientId: string,
    readonly clientSecret: string,
  ) {}

  exchangeCode(input: {
    readonly code: string
    readonly verifier: string
    readonly redirectUri: string
  }): Promise<DiscordTokenSet> {
    return this.#token({
      grant_type: 'authorization_code',
      code: input.code,
      code_verifier: input.verifier,
      redirect_uri: input.redirectUri,
    })
  }

  refresh(refreshToken: string): Promise<DiscordTokenSet> {
    return this.#token({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    })
  }

  async revoke(token: string): Promise<void> {
    const body = new URLSearchParams({
      token,
      token_type_hint: 'access_token',
    })
    const response = await fetch('https://discord.com/api/v10/oauth2/token/revoke', {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body,
    })
    if (!response.ok)
      throw new AuthenticationError(`Discord OAuth revocation failed (${response.status})`)
  }

  async #token(parameters: Readonly<Record<string, string>>): Promise<DiscordTokenSet> {
    const response = await fetch('https://discord.com/api/v10/oauth2/token', {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: this.clientId,
        ...parameters,
      }),
    })
    const value = (await response.json()) as Record<string, unknown>
    if (
      !response.ok ||
      typeof value.access_token !== 'string' ||
      typeof value.expires_in !== 'number'
    ) {
      throw new AuthenticationError(
        `Discord OAuth token exchange failed (${response.status}): ${
          typeof value.error_description === 'string'
            ? value.error_description
            : typeof value.error === 'string'
              ? value.error
              : 'invalid response'
        }`,
      )
    }
    return {
      accessToken: value.access_token,
      ...(typeof value.refresh_token === 'string' ? { refreshToken: value.refresh_token } : {}),
      expiresIn: value.expires_in,
      scopes: typeof value.scope === 'string' ? value.scope.split(' ').filter(Boolean) : [],
    }
  }
}
