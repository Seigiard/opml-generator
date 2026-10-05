import { z } from "zod";

// Thrown values are not necessarily Error instances. Decode them once at the
// logging boundary, preserving plain strings and JSON serialization of objects.
export const logErrorSchema = z.unknown().transform((input) => {
  if (input instanceof Error) return { error: input.message, error_stack: input.stack };

  const message = z.string().safeParse(input);

  if (message.success) return { error: message.data };

  if (input === undefined || input === null) return {};

  return { error: JSON.stringify(input) };
});

export type LogErrorInput = z.input<typeof logErrorSchema>;
