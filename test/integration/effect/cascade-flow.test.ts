import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { Effect, Layer } from "effect";
import { ConfigService, LoggerService, FileSystemService } from "../../../src/effect/services.ts";
import { audioSync } from "../../../src/effect/handlers/audio-sync.ts";
import { folderSync } from "../../../src/effect/handlers/folder-sync.ts";
import type { EventType } from "../../../src/effect/types.ts";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdir, rm, stat, readFile, copyFile } from "node:fs/promises";

const TEST_DIR = join(tmpdir(), `cascade-test-${Date.now()}`);
const FILES_DIR = join(TEST_DIR, "files");
const DATA_DIR = join(TEST_DIR, "data");
const AUDIO_FIXTURES = join(import.meta.dir, "../../../test/fixtures/audio");

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

  test("FolderCreated → AudioFileCreated produces entry.xml", async () => {
    const albumPath = join(FILES_DIR, "Author", "Album");
    await mkdir(albumPath, { recursive: true });

    const folderEvent: EventType = { _tag: "FolderCreated", parent: join(FILES_DIR, "Author"), name: "Album" };
    await Effect.runPromise(Effect.provide(folderSync(folderEvent), TestLayer));

    const albumDataPath = join(DATA_DIR, "Author", "Album");
    const entryXmlPath = join(albumDataPath, "_entry.xml");
    const entryExists = await stat(entryXmlPath)
      .then(() => true)
      .catch(() => false);
    expect(entryExists).toBe(true);

    await copyFile(join(AUDIO_FIXTURES, "tagged.mp3"), join(albumPath, "01.mp3"));

    const audioEvent: EventType = { _tag: "AudioFileCreated", parent: albumPath, name: "01.mp3" };
    const cascades = await Effect.runPromise(Effect.provide(audioSync(audioEvent), TestLayer));

    expect(cascades).toEqual([]);

    const episodeDataPath = join(DATA_DIR, "Author", "Album", "01.mp3");
    const episodeEntryPath = join(episodeDataPath, "entry.xml");
    const episodeEntryExists = await stat(episodeEntryPath)
      .then(() => true)
      .catch(() => false);
    expect(episodeEntryExists).toBe(true);

    const content = await readFile(episodeEntryPath, "utf-8");
    expect(content).toContain("<episode>");
    expect(content).toContain("<episodeNumber>1</episodeNumber>");
    expect(content).toContain("<mimeType>audio/mpeg</mimeType>");
  });

  test("multiple audio files get sequential episode numbers", async () => {
    const albumPath = join(FILES_DIR, "Author", "Album");
    await mkdir(albumPath, { recursive: true });

    await copyFile(join(AUDIO_FIXTURES, "tagged.mp3"), join(albumPath, "01.mp3"));
    await copyFile(join(AUDIO_FIXTURES, "tagged.mp3"), join(albumPath, "02.mp3"));
    await copyFile(join(AUDIO_FIXTURES, "tagged.mp3"), join(albumPath, "03.mp3"));

    const event1: EventType = { _tag: "AudioFileCreated", parent: albumPath, name: "01.mp3" };
    const event2: EventType = { _tag: "AudioFileCreated", parent: albumPath, name: "02.mp3" };
    const event3: EventType = { _tag: "AudioFileCreated", parent: albumPath, name: "03.mp3" };

    await Effect.runPromise(Effect.provide(audioSync(event1), TestLayer));
    await Effect.runPromise(Effect.provide(audioSync(event2), TestLayer));
    await Effect.runPromise(Effect.provide(audioSync(event3), TestLayer));

    const entry1 = await readFile(join(DATA_DIR, "Author", "Album", "01.mp3", "entry.xml"), "utf-8");
    const entry2 = await readFile(join(DATA_DIR, "Author", "Album", "02.mp3", "entry.xml"), "utf-8");
    const entry3 = await readFile(join(DATA_DIR, "Author", "Album", "03.mp3", "entry.xml"), "utf-8");

    expect(entry1).toContain("<episodeNumber>1</episodeNumber>");
    expect(entry2).toContain("<episodeNumber>2</episodeNumber>");
    expect(entry3).toContain("<episodeNumber>3</episodeNumber>");
  });
});
