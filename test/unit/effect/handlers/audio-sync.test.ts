import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { Effect, Layer } from "effect";
import { ConfigService, LoggerService, FileSystemService } from "../../../../src/effect/services.ts";
import { audioSync } from "../../../../src/effect/handlers/audio-sync.ts";
import type { EventType } from "../../../../src/effect/types.ts";
import type { LogContext } from "../../../../src/logging/types.ts";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdir, rm, readdir, stat, readFile, lstat } from "node:fs/promises";

const TEST_DIR = join(tmpdir(), `audio-sync-test-${Date.now()}`);
const FILES_DIR = join(TEST_DIR, "files");
const DATA_DIR = join(TEST_DIR, "data");
const FIXTURES_DIR = join(import.meta.dir, "../../../../files/test");

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
  readdir: (path) => Effect.promise(() => readdir(path)),
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

// NOTE: This test file will be fully rewritten in Task 5 when audio-sync handler
// is reimplemented for audio files. Currently tests the transitional state where
// the handler still uses opds-ts internally.
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
    const filePath = join(FILES_DIR, "test.epub");
    await Bun.write(filePath, "fake content");

    await Effect.runPromise(Effect.provide(audioSync(audioFileCreatedEvent("test.epub")), TestLayer));

    const dataDir = join(DATA_DIR, "test.epub");
    const exists = await stat(dataDir)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(true);
  });

  test("creates entry.xml", async () => {
    const filePath = join(FILES_DIR, "test.epub");
    await Bun.write(filePath, "fake content");

    await Effect.runPromise(Effect.provide(audioSync(audioFileCreatedEvent("test.epub")), TestLayer));

    const entryPath = join(DATA_DIR, "test.epub", "entry.xml");
    const entryContent = await readFile(entryPath, "utf-8");

    expect(entryContent).toContain("<entry");
    expect(entryContent).toContain("test");
  });

  test("creates symlink to original file", async () => {
    const filePath = join(FILES_DIR, "test.epub");
    await Bun.write(filePath, "fake content");

    await Effect.runPromise(Effect.provide(audioSync(audioFileCreatedEvent("test.epub")), TestLayer));

    const symlinkPath = join(DATA_DIR, "test.epub", "test.epub");
    const linkStat = await lstat(symlinkPath);
    expect(linkStat.isSymbolicLink()).toBe(true);
  });

  test("handles nested folder structure", async () => {
    const nestedPath = join(FILES_DIR, "Fiction", "Author");
    await mkdir(nestedPath, { recursive: true });
    const filePath = join(nestedPath, "file.epub");
    await Bun.write(filePath, "fake content");

    await Effect.runPromise(Effect.provide(audioSync(audioFileCreatedEvent("Fiction/Author/file.epub")), TestLayer));

    const dataDir = join(DATA_DIR, "Fiction", "Author", "file.epub");
    const exists = await stat(dataDir)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(true);
  });

  test("logs processing info", async () => {
    const filePath = join(FILES_DIR, "test.epub");
    await Bun.write(filePath, "fake content");

    await Effect.runPromise(Effect.provide(audioSync(audioFileCreatedEvent("test.epub")), TestLayer));

    expect(mockLogger.infoCalls.some((c) => c.tag === "AudioSync" && c.msg.includes("Processing"))).toBe(true);
    expect(mockLogger.infoCalls.some((c) => c.tag === "AudioSync" && c.msg.includes("Done"))).toBe(true);
  });
});
