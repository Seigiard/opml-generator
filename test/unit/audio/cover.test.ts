import { describe, test, expect, afterAll } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { findFolderCover } from "../../../src/audio/cover.ts";

const TEST_DIR = join(tmpdir(), `audio-cover-test-${Date.now()}`);

afterAll(async () => {
  await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
});

describe("audio/cover", () => {
  describe("findFolderCover", () => {
    test("finds cover.jpg by exact name", async () => {
      // #given
      const dir = join(TEST_DIR, "exact-cover");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "cover.jpg"), "fake-image");
      await writeFile(join(dir, "other.txt"), "text");

      // #when
      const result = await findFolderCover(dir);

      // #then
      expect(result).toBe(join(dir, "cover.jpg"));
    });

    test("finds cover.png over arbitrary images", async () => {
      // #given
      const dir = join(TEST_DIR, "cover-png");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "cover.png"), "fake-image");
      await writeFile(join(dir, "random.jpg"), "fake-image");

      // #when
      const result = await findFolderCover(dir);

      // #then
      expect(result).toBe(join(dir, "cover.png"));
    });

    test("finds folder.jpg as known cover filename", async () => {
      // #given
      const dir = join(TEST_DIR, "folder-jpg");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "folder.jpg"), "fake-image");

      // #when
      const result = await findFolderCover(dir);

      // #then
      expect(result).toBe(join(dir, "folder.jpg"));
    });

    test("falls back to any image file", async () => {
      // #given
      const dir = join(TEST_DIR, "fallback");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "episode01.mp3"), "audio");
      await writeFile(join(dir, "artwork.jpg"), "fake-image");

      // #when
      const result = await findFolderCover(dir);

      // #then
      expect(result).toBe(join(dir, "artwork.jpg"));
    });

    test("returns null when no images exist", async () => {
      // #given
      const dir = join(TEST_DIR, "no-images");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "episode.mp3"), "audio");
      await writeFile(join(dir, "notes.txt"), "text");

      // #when
      const result = await findFolderCover(dir);

      // #then
      expect(result).toBeNull();
    });

    test("returns null for nonexistent directory", async () => {
      // #when
      const result = await findFolderCover(join(TEST_DIR, "nonexistent"));

      // #then
      expect(result).toBeNull();
    });

    test("matches cover filenames case-insensitively", async () => {
      // #given
      const dir = join(TEST_DIR, "case-insensitive");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "Cover.JPG"), "fake-image");

      // #when
      const result = await findFolderCover(dir);

      // #then
      expect(result).toBe(join(dir, "Cover.JPG"));
    });
  });
});
