import { describe, expect, test } from "bun:test";
import { coverPlaceholder } from "../../../ui/app/cover-placeholder.ts";

describe("coverPlaceholder", () => {
  // Expected values come from the published FNV-1a 32-bit vectors
  // ("a" = 0xe40c292c, "foobar" = 0xbf9cf968) packed by hand into the
  // cells/lightness/chroma layout and shifted down by 2^19.
  test.each([
    ["a", 272748],
    ["foobar", 326056],
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

  test("keeps every value inside the 20-bit range and the two middle lightness levels", () => {
    // #given
    const titles = Array.from({ length: 64 }, (_, index) => `Audiobook ${index}`);

    // #when
    const violations = titles.flatMap((title) => {
      const unsigned = coverPlaceholder(title) + 2 ** 19;
      const lightness = (unsigned >> 6) & 3;
      const inRange = Number.isInteger(unsigned) && unsigned >= 0 && unsigned < 2 ** 20;

      return inRange && (lightness === 1 || lightness === 2) ? [] : [{ title, unsigned }];
    });

    // #then
    expect(violations).toEqual([]);
  });
});
