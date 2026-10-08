import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Effect } from "effect";
import { XMLParser } from "fast-xml-parser";
import { acquireOutputTree } from "@seigiard/sync-engine";
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { openEpisodeSynchronization } from "../../src/engine/composition.ts";
import { opmlEngineStatePath } from "../../src/engine/policy.ts";
import type { HandlerDeps } from "../../src/context.ts";
import { createTempDir, cleanupTempDir } from "../helpers/fs-helpers.ts";

const AUDIO_FIXTURES = join(import.meta.dir, "../fixtures/audio");

const parser = new XMLParser({ ignoreAttributes: false });

let root = "";

let filesPath = "";

let dataPath = "";

function realDeps(): HandlerDeps {
  return {
    config: {
      filesPath,
      dataPath,
      port: 3000,
      reconcileInterval: 0,
    },
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    },
    fs: {
      mkdir: async (path, options) => {
        await mkdir(path, options);
      },
      rm: (path, options) => rm(path, options),
      readdir: (path) => readdir(path),
      lstat: (path) => lstat(path),
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

async function readEpisode(path: string) {
  const content = await Bun.file(path).text();

  // SAFETY: test fixtures assert the exact episode XML shape after parsing.
  return parser.parse(content).episode as Record<string, string | number>;
}

describe("episode sync engine composition", () => {
  beforeEach(async () => {
    root = await createTempDir("opml-engine-episode");
    filesPath = join(root, "audiobooks");
    dataPath = join(root, "data");
    await mkdir(filesPath, { recursive: true });
    await mkdir(dataPath, { recursive: true });
  });

  afterEach(async () => {
    await cleanupTempDir(root);
  });

  test("publishes one real audio fixture as an episode entry", async () => {
    // #given
    await mkdir(join(filesPath, "Author", "Album"), { recursive: true });
    await copyFile(
      join(AUDIO_FIXTURES, "tagged.mp3"),
      join(filesPath, "Author", "Album", "01.mp3"),
    );

    // #when
    await Effect.runPromise(
      Effect.scoped(openEpisodeSynchronization({ ...realDeps(), reconcileIntervalMs: 0 })),
    );

    // #then
    const episode = await readEpisode(join(dataPath, "Author", "Album", "01.mp3", "entry.xml"));
    expect(episode).toEqual({
      title: "Test Title",
      fileName: "01.mp3",
      filePath: "Author/Album/01.mp3",
      fileSize: 8710,
      mimeType: "audio/mpeg",
      duration: 1,
      discNumber: 1,
      trackNumber: 3,
      episodeNumber: 1,
      pubDate: "2024-01-01T00:00:00.000Z",
      guid: "Author/Album/01.mp3",
    });
  });

  test("keeps cache projection names separate from the engine state area", async () => {
    // #given
    await mkdir(join(filesPath, "feed.xml"), { recursive: true });
    await mkdir(join(filesPath, "~feed.xml"), { recursive: true });
    await copyFile(join(AUDIO_FIXTURES, "tagged.mp3"), join(filesPath, "feed.xml", "01.mp3"));
    await copyFile(join(AUDIO_FIXTURES, "tagged.mp3"), join(filesPath, "~feed.xml", "02.mp3"));

    // #when
    await Effect.runPromise(
      Effect.scoped(openEpisodeSynchronization({ ...realDeps(), reconcileIntervalMs: 0 })),
    );

    // #then
    const reservedNameEpisode = await readEpisode(
      join(dataPath, "~", "feed.xml", "01.mp3", "entry.xml"),
    );

    const prefixNameEpisode = await readEpisode(join(dataPath, "~feed.xml", "02.mp3", "entry.xml"));

    expect({
      reservedPath: reservedNameEpisode.filePath,
      prefixPath: prefixNameEpisode.filePath,
      stateExists: await Bun.file(join(dataPath, "~", ".sync-engine", "lock")).exists(),
      misplacedEntryExists: await Bun.file(
        join(dataPath, "~", ".sync-engine", "01.mp3", "entry.xml"),
      ).exists(),
    }).toEqual({
      reservedPath: "feed.xml/01.mp3",
      prefixPath: "~feed.xml/02.mp3",
      stateExists: true,
      misplacedEntryExists: false,
    });
  });

  test("refuses a second owner for the same output tree", async () => {
    // #given
    const release = await Effect.runPromise(
      acquireOutputTree(dataPath, opmlEngineStatePath(dataPath)),
    );

    await mkdir(join(filesPath, "Author"), { recursive: true });
    await copyFile(join(AUDIO_FIXTURES, "tagged.mp3"), join(filesPath, "Author", "01.mp3"));

    try {
      // #when
      const result = await Effect.runPromiseExit(
        Effect.scoped(openEpisodeSynchronization({ ...realDeps(), reconcileIntervalMs: 0 })),
      );

      // #then
      expect(result._tag).toBe("Failure");
    } finally {
      await release();
    }
  });
});
