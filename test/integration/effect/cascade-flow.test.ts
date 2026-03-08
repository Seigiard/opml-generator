import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { Effect, Layer } from "effect";
import { ConfigService, LoggerService, FileSystemService } from "../../../src/effect/services.ts";
import { audioSync } from "../../../src/effect/handlers/audio-sync.ts";
import { folderSync } from "../../../src/effect/handlers/folder-sync.ts";
import { folderMetaSync } from "../../../src/effect/handlers/folder-meta-sync.ts";
import type { EventType } from "../../../src/effect/types.ts";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdir, rm, stat, readFile } from "node:fs/promises";

const TEST_DIR = join(tmpdir(), `cascade-test-${Date.now()}`);
const FILES_DIR = join(TEST_DIR, "files");
const DATA_DIR = join(TEST_DIR, "data");
const FIXTURES_DIR = join(import.meta.dir, "../../../files/test");

const mockLogger = {
  calls: [] as Array<{ level: string; tag: string; msg: string }>,
  reset() {
    this.calls = [];
  },
};

const TestConfigService = Layer.succeed(ConfigService, {
  filesPath: FILES_DIR,
  dataPath: DATA_DIR,
  port: 3000,
});

const TestLoggerService = Layer.succeed(LoggerService, {
  info: (tag, msg) =>
    Effect.sync(() => {
      mockLogger.calls.push({ level: "info", tag, msg });
    }),
  warn: (tag, msg) =>
    Effect.sync(() => {
      mockLogger.calls.push({ level: "warn", tag, msg });
    }),
  error: (tag, msg) =>
    Effect.sync(() => {
      mockLogger.calls.push({ level: "error", tag, msg });
    }),
  debug: (tag, msg) =>
    Effect.sync(() => {
      mockLogger.calls.push({ level: "debug", tag, msg });
    }),
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

// NOTE: These integration tests still use EPUB fixtures with the transitional
// audio-sync handler (which internally still uses opds-ts). Will be fully
// rewritten when audio-sync is reimplemented in Task 5.
describe("Cascade Flow Integration", () => {
  beforeEach(async () => {
    mockLogger.reset();
    await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
    await mkdir(FILES_DIR, { recursive: true });
    await mkdir(DATA_DIR, { recursive: true });
  });

  afterAll(async () => {
    await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
  });

  test("full cascade: FolderCreated → AudioFileCreated → FolderMetaSync", async () => {
    const fictionPath = join(FILES_DIR, "Fiction");
    await mkdir(fictionPath, { recursive: true });

    const folderEvent: EventType = { _tag: "FolderCreated", parent: FILES_DIR, name: "Fiction" };
    await Effect.runPromise(Effect.provide(folderSync(folderEvent), TestLayer));

    const fictionDataPath = join(DATA_DIR, "Fiction");
    const entryXmlPath = join(fictionDataPath, "_entry.xml");
    const entryExists = await stat(entryXmlPath)
      .then(() => true)
      .catch(() => false);
    expect(entryExists).toBe(true);

    const realEpubPath = join(FIXTURES_DIR, "Test Book - Test Author.epub");
    const testBookPath = join(fictionPath, "Test Book - Test Author.epub");
    const epubContent = await Bun.file(realEpubPath).arrayBuffer();
    await Bun.write(testBookPath, epubContent);

    const audioEvent: EventType = { _tag: "AudioFileCreated", parent: fictionPath, name: "Test Book - Test Author.epub" };
    await Effect.runPromise(Effect.provide(audioSync(audioEvent), TestLayer));

    const bookDataPath = join(DATA_DIR, "Fiction", "Test Book - Test Author.epub");
    const bookEntryPath = join(bookDataPath, "entry.xml");
    const coverPath = join(bookDataPath, "cover.jpg");
    const symlinkPath = join(bookDataPath, "Test Book - Test Author.epub");

    expect(
      await stat(bookEntryPath)
        .then(() => true)
        .catch(() => false),
    ).toBe(true);
    expect(
      await stat(coverPath)
        .then(() => true)
        .catch(() => false),
    ).toBe(true);
    expect(
      await stat(symlinkPath)
        .then(() => true)
        .catch(() => false),
    ).toBe(true);

    const folderMetaEvent: EventType = { _tag: "FolderMetaSyncRequested", path: fictionDataPath };
    await Effect.runPromise(Effect.provide(folderMetaSync(folderMetaEvent), TestLayer));

    const feedPath = join(fictionDataPath, "feed.xml");
    const feedContent = await readFile(feedPath, "utf-8");

    expect(feedContent).toContain("<feed");
    expect(feedContent).toContain("Test Book");
    expect(feedContent).toContain("Test Author");

    const rootMetaEvent: EventType = { _tag: "FolderMetaSyncRequested", path: DATA_DIR };
    await Effect.runPromise(Effect.provide(folderMetaSync(rootMetaEvent), TestLayer));

    const rootFeedPath = join(DATA_DIR, "feed.xml");
    const rootFeedContent = await readFile(rootFeedPath, "utf-8");

    expect(rootFeedContent).toContain("<feed");
    expect(rootFeedContent).toContain("Fiction");
  });

  test("cascade produces correct structure", async () => {
    const authorPath = join(FILES_DIR, "Author");
    await mkdir(authorPath, { recursive: true });

    const realEpubPath = join(FIXTURES_DIR, "Test Book - Test Author.epub");
    const testBookPath = join(authorPath, "Test Book - Test Author.epub");
    const epubContent = await Bun.file(realEpubPath).arrayBuffer();
    await Bun.write(testBookPath, epubContent);

    const folderEvent: EventType = { _tag: "FolderCreated", parent: FILES_DIR, name: "Author" };
    await Effect.runPromise(Effect.provide(folderSync(folderEvent), TestLayer));

    const audioEvent: EventType = { _tag: "AudioFileCreated", parent: authorPath, name: "Test Book - Test Author.epub" };
    await Effect.runPromise(Effect.provide(audioSync(audioEvent), TestLayer));

    const folderMetaEvent: EventType = { _tag: "FolderMetaSyncRequested", path: join(DATA_DIR, "Author") };
    await Effect.runPromise(Effect.provide(folderMetaSync(folderMetaEvent), TestLayer));

    const rootMetaEvent: EventType = { _tag: "FolderMetaSyncRequested", path: DATA_DIR };
    await Effect.runPromise(Effect.provide(folderMetaSync(rootMetaEvent), TestLayer));

    const rootFeed = await readFile(join(DATA_DIR, "feed.xml"), "utf-8");
    const authorFeed = await readFile(join(DATA_DIR, "Author", "feed.xml"), "utf-8");
    const bookEntry = await readFile(join(DATA_DIR, "Author", "Test Book - Test Author.epub", "entry.xml"), "utf-8");

    expect(rootFeed).toContain("Author");
    expect(authorFeed).toContain("Test Book");
    expect(bookEntry).toContain("Test Book");
    expect(bookEntry).toContain("Test Author");
  });
});
