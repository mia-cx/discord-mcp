import type { DiscordTransport, RestRequest } from '@discord-mcp/discord-api'

export const testSnowflakes = {
  guild: '12345678901234567',
  channel: '12345678901234568',
  user: '12345678901234569',
} as const

export class RecordingDiscordTransport implements DiscordTransport {
  readonly requests: Array<RestRequest> = []

  constructor(readonly respond: (request: RestRequest) => unknown = () => ({})) {}

  async request(request: RestRequest): Promise<unknown> {
    this.requests.push(request)
    return this.respond(request)
  }
}
