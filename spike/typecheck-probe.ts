// TS7 x Effect v4 gate: exercise the inference-heavy surfaces the project depends on.
import { Context, Effect, Layer, ManagedRuntime, Schema } from 'effect'

const Snowflake = Schema.String.pipe(Schema.check(Schema.isMinLength(17), Schema.isMaxLength(21)))

const Input = Schema.Struct({
  guildId: Snowflake,
  withCounts: Schema.optionalKey(Schema.Boolean),
  nested: Schema.optionalKey(Schema.Struct({ tags: Schema.Array(Schema.String) })),
})

// Inference must survive Struct -> Type without annotation.
type In = typeof Input.Type
const _typed: In = { guildId: '123456789012345678' }

class Rest extends Context.Service<Rest, { readonly get: (p: string) => Effect.Effect<unknown, Error> }>()(
  'spike/Rest',
) {
  static readonly layer = Layer.effect(Rest)(
    Effect.acquireRelease(
      Effect.succeed({ get: (_p: string) => Effect.succeed<unknown>({}) }),
      () => Effect.void,
    ),
  )
}

class Boom extends Schema.TaggedErrorClass<Boom>()('Boom', { reason: Schema.String }) {}

const program = Effect.gen(function* () {
  const rest = yield* Rest
  const decoded = yield* Schema.decodeUnknownEffect(Input, { errors: 'all' })(_typed)
  if (decoded.guildId === '') return yield* Effect.fail(new Boom({ reason: 'empty' }))
  return yield* rest.get(`/guilds/${decoded.guildId}`)
})

// The requirement channel must be exactly Rest, and the error channel must include Boom.
const _checked: Effect.Effect<unknown, Boom | Error | Schema.SchemaError, Rest> = program

const runtime = ManagedRuntime.make(Rest.layer)
export const run = () => runtime.runPromiseExit(program)
