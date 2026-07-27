import { Schema } from 'effect'

export const Snowflake = Schema.String.pipe(Schema.check(Schema.isPattern(/^\d{17,21}$/))).annotate(
  { description: 'A Discord snowflake encoded as a decimal string.' },
)

export type Snowflake = typeof Snowflake.Type

export const NonEmptyString = Schema.String.pipe(Schema.check(Schema.isMinLength(1)))
