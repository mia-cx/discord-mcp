import { Schema } from 'effect'

export class BlueprintError extends Schema.TaggedErrorClass<BlueprintError>()('BlueprintError', {
  message: Schema.String,
}) {
  constructor(message: string) {
    super({ message })
  }
}
