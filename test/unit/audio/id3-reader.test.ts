import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { readAudioMetadata, extractEmbeddedCover } from "../../../src/audio/id3-reader.ts";

const FIXTURES = join(import.meta.dir, "../../fixtures/audio");

describe("audio/id3-reader", () => {
  describe("readAudioMetadata", () => {
    test("reads ID3 tags from MP3", async () => {
      // #given
      const filePath = join(FIXTURES, "tagged.mp3");

      // #when
      const meta = await readAudioMetadata(filePath);

      // #then
      expect(meta.title).toBe("Test Title");
      expect(meta.artist).toBe("Test Artist");
      expect(meta.album).toBe("Test Album");
      expect(meta.trackNumber).toBe(3);
      expect(meta.discNumber).toBe(1);
      expect(meta.date).toBe("2024");
      expect(meta.genre).toBe("Rock");
    });

    test("reads tags from M4A", async () => {
      // #given
      const filePath = join(FIXTURES, "tagged.m4a");

      // #when
      const meta = await readAudioMetadata(filePath);

      // #then
      expect(meta.title).toBe("M4A Title");
      expect(meta.artist).toBe("M4A Artist");
    });

    test("reads tags from OGG", async () => {
      // #given
      const filePath = join(FIXTURES, "tagged.ogg");

      // #when
      const meta = await readAudioMetadata(filePath);

      // #then
      expect(meta.title).toBe("OGG Title");
      expect(meta.artist).toBe("OGG Artist");
    });

    test("falls back to filename when no title tag", async () => {
      // #given
      const filePath = join(FIXTURES, "untagged.mp3");

      // #when
      const meta = await readAudioMetadata(filePath);

      // #then
      expect(meta.title).toBe("untagged");
    });

    test("returns undefined for missing optional fields", async () => {
      // #given
      const filePath = join(FIXTURES, "untagged.mp3");

      // #when
      const meta = await readAudioMetadata(filePath);

      // #then
      expect(meta.artist).toBeUndefined();
      expect(meta.album).toBeUndefined();
      expect(meta.genre).toBeUndefined();
    });

    test("extracts duration", async () => {
      // #given
      const filePath = join(FIXTURES, "tagged.mp3");

      // #when
      const meta = await readAudioMetadata(filePath);

      // #then
      expect(meta.duration).toBeGreaterThan(0);
      expect(meta.duration).toBeLessThan(2);
    });
  });

  describe("extractEmbeddedCover", () => {
    test("returns null when no embedded cover", async () => {
      // #given
      const filePath = join(FIXTURES, "tagged.mp3");

      // #when
      const cover = await extractEmbeddedCover(filePath);

      // #then
      expect(cover).toBeNull();
    });
  });
});
