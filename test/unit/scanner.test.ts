import { describe, test, expect } from "bun:test";
import { buildFolderStructure, computeHash } from "../../src/scanner.ts";
import type { FileInfo } from "../../src/types.ts";

function createFileInfo(relativePath: string, size = 1000, mtime = Date.now()): FileInfo {
  return {
    path: `/files/${relativePath}`,
    relativePath,
    size,
    mtime,
    extension: relativePath.split(".").pop() || "mp3",
  };
}

describe("scanner", () => {
  describe("buildFolderStructure", () => {
    test("handles empty file list", () => {
      const result = buildFolderStructure([]);
      expect(result).toHaveLength(1);
      expect(result[0]!.path).toBe("");
      expect(result[0]!.name).toBe("Catalog");
      expect(result[0]!.subfolders).toEqual([]);
    });

    test("handles flat structure (files in root)", () => {
      const files = [createFileInfo("track1.mp3"), createFileInfo("track2.m4a")];

      const result = buildFolderStructure(files);
      expect(result).toHaveLength(1);
      expect(result[0]!.path).toBe("");
      expect(result[0]!.name).toBe("Catalog");
    });

    test("creates folder entries for nested files", () => {
      const files = [createFileInfo("Author/Track.mp3")];

      const result = buildFolderStructure(files);
      expect(result).toHaveLength(2);

      const root = result.find((f) => f.path === "");
      const author = result.find((f) => f.path === "Author");

      expect(root).toBeDefined();
      expect(root!.subfolders).toContain("Author");

      expect(author).toBeDefined();
      expect(author!.name).toBe("Author");
      expect(author!.subfolders).toEqual([]);
    });

    test("handles deep nesting", () => {
      const files = [createFileInfo("A/B/C/track.mp3")];

      const result = buildFolderStructure(files);
      expect(result).toHaveLength(4);

      const paths = result.map((f) => f.path).sort();
      expect(paths).toEqual(["", "A", "A/B", "A/B/C"]);

      const a = result.find((f) => f.path === "A");
      expect(a!.subfolders).toContain("A/B");

      const ab = result.find((f) => f.path === "A/B");
      expect(ab!.subfolders).toContain("A/B/C");

      const abc = result.find((f) => f.path === "A/B/C");
      expect(abc!.subfolders).toEqual([]);
    });

    test("handles multiple subfolders", () => {
      const files = [
        createFileInfo("Fiction/Track1.mp3"),
        createFileInfo("NonFiction/Track2.m4a"),
        createFileInfo("Podcasts/Episode1.ogg"),
      ];

      const result = buildFolderStructure(files);
      const root = result.find((f) => f.path === "");

      expect(root!.subfolders).toHaveLength(3);
      expect(root!.subfolders).toContain("Fiction");
      expect(root!.subfolders).toContain("NonFiction");
      expect(root!.subfolders).toContain("Podcasts");
    });

    test("deduplicates folders from multiple files", () => {
      const files = [createFileInfo("Author/Track1.mp3"), createFileInfo("Author/Book2.epub")];

      const result = buildFolderStructure(files);
      expect(result).toHaveLength(2);

      const authorFolders = result.filter((f) => f.path === "Author");
      expect(authorFolders).toHaveLength(1);
    });

    test("correctly identifies direct subfolders only", () => {
      const files = [createFileInfo("A/B/C/track.mp3"), createFileInfo("A/D/track.mp3")];

      const result = buildFolderStructure(files);

      const a = result.find((f) => f.path === "A");
      expect(a!.subfolders).toHaveLength(2);
      expect(a!.subfolders).toContain("A/B");
      expect(a!.subfolders).toContain("A/D");
      expect(a!.subfolders).not.toContain("A/B/C");
    });

    test("handles special characters in folder names", () => {
      const files = [createFileInfo("Author (2024)/Track [Special].mp3")];

      const result = buildFolderStructure(files);
      const folder = result.find((f) => f.path === "Author (2024)");

      expect(folder).toBeDefined();
      expect(folder!.name).toBe("Author (2024)");
    });

    test("handles unicode folder names", () => {
      const files = [createFileInfo("Авторы/Трек.mp3")];

      const result = buildFolderStructure(files);
      const folder = result.find((f) => f.path === "Авторы");

      expect(folder).toBeDefined();
      expect(folder!.name).toBe("Авторы");
    });
  });

  describe("computeHash", () => {
    test("returns consistent hash for same files", () => {
      const files = [createFileInfo("track1.mp3", 1000, 1700000000000), createFileInfo("track2.m4a", 2000, 1700000001000)];

      const hash1 = computeHash(files);
      const hash2 = computeHash(files);

      expect(hash1).toBe(hash2);
    });

    test("returns same hash regardless of input order", () => {
      const file1 = createFileInfo("a/track.mp3", 1000, 1700000000000);
      const file2 = createFileInfo("b/book.pdf", 2000, 1700000001000);

      const hash1 = computeHash([file1, file2]);
      const hash2 = computeHash([file2, file1]);

      expect(hash1).toBe(hash2);
    });

    test("returns different hash when file size changes", () => {
      const file1 = createFileInfo("track.mp3", 1000, 1700000000000);
      const file2 = createFileInfo("track.mp3", 2000, 1700000000000);

      expect(computeHash([file1])).not.toBe(computeHash([file2]));
    });

    test("returns different hash when file mtime changes", () => {
      const file1 = createFileInfo("track.mp3", 1000, 1700000000000);
      const file2 = createFileInfo("track.mp3", 1000, 1700000001000);

      expect(computeHash([file1])).not.toBe(computeHash([file2]));
    });

    test("returns different hash when file path changes", () => {
      const file1 = createFileInfo("a/track.mp3", 1000, 1700000000000);
      const file2 = createFileInfo("b/track.mp3", 1000, 1700000000000);

      expect(computeHash([file1])).not.toBe(computeHash([file2]));
    });

    test("returns hex string", () => {
      const files = [createFileInfo("track.mp3", 1000, 1700000000000)];
      const hash = computeHash(files);

      expect(/^[0-9a-f]+$/i.test(hash)).toBe(true);
    });

    test("ignores fractional milliseconds in mtime", () => {
      const file1 = createFileInfo("track.mp3", 1000, 1700000000000.5);
      const file2 = createFileInfo("track.mp3", 1000, 1700000000000.9);

      expect(computeHash([file1])).toBe(computeHash([file2]));
    });
  });
});
