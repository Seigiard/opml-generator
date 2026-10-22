import { Schema, SchemaGetter } from "effect";

const logErrorOutputSchema = Schema.Struct({
  error: Schema.optional(Schema.String),
  error_stack: Schema.optional(Schema.String),
});

// Thrown values are not necessarily Error instances. Decode them once at the
// logging boundary, preserving plain strings and JSON serialization of objects.
export const logErrorSchema = Schema.Unknown.pipe(
  Schema.decodeTo(logErrorOutputSchema, {
    decode: SchemaGetter.transform((input) => {
      if (Schema.is(Schema.instanceOf(Error))(input))
        return { error: input.message, error_stack: input.stack };

      if (Schema.is(Schema.String)(input)) return { error: input };

      if (input === undefined || input === null) return {};

      return { error: JSON.stringify(input) };
    }),
    encode: SchemaGetter.transform((output) => output),
  }),
);

export type LogErrorInput = Schema.Codec.Encoded<typeof logErrorSchema>;
