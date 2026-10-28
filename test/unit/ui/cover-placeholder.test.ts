import { describe, expect, test } from "bun:test";
import { coverPlaceholder } from "../../../ui/app/cover-placeholder.ts";

describe("coverPlaceholder", () => {
  // Expected values are the low 20 bits of the published FNV-1a 32-bit vectors
  // ("" = 0x811c9dc5, "a" = 0xe40c292c, "foobar" = 0xbf9cf968); the Cyrillic
  // value was computed independently in Python by Seigiard/opds-generator,
  // which must produce the same codes.
  test.each([
    ["", 826821],
    ["a", 796972],
    ["foobar", 850280],
    ["война и мир", 599160],
  ])("encodes %p as %i", (title, expected) => {
    // #given
    // #when
    const result = coverPlaceholder(title);

    // #then
    expect(result).toBe(expected);
  });

  test("gives the same placeholder regardless of case, outer spaces, and Unicode form", () => {
    // #given
    const decomposed = "Café Stories";
    const composed = "  café stories ";

    // #when
    const results = [coverPlaceholder(decomposed), coverPlaceholder(composed)];

    // #then
    expect(results[0]).toBe(results[1]);
  });

  test("keeps every value an unsigned 20-bit integer", () => {
    // #given
    const titles = Array.from({ length: 64 }, (_, index) => `Audiobook ${index}`);

    // #when
    const outOfRange = titles.filter((title) => {
      const code = coverPlaceholder(title);

      return !Number.isInteger(code) || code < 0 || code >= 2 ** 20;
    });

    // #then
    expect(outOfRange).toEqual([]);
  });
});
