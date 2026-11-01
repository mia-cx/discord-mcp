/**
 * Preloaded into server processes under test: sends their Discord traffic to `FAKE_DISCORD_URL`,
 * tagged with `TEST_CALLER` so the fake can tell which process made each call. Gateway
 * connections carry the tag as a `caller` query parameter.
 */
const target = process.env.FAKE_DISCORD_URL
const caller = process.env.TEST_CALLER ?? ''
if (target === undefined) throw new Error('FAKE_DISCORD_URL is required.')

const NativeWebSocket = globalThis.WebSocket
globalThis.WebSocket = class extends NativeWebSocket {
  constructor(url: string | URL, protocols?: string | string[]) {
    const tagged = new URL(url)
    tagged.searchParams.set('caller', caller)
    super(tagged, protocols)
  }
}

const network = globalThis.fetch
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input)
  if (url.hostname !== 'discord.com') return network(input, init)
  const request = new Request(input, init)
  const headers = new Headers(request.headers)
  headers.set('x-test-caller', caller)
  return network(new URL(`${url.pathname}${url.search}`, target), {
    method: request.method,
    headers,
    body: request.body,
    duplex: 'half',
    signal: request.signal,
  })
}
