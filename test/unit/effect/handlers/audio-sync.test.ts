import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { audioSync } from "../../../../src/effect/handlers/audio-sync.ts";
import type { HandlerDeps } from "../../../../src/context.ts";
import type { EventType } from "../../../../src/effect/types.ts";
import type { LogContext } from "../../../../src/logging/types.ts";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdir, rm, stat, readFile, copyFile, readdir, rename, symlink, unlink } from "node:fs/promises";

const TEST_DIR = join(tmpdir(), `audio-sync-test-${Date.now()}`);
const FILES_DIR = join(TEST_DIR, "files");
const DATA_DIR = join(TEST_DIR, "data");
const FIXTURES_DIR = join(import.meta.dir, "../../../../test/fixtures/audio");

const mockLogger = {
  infoCalls: [] as Array<{ tag: string; msg: string; ctx?: LogContext }>,
  reset() {
    this.infoCalls = [];
  },
};

function realDeps(): HandlerDeps {
  return {
    config: { filesPath: FILES_DIR, dataPath: DATA_DIR, port: 3000, reconcileInterval: 1800 },
    logger: {
      info: (tag, msg, ctx) => {
        mockLogger.infoCalls.push({ tag, msg, ctx });
      },
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
    fs: {
      mkdir: async (path, options) => {
        await mkdir(path, options);
      },
      rm: (path, options) => rm(path, options),
      readdir: (path) => readdir(path),
      stat: async (path) => {
        const s = await stat(path);
        return { isDirectory: () => s.isDirectory(), size: s.size };
      },
      exists: async (path) => {
        try {
          await stat(path);
          return true;
        } catch {
          return false;
        }
      },
      writeFile: async (path, content) => {
        await Bun.write(path, content);
      },
      atomicWrite: async (path, content) => {
        const tmpPath = `${path}.tmp`;
        await Bun.write(tmpPath, content);
        await rename(tmpPath, path);
      },
      symlink: (target, path) => symlink(target, path),
      unlink: (path) => unlink(path),
    },
  };
}

const audioFileCreatedEvent = (relativePath: string): EventType => {
  const parts = relativePath.split("/");
  const name = parts.pop()!;
  const parent = join(FILES_DIR, parts.join("/"));
  return { _tag: "AudioFileCreated", parent, name };
};

describe("audioSync handler", () => {
  beforeEach(async () => {
    mockLogger.reset();
    await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
    await mkdir(FILES_DIR, { recursive: true });
    await mkdir(DATA_DIR, { recursive: true });
  });

  afterAll(async () => {
    await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
  });

  test("returns empty array for non-AudioFileCreated events", async () => {
    // #given
    const event: EventType = { _tag: "FolderCreated", parent: FILES_DIR, name: "Fiction" };
    // #when
    const result = await audioSync(event, realDeps());
    // #then
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual([]);
  });

  test("creates data directory for audio file", async () => {
    // #given
    const filePath = join(FILES_DIR, "track.mp3");
    await copyFile(join(FIXTURES_DIR, "tagged.mp3"), filePath);
    // #when
    await audioSync(audioFileCreatedEvent("track.mp3"), realDeps());
    // #then
    const dataDir = join(DATA_DIR, "track.mp3");
    const exists = await stat(dataDir)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(true);
  });

  test("creates entry.xml with episode format", async () => {
    // #given
    const filePath = join(FILES_DIR, "track.mp3");
    await copyFile(join(FIXTURES_DIR, "tagged.mp3"), filePath);
    // #when
    await audioSync(audioFileCreatedEvent("track.mp3"), realDeps());
    // #then
    const content = await readFile(join(DATA_DIR, "track.mp3", "entry.xml"), "utf-8");
    expect(content).toContain("<episode>");
    expect(content).toContain("<title>");
    expect(content).toContain("<fileName>track.mp3</fileName>");
    expect(content).toContain("<filePath>track.mp3</filePath>");
    expect(content).toContain("<mimeType>audio/mpeg</mimeType>");
    expect(content).toContain("<episodeNumber>1</episodeNumber>");
    expect(content).toContain("<pubDate>");
    expect(content).toContain("<guid>track.mp3</guid>");
    expect(content).toContain("<fileSize>");
  });

  test("extracts ID3 metadata into entry.xml", async () => {
    // #given
    await copyFile(join(FIXTURES_DIR, "tagged.mp3"), join(FILES_DIR, "track.mp3"));
    // #when
    await audioSync(audioFileCreatedEvent("track.mp3"), realDeps());
    // #then
    const content = await readFile(join(DATA_DIR, "track.mp3", "entry.xml"), "utf-8");
    expect(content).toContain("<title>");
    expect(content).toContain("<duration>");
  });

  test("handles untagged audio file gracefully", async () => {
    // #given
    await copyFile(join(FIXTURES_DIR, "untagged.mp3"), join(FILES_DIR, "untagged.mp3"));
    // #when
    await audioSync(audioFileCreatedEvent("untagged.mp3"), realDeps());
    // #then
    const content = await readFile(join(DATA_DIR, "untagged.mp3", "entry.xml"), "utf-8");
    expect(content).toContain("<episode>");
    expect(content).toContain("<title>");
    expect(content).toContain("<episodeNumber>1</episodeNumber>");
  });

  test("assigns sequential episode numbers", async () => {
    // #given
    const authorDir = join(FILES_DIR, "Author", "Album");
    await mkdir(authorDir, { recursive: true });
    await copyFile(join(FIXTURES_DIR, "tagged.mp3"), join(authorDir, "01.mp3"));
    const deps = realDeps();
    // #when
    await audioSync(audioFileCreatedEvent("Author/Album/01.mp3"), deps);
    await copyFile(join(FIXTURES_DIR, "tagged.mp3"), join(authorDir, "02.mp3"));
    await audioSync(audioFileCreatedEvent("Author/Album/02.mp3"), deps);
    // #then
    const entry1 = await readFile(join(DATA_DIR, "Author", "Album", "01.mp3", "entry.xml"), "utf-8");
    const entry2 = await readFile(join(DATA_DIR, "Author", "Album", "02.mp3", "entry.xml"), "utf-8");
    expect(entry1).toContain("<episodeNumber>1</episodeNumber>");
    expect(entry2).toContain("<episodeNumber>2</episodeNumber>");
  });

  test("handles nested folder structure", async () => {
    // #given
    const nestedPath = join(FILES_DIR, "Author", "Album");
    await mkdir(nestedPath, { recursive: true });
    await copyFile(join(FIXTURES_DIR, "tagged.mp3"), join(nestedPath, "track.mp3"));
    // #when
    await audioSync(audioFileCreatedEvent("Author/Album/track.mp3"), realDeps());
    // #then
    const dataDir = join(DATA_DIR, "Author", "Album", "track.mp3");
    const exists = await stat(dataDir)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(true);
  });

  test("logs processing info", async () => {
    // #given
    await copyFile(join(FIXTURES_DIR, "tagged.mp3"), join(FILES_DIR, "track.mp3"));
    // #when
    await audioSync(audioFileCreatedEvent("track.mp3"), realDeps());
    // #then
    expect(mockLogger.infoCalls.some((c) => c.tag === "AudioSync" && c.msg.includes("Processing"))).toBe(true);
    expect(mockLogger.infoCalls.some((c) => c.tag === "AudioSync" && c.msg.includes("Done"))).toBe(true);
  });

  test("uses ID3 date for pubDate when available", async () => {
    // #given
    await copyFile(join(FIXTURES_DIR, "tagged.mp3"), join(FILES_DIR, "track.mp3"));
    // #when
    await audioSync(audioFileCreatedEvent("track.mp3"), realDeps());
    // #then
    const content = await readFile(join(DATA_DIR, "track.mp3", "entry.xml"), "utf-8");
    const pubDateMatch = content.match(/<pubDate>([^<]+)<\/pubDate>/);
    expect(pubDateMatch).not.toBeNull();
    const pubDate = new Date(pubDateMatch![1]!);
    expect(Number.isNaN(pubDate.getTime())).toBe(false);
  });

  test("returns empty cascade array", async () => {
    // #given
    await copyFile(join(FIXTURES_DIR, "tagged.mp3"), join(FILES_DIR, "track.mp3"));
    // #when
    const result = await audioSync(audioFileCreatedEvent("track.mp3"), realDeps());
    // #then
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual([]);
  });
});
