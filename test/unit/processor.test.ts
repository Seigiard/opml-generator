import { describe, test, expect } from "bun:test";
import { encodeUrlPath, naturalSort, normalizeFilenameTitle } from "../../src/utils/processor.ts";

describe("processor", () => {
  describe("encodeUrlPath", () => {
    test("encodes spaces", () => {
      expect(encodeUrlPath("path/with spaces/file")).toBe("path/with%20spaces/file");
    });

    test("encodes special characters", () => {
      expect(encodeUrlPath("path/file[1].epub")).toBe("path/file%5B1%5D.epub");
      expect(encodeUrlPath("path/file#hash.pdf")).toBe("path/file%23hash.pdf");
    });

    test("preserves slashes", () => {
      expect(encodeUrlPath("a/b/c/d")).toBe("a/b/c/d");
    });

    test("encodes unicode characters", () => {
      expect(encodeUrlPath("авторы/книга.epub")).toBe("%D0%B0%D0%B2%D1%82%D0%BE%D1%80%D1%8B/%D0%BA%D0%BD%D0%B8%D0%B3%D0%B0.epub");
    });

    test("encodes parentheses", () => {
      expect(encodeUrlPath("Author (2024)/Book.epub")).toBe("Author%20(2024)/Book.epub");
    });
  });

  describe("normalizeFilenameTitle", () => {
    test("replaces underscores with spaces when majority separator", () => {
      expect(normalizeFilenameTitle("Hello_World")).toBe("Hello World");
      expect(normalizeFilenameTitle("multiple__underscores")).toBe("Multiple underscores");
    });

    test("replaces hyphens with spaces when majority separator", () => {
      expect(normalizeFilenameTitle("my-awesome-book")).toBe("My awesome book");
      expect(normalizeFilenameTitle("multiple--hyphens")).toBe("Multiple hyphens");
    });

    test("preserves minority separator", () => {
      expect(normalizeFilenameTitle("sci-fi_books_2024")).toBe("Sci-fi books 2024");
      expect(normalizeFilenameTitle("book_about_a-b")).toBe("Book about a-b");
      expect(normalizeFilenameTitle("test-very-long_title")).toBe("Test very long_title");
    });

    test("prefers underscore as separator when equal count", () => {
      expect(normalizeFilenameTitle("e-book_collection")).toBe("E-book collection");
    });

    test("splits camelCase", () => {
      expect(normalizeFilenameTitle("camelCase")).toBe("Camel Case");
      expect(normalizeFilenameTitle("TheLordOfTheRings")).toBe("The Lord Of The Rings");
      expect(normalizeFilenameTitle("XMLParser")).toBe("XML Parser");
    });

    test("normalizes multiple spaces", () => {
      expect(normalizeFilenameTitle("Hello   World")).toBe("Hello World");
    });

    test("trims whitespace and edge separators", () => {
      expect(normalizeFilenameTitle("  Hello World  ")).toBe("Hello World");
      expect(normalizeFilenameTitle("_Hello_")).toBe("Hello");
      expect(normalizeFilenameTitle("___book_title___")).toBe("Book title");
      expect(normalizeFilenameTitle("---my-book---")).toBe("My book");
    });

    test("preserves special characters", () => {
      expect(normalizeFilenameTitle("Hello (World) [2024]")).toBe("Hello (World) [2024]");
      expect(normalizeFilenameTitle("Book #1")).toBe("Book #1");
    });

    test("handles unicode", () => {
      expect(normalizeFilenameTitle("Книга_автора")).toBe("Книга автора");
    });

    test("capitalizes first letter", () => {
      expect(normalizeFilenameTitle("hello_world")).toBe("Hello world");
      expect(normalizeFilenameTitle("test")).toBe("Test");
    });
  });

  describe("naturalSort", () => {
    test("sorts strings alphabetically", () => {
      expect(["b", "a", "c"].sort(naturalSort)).toEqual(["a", "b", "c"]);
    });

    test("sorts numbers naturally", () => {
      expect(["10", "2", "1"].sort(naturalSort)).toEqual(["1", "2", "10"]);
    });

    test("handles mixed content", () => {
      expect(["track10", "track2", "track1"].sort(naturalSort)).toEqual(["track1", "track2", "track10"]);
    });

    test("is case-insensitive", () => {
      expect(["B", "a", "C"].sort(naturalSort)).toEqual(["a", "B", "C"]);
    });
  });
});
