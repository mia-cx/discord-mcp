/**
 * Phase-0 gate. Verifies every unverified claim in PLAN.md against the shipped
 * artifacts, not the documentation. Run: pnpm tsx spike.ts
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server'
import { Context, Effect, Layer, ManagedRuntime, Schema } from 'effect'

const results: Array<[string, boolean, string]> = []
const check = (name: string, ok: boolean, detail = '') => {
  results.push([name, ok, detail])
}

// ---------------------------------------------------------------- gate 1: bridge
const McpInput = <S extends Schema.Top>(s: S) =>
  Schema.toStandardJSONSchemaV1(Schema.toStandardSchemaV1(s))

const GuildGet = Schema.Struct({
  guildId: Schema.String.pipe(Schema.check(Schema.isMinLength(17), Schema.isMaxLength(21))),
  withCounts: Schema.optionalKey(Schema.Boolean),
})

const bridged = McpInput(GuildGet)
const std = (bridged as any)['~standard']
check('toStandardSchemaV1 attaches ~standard.validate', typeof std?.validate === 'function')
check('toStandardJSONSchemaV1 attaches to the SAME ~standard', typeof std?.jsonSchema === 'object')

const json = std.jsonSchema.input({ target: 'draft-2020-12' })
check('input JSON Schema root is type:object', json.type === 'object', JSON.stringify(json))
check(
  'required reflects optionalKey',
  Array.isArray(json.required) && json.required.includes('guildId') && !json.required.includes('withCounts'),
  JSON.stringify(json.required),
)

// idempotency: PLAN claims toStandardSchemaV1 mutates and returns the same schema
check('toStandardSchemaV1 is idempotent', Schema.toStandardSchemaV1(GuildGet) === (GuildGet as any))

// ---------------------------------------------------------------- gate 2: conformance
// MCP's advertised schema and direct Effect decoding must accept/reject the same fixtures.
const decode = Schema.decodeUnknownEffect(GuildGet, { errors: 'all' })
const fixtures: Array<unknown> = [
  { guildId: '123456789012345678' },
  { guildId: '123456789012345678', withCounts: true },
  { guildId: 'short' },
  { guildId: 123 },
  {},
]
let conformant = true
for (const f of fixtures) {
  const viaEffect = (await Effect.runPromiseExit(decode(f)))._tag === 'Success'
  const viaStandard = !(await std.validate(f)).issues
  if (viaEffect !== viaStandard) conformant = false
}
check('MCP standard-schema and Effect decoding agree on all fixtures', conformant)

// ---------------------------------------------------------------- gate 3: services + scoped layers
class Probe extends Context.Service<Probe, { readonly value: string }>()('spike/Probe') {
  static readonly layer = Layer.effect(Probe)(
    Effect.acquireRelease(Effect.succeed({ value: 'acquired' }), () =>
      Effect.sync(() => {
        released = true
      }),
    ),
  )
}
let released = false

const runtime = ManagedRuntime.make(Probe.layer)
check('Context.Service + Layer.effect scoped acquire', (await runtime.runPromise(Probe as unknown as Effect.Effect<{ value: string }, never, Probe>)).value === 'acquired')

// ---------------------------------------------------------------- gate 4: runPromiseExit signal
// PLAN open risk #4: the options bag is unverified in beta.101.
const controller = new AbortController()
const never = Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => { interrupted = true })))
let interrupted = false
setTimeout(() => controller.abort(), 50)
let signalOptionWorks = false
try {
  const exit = await runtime.runPromiseExit(never as any, { signal: controller.signal })
  signalOptionWorks = exit._tag === 'Failure' && interrupted
} catch (e) {
  signalOptionWorks = false
  check('runPromiseExit signal threw', false, String(e))
}
check('ManagedRuntime.runPromiseExit(program, { signal }) interrupts the fiber', signalOptionWorks)

await runtime.dispose()
check('runtime.dispose() runs layer finalizers', released)

// ---------------------------------------------------------------- gate 5: real MCP round trip
const server = new McpServer({ name: 'spike', version: '0.0.0' })
server.registerTool(
  'guild_get',
  { title: 'Get guild', description: 'spike', inputSchema: bridged as any },
  async (args: any) => ({ content: [{ type: 'text', text: `ok:${args.guildId}` }] }),
)

// PLAN claims MCP throws when an inputSchema root type is not "object". It does --
// but at tools/list, NOT at registerTool. A bad schema therefore breaks discovery
// for EVERY tool on the server, at first client contact rather than at startup.
// This is what makes the registry's eager build-and-assert mandatory, not optional.
const badServer = new McpServer({ name: 'bad', version: '0.0.0' })
let rejectedAtRegistration = false
try {
  badServer.registerTool(
    'bad',
    { description: 'x', inputSchema: McpInput(Schema.String) as any },
    async () => ({ content: [] }),
  )
} catch {
  rejectedAtRegistration = true
}
check('DEVIATION: non-object root is NOT rejected at registerTool', !rejectedAtRegistration)

const badHandler = createMcpHandler(() => badServer, { onerror: () => {} })
const badClient = new Client({ name: 'c', version: '0.0.0' })
await badClient.connect(
  new StreamableHTTPClientTransport(new URL('http://mcp.local/mcp'), {
    fetch: ((u: any, i: any) => badHandler.fetch(new Request(u, i))) as typeof fetch,
  }),
)
let listFailed = false
try {
  await badClient.listTools()
} catch {
  listFailed = true
}
check('non-object root breaks tools/list -> registry must pre-validate', listFailed)
await badClient.close()

const handler = createMcpHandler(() => server, {
  onerror: (e) => console.error('[handler]', e),
})
const client = new Client({ name: 'spike-client', version: '0.0.0' })
await client.connect(
  new StreamableHTTPClientTransport(new URL('http://mcp.local/mcp'), {
    // handler.fetch takes a Request; the client's FetchLike is (url, init).
    fetch: ((url: any, init: any) => handler.fetch(new Request(url, init))) as typeof fetch,
  }),
)

const listed = await client.listTools()
const tool = listed.tools.find((t) => t.name === 'guild_get')
check('tools/list advertises the Effect-derived schema', tool?.inputSchema?.type === 'object')
check(
  'advertised schema preserves constraints',
  JSON.stringify(tool?.inputSchema).includes('minLength'),
  JSON.stringify(tool?.inputSchema),
)

const called: any = await client.callTool({ name: 'guild_get', arguments: { guildId: '123456789012345678' } })
check('tools/call round trip', called.content?.[0]?.text === 'ok:123456789012345678')

const badCall: any = await client.callTool({ name: 'guild_get', arguments: { guildId: 'short' } })
check('MCP rejects input violating the Effect constraint', badCall.isError === true, JSON.stringify(badCall.content))

await client.close()

// ---------------------------------------------------------------- report
let failures = 0
for (const [name, ok, detail] of results) {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`)
}
console.log(`\n${results.length - failures}/${results.length} gates passed`)
process.exit(failures === 0 ? 0 : 1)
