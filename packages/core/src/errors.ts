import { Schema } from 'effect'

export class ValidationError extends Schema.TaggedErrorClass<ValidationError>()('ValidationError', {
  message: Schema.String,
  path: Schema.optionalKey(Schema.String),
}) {
  constructor(message: string, path?: string) {
    super({ message, ...(path === undefined ? {} : { path }) })
  }
}
