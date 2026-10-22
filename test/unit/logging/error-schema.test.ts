import { expect, test } from "bun:test";
import { Schema } from "effect";
import { log } from "../../../src/logging/index.ts";

const LogErrorContext = Schema.Struct({
  error: Schema.optional(Schema.String),
  error_stack: Schema.optional(Schema.String),
});

test("writes an Error message and stack to the JSON log context", () => {
  // #given
  const error = new Error("boom");
  const calls: string[] = [];
  const original = console.error;
  console.error = (entry: string) => {
    calls.push(entry);
  };

  try {
    // #when
    log.error("ErrorSchemaCharacterization", "Failed to sync", error);
  } finally {
    console.error = original;
  }

  // #then
  const entry = Schema.decodeUnknownSync(LogErrorContext)(JSON.parse(calls[0]!));
  expect({ error: entry.error, error_stack: entry.error_stack }).toEqual({
    error: "boom",
    error_stack: error.stack,
  });
});

test("writes a thrown string as the JSON log error", () => {
  // #given
  const calls: string[] = [];
  const original = console.error;
  console.error = (entry: string) => {
    calls.push(entry);
  };

  try {
    // #when
    log.error("ErrorSchemaCharacterization", "Failed to sync", "plain");
  } finally {
    console.error = original;
  }

  // #then
  const entry = Schema.decodeUnknownSync(LogErrorContext)(JSON.parse(calls[0]!));
  expect({ error: entry.error, error_stack: entry.error_stack }).toEqual({
    error: "plain",
    error_stack: undefined,
  });
});

test("omits error fields for a null thrown value", () => {
  // #given
  const calls: string[] = [];
  const original = console.error;
  console.error = (entry: string) => {
    calls.push(entry);
  };

  try {
    // #when
    log.error("ErrorSchemaCharacterization", "Failed to sync", null);
  } finally {
    console.error = original;
  }

  // #then
  const entry = Schema.decodeUnknownSync(LogErrorContext)(JSON.parse(calls[0]!));
  expect({ error: entry.error, error_stack: entry.error_stack }).toEqual({
    error: undefined,
    error_stack: undefined,
  });
});

test("omits error fields for an undefined thrown value", () => {
  // #given
  const calls: string[] = [];
  const original = console.error;
  console.error = (entry: string) => {
    calls.push(entry);
  };

  try {
    // #when
    log.error("ErrorSchemaCharacterization", "Failed to sync", undefined);
  } finally {
    console.error = original;
  }

  // #then
  const entry = Schema.decodeUnknownSync(LogErrorContext)(JSON.parse(calls[0]!));
  expect({ error: entry.error, error_stack: entry.error_stack }).toEqual({
    error: undefined,
    error_stack: undefined,
  });
});

test("writes other thrown values as JSON strings", () => {
  // #given
  const calls: string[] = [];
  const original = console.error;
  console.error = (entry: string) => {
    calls.push(entry);
  };

  try {
    // #when
    log.error("ErrorSchemaCharacterization", "Failed to sync", { a: 1 });
  } finally {
    console.error = original;
  }

  // #then
  const entry = Schema.decodeUnknownSync(LogErrorContext)(JSON.parse(calls[0]!));
  expect({ error: entry.error, error_stack: entry.error_stack }).toEqual({
    error: '{"a":1}',
    error_stack: undefined,
  });
});
