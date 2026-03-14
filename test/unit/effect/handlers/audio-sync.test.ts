import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { Effect, Layer } from "effect";
import { ConfigService, LoggerService, FileSystemService } from "../../../../src/effect/services.ts";
import { audioSync } from "../../../../src/effect/handlers/audio-sync.ts";
import type { EventType } from "../../../../src/effect/types.ts";
import type { LogContext } from "../../../../src/logging/types.ts";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdir, rm, stat, readFile, copyFile } from "node:fs/promises";

const TEST_DIR = join(tmpdir(), `audio-sync-test-${Date.now()}`);
const FILES_DIR = join(TEST_DIR, "files");
const DATA_DIR = join(TEST_DIR, "data");
const FIXTURES_DIR = join(import.meta.dir, "../../../../test/fixtures/audio");

const mockLogger = {
  infoCalls: [] as Array<{ tag: string; msg: string; ctx?: LogContext }>,
  warnCalls: [] as Array<{ tag: string; msg: string }>,
  reset() {
    this.infoCalls = [];
    this.warnCalls = [];
  },
};

const TestConfigService = Layer.succeed(ConfigService, {
  filesPath: FILES_DIR,
  dataPath: DATA_DIR,
  port: 3000,
  reconcileInterval: 1800,
});

const TestLoggerService = Layer.succeed(LoggerService, {
  info: (tag, msg, ctx) =>
    Effect.sync(() => {
      mockLogger.infoCalls.push({ tag, msg, ctx });
    }),
  warn: (tag, msg) =>
    Effect.sync(() => {
      mockLogger.warnCalls.push({ tag, msg });
    }),
  error: () => Effect.void,
  debug: () => Effect.void,
});

const RealFileSystemService = Layer.succeed(FileSystemService, {
  mkdir: (path, options) => Effect.promise(() => mkdir(path, options)),
  rm: (path, options) => Effect.promise(() => rm(path, options)),
  readdir: (path) =>
    Effect.promise(async () => {
      const fs = await import("node:fs/promises");
      return fs.readdir(path);
    }),
  stat: (path) =>
    Effect.promise(async () => {
      const s = await stat(path);
      return { isDirectory: () => s.isDirectory(), size: s.size };
    }),
  exists: (path) =>
    Effect.promise(async () => {
      try {
        await stat(path);
        return true;
      } catch {
        return false;
      }
    }),
  writeFile: (path, content) => Effect.promise(() => Bun.write(path, content)),
  atomicWrite: (path, content) => Effect.promise(() => Bun.write(path, content)),
  symlink: (target, path) =>
    Effect.promise(async () => {
      const fs = await import("node:fs/promises");
      await fs.symlink(target, path);
    }),
  unlink: (path) =>
    Effect.promise(async () => {
      const fs = await import("node:fs/promises");
      await fs.unlink(path);
    }),
});

const TestLayer = Layer.mergeAll(TestConfigService, TestLoggerService, RealFileSystemService);

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
    const event: EventType = { _tag: "FolderCreated", parent: FILES_DIR, name: "Fiction" };
    const cascades = await Effect.runPromise(Effect.provide(audioSync(event), TestLayer));
    expect(cascades).toEqual([]);
  });

  test("creates data directory for audio file", async () => {
    const filePath = join(FILES_DIR, "track.mp3");
    await copyFile(join(FIXTURES_DIR, "tagged.mp3"), filePath);

    await Effect.runPromise(Effect.provide(audioSync(audioFileCreatedEvent("track.mp3")), TestLayer));

    const dataDir = join(DATA_DIR, "track.mp3");
    const exists = await stat(dataDir)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(true);
  });

  test("creates entry.xml with episode format", async () => {
    const filePath = join(FILES_DIR, "track.mp3");
    await copyFile(join(FIXTURES_DIR, "tagged.mp3"), filePath);

    await Effect.runPromise(Effect.provide(audioSync(audioFileCreatedEvent("track.mp3")), TestLayer));

    const entryPath = join(DATA_DIR, "track.mp3", "entry.xml");
    const content = await readFile(entryPath, "utf-8");

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
    const filePath = join(FILES_DIR, "track.mp3");
    await copyFile(join(FIXTURES_DIR, "tagged.mp3"), filePath);

    await Effect.runPromise(Effect.provide(audioSync(audioFileCreatedEvent("track.mp3")), TestLayer));

    const content = await readFile(join(DATA_DIR, "track.mp3", "entry.xml"), "utf-8");

    expect(content).toContain("<title>");
    expect(content).toContain("<duration>");
  });

  test("handles untagged audio file gracefully", async () => {
    const filePath = join(FILES_DIR, "untagged.mp3");
    await copyFile(join(FIXTURES_DIR, "untagged.mp3"), filePath);

    await Effect.runPromise(Effect.provide(audioSync(audioFileCreatedEvent("untagged.mp3")), TestLayer));

    const content = await readFile(join(DATA_DIR, "untagged.mp3", "entry.xml"), "utf-8");
    expect(content).toContain("<episode>");
    expect(content).toContain("<title>");
    expect(content).toContain("<episodeNumber>1</episodeNumber>");
  });

  test("assigns sequential episode numbers", async () => {
    const authorDir = join(FILES_DIR, "Author", "Album");
    await mkdir(authorDir, { recursive: true });

    await copyFile(join(FIXTURES_DIR, "tagged.mp3"), join(authorDir, "01.mp3"));
    await Effect.runPromise(Effect.provide(audioSync(audioFileCreatedEvent("Author/Album/01.mp3")), TestLayer));

    await copyFile(join(FIXTURES_DIR, "tagged.mp3"), join(authorDir, "02.mp3"));
    await Effect.runPromise(Effect.provide(audioSync(audioFileCreatedEvent("Author/Album/02.mp3")), TestLayer));

    const entry1 = await readFile(join(DATA_DIR, "Author", "Album", "01.mp3", "entry.xml"), "utf-8");
    const entry2 = await readFile(join(DATA_DIR, "Author", "Album", "02.mp3", "entry.xml"), "utf-8");

    expect(entry1).toContain("<episodeNumber>1</episodeNumber>");
    expect(entry2).toContain("<episodeNumber>2</episodeNumber>");
  });

  test("handles nested folder structure", async () => {
    const nestedPath = join(FILES_DIR, "Author", "Album");
    await mkdir(nestedPath, { recursive: true });
    await copyFile(join(FIXTURES_DIR, "tagged.mp3"), join(nestedPath, "track.mp3"));

    await Effect.runPromise(Effect.provide(audioSync(audioFileCreatedEvent("Author/Album/track.mp3")), TestLayer));

    const dataDir = join(DATA_DIR, "Author", "Album", "track.mp3");
    const exists = await stat(dataDir)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(true);
  });

  test("does not create symlink", async () => {
    const filePath = join(FILES_DIR, "track.mp3");
    await copyFile(join(FIXTURES_DIR, "tagged.mp3"), filePath);

    await Effect.runPromise(Effect.provide(audioSync(audioFileCreatedEvent("track.mp3")), TestLayer));

    const symlinkPath = join(DATA_DIR, "track.mp3", "track.mp3");
    const exists = await stat(symlinkPath)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);
  });

  test("logs processing info", async () => {
    const filePath = join(FILES_DIR, "track.mp3");
    await copyFile(join(FIXTURES_DIR, "tagged.mp3"), filePath);

    await Effect.runPromise(Effect.provide(audioSync(audioFileCreatedEvent("track.mp3")), TestLayer));

    expect(mockLogger.infoCalls.some((c) => c.tag === "AudioSync" && c.msg.includes("Processing"))).toBe(true);
    expect(mockLogger.infoCalls.some((c) => c.tag === "AudioSync" && c.msg.includes("Done"))).toBe(true);
  });

  test("uses ID3 date for pubDate when available", async () => {
    const filePath = join(FILES_DIR, "track.mp3");
    await copyFile(join(FIXTURES_DIR, "tagged.mp3"), filePath);

    await Effect.runPromise(Effect.provide(audioSync(audioFileCreatedEvent("track.mp3")), TestLayer));

    const content = await readFile(join(DATA_DIR, "track.mp3", "entry.xml"), "utf-8");
    const pubDateMatch = content.match(/<pubDate>([^<]+)<\/pubDate>/);
    expect(pubDateMatch).not.toBeNull();
    const pubDate = new Date(pubDateMatch![1]!);
    expect(Number.isNaN(pubDate.getTime())).toBe(false);
  });

  test("returns empty cascade array", async () => {
    const filePath = join(FILES_DIR, "track.mp3");
    await copyFile(join(FIXTURES_DIR, "tagged.mp3"), filePath);

    const cascades = await Effect.runPromise(Effect.provide(audioSync(audioFileCreatedEvent("track.mp3")), TestLayer));
    expect(cascades).toEqual([]);
  });
});
