import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { audioSync } from "../../../src/effect/handlers/audio-sync.ts";
import { folderSync } from "../../../src/effect/handlers/folder-sync.ts";
import type { HandlerDeps } from "../../../src/context.ts";
import type { EventType } from "../../../src/effect/types.ts";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdir, rm, stat, readFile, copyFile, readdir, rename, unlink, symlink } from "node:fs/promises";

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

function realDeps(): HandlerDeps {
  return {
    config: { filesPath: FILES_DIR, dataPath: DATA_DIR, port: 3000, reconcileInterval: 1800 },
    logger: {
      info: (tag, msg) => mockLogger.calls.push({ level: "info", tag, msg }),
      warn: (tag, msg) => mockLogger.calls.push({ level: "warn", tag, msg }),
      error: (tag, msg) => mockLogger.calls.push({ level: "error", tag, msg }),
      debug: (tag, msg) => mockLogger.calls.push({ level: "debug", tag, msg }),
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
    await folderSync(folderEvent, realDeps());

    const albumDataPath = join(DATA_DIR, "Author", "Album");
    const entryXmlPath = join(albumDataPath, "_entry.xml");
    const entryExists = await stat(entryXmlPath)
      .then(() => true)
      .catch(() => false);
    expect(entryExists).toBe(true);

    await copyFile(join(AUDIO_FIXTURES, "tagged.mp3"), join(albumPath, "01.mp3"));

    const audioEvent: EventType = { _tag: "AudioFileCreated", parent: albumPath, name: "01.mp3" };
    const audioResult = await audioSync(audioEvent, realDeps());

    expect(audioResult.isOk()).toBe(true);
    expect(audioResult._unsafeUnwrap()).toEqual([]);

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

    const deps = realDeps();
    await audioSync(event1, deps);
    await audioSync(event2, deps);
    await audioSync(event3, deps);

    const entry1 = await readFile(join(DATA_DIR, "Author", "Album", "01.mp3", "entry.xml"), "utf-8");
    const entry2 = await readFile(join(DATA_DIR, "Author", "Album", "02.mp3", "entry.xml"), "utf-8");
    const entry3 = await readFile(join(DATA_DIR, "Author", "Album", "03.mp3", "entry.xml"), "utf-8");

    expect(entry1).toContain("<episodeNumber>1</episodeNumber>");
    expect(entry2).toContain("<episodeNumber>2</episodeNumber>");
    expect(entry3).toContain("<episodeNumber>3</episodeNumber>");
  });
});
