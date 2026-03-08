import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { Effect, Layer } from "effect";
import { ConfigService, LoggerService, FileSystemService } from "../../../../src/effect/services.ts";
import { folderMetaSync } from "../../../../src/effect/handlers/folder-meta-sync.ts";
import type { EventType } from "../../../../src/effect/types.ts";
import type { LogContext } from "../../../../src/logging/types.ts";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdir, rm, stat, readFile } from "node:fs/promises";
import { XMLBuilder } from "fast-xml-parser";

const TEST_DIR = join(tmpdir(), `folder-meta-test-${Date.now()}`);
const DATA_DIR = join(TEST_DIR, "data");
const FILES_DIR = join(TEST_DIR, "files");

const xmlBuilder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  format: true,
  suppressEmptyNode: true,
});

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
  symlink: () => Effect.void,
  unlink: () => Effect.void,
});

const TestLayer = Layer.mergeAll(TestConfigService, TestLoggerService, RealFileSystemService);

const folderMetaSyncEvent = (path: string): EventType => ({
  _tag: "FolderMetaSyncRequested",
  path,
});

function writeEpisodeEntry(dir: string, name: string, fields: Record<string, unknown>): Promise<number> {
  const episodeDir = join(dir, name);
  const xml = xmlBuilder.build({
    "?xml": { "@_version": "1.0", "@_encoding": "UTF-8" },
    episode: fields,
  }) as string;
  return mkdir(episodeDir, { recursive: true }).then(() => Bun.write(join(episodeDir, "entry.xml"), xml));
}

function writeFolderEntry(dir: string, name: string, title: string, href: string, feedCount: number): Promise<number> {
  const folderDir = join(dir, name);
  const xml = xmlBuilder.build({
    "?xml": { "@_version": "1.0", "@_encoding": "UTF-8" },
    folder: { title, href, feedCount },
  }) as string;
  return mkdir(folderDir, { recursive: true }).then(() => Bun.write(join(folderDir, "_entry.xml"), xml));
}

describe("folderMetaSync handler", () => {
  beforeEach(async () => {
    mockLogger.reset();
    await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
    await mkdir(DATA_DIR, { recursive: true });
    await mkdir(FILES_DIR, { recursive: true });
  });

  afterAll(async () => {
    await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
  });

  test("returns empty array for non-FolderMetaSyncRequested events", async () => {
    const event: EventType = { _tag: "AudioFileCreated", parent: DATA_DIR, name: "track.mp3" };
    const cascades = await Effect.runPromise(Effect.provide(folderMetaSync(event), TestLayer));
    expect(cascades).toEqual([]);
  });

  test("generates podcast RSS feed.xml when episodes exist", async () => {
    const albumDir = join(DATA_DIR, "Author", "Album");
    const sourceDir = join(FILES_DIR, "Author", "Album");
    await mkdir(albumDir, { recursive: true });
    await mkdir(sourceDir, { recursive: true });

    await writeEpisodeEntry(albumDir, "01.mp3", {
      title: "Chapter 1",
      fileName: "01.mp3",
      filePath: "Author/Album/01.mp3",
      fileSize: 5000000,
      mimeType: "audio/mpeg",
      duration: 300,
      episodeNumber: 1,
      pubDate: "2024-01-15T10:00:00.000Z",
      guid: "Author/Album/01.mp3",
    });

    await Effect.runPromise(Effect.provide(folderMetaSync(folderMetaSyncEvent(albumDir)), TestLayer));

    const feedPath = join(albumDir, "feed.xml");
    const content = await readFile(feedPath, "utf-8");

    expect(content).toContain("<rss");
    expect(content).toContain('xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"');
    expect(content).toContain("<title>Chapter 1</title>");
    expect(content).toContain("<itunes:type>serial</itunes:type>");
    expect(content).toContain("<itunes:episode>1</itunes:episode>");
    expect(content).toContain("audio/mpeg");
  });

  test("uses folder name as podcast title when multiple episodes", async () => {
    const albumDir = join(DATA_DIR, "Author", "MyAlbum");
    const sourceDir = join(FILES_DIR, "Author", "MyAlbum");
    await mkdir(albumDir, { recursive: true });
    await mkdir(sourceDir, { recursive: true });

    await writeEpisodeEntry(albumDir, "01.mp3", {
      title: "Track 1",
      fileName: "01.mp3",
      filePath: "Author/MyAlbum/01.mp3",
      fileSize: 1000,
      mimeType: "audio/mpeg",
      episodeNumber: 1,
      pubDate: "2024-01-15T10:00:00.000Z",
      guid: "Author/MyAlbum/01.mp3",
    });
    await writeEpisodeEntry(albumDir, "02.mp3", {
      title: "Track 2",
      fileName: "02.mp3",
      filePath: "Author/MyAlbum/02.mp3",
      fileSize: 1000,
      mimeType: "audio/mpeg",
      episodeNumber: 2,
      pubDate: "2024-01-15T10:01:00.000Z",
      guid: "Author/MyAlbum/02.mp3",
    });

    await Effect.runPromise(Effect.provide(folderMetaSync(folderMetaSyncEvent(albumDir)), TestLayer));

    const content = await readFile(join(albumDir, "feed.xml"), "utf-8");
    expect(content).toContain("<title>My Album</title>");
  });

  test("uses parent folder as podcast author", async () => {
    const albumDir = join(DATA_DIR, "JohnDoe", "Album");
    const sourceDir = join(FILES_DIR, "JohnDoe", "Album");
    await mkdir(albumDir, { recursive: true });
    await mkdir(sourceDir, { recursive: true });

    await writeEpisodeEntry(albumDir, "01.mp3", {
      title: "Track 1",
      fileName: "01.mp3",
      filePath: "JohnDoe/Album/01.mp3",
      fileSize: 1000,
      mimeType: "audio/mpeg",
      episodeNumber: 1,
      pubDate: "2024-01-15T10:00:00.000Z",
      guid: "JohnDoe/Album/01.mp3",
    });

    await Effect.runPromise(Effect.provide(folderMetaSync(folderMetaSyncEvent(albumDir)), TestLayer));

    const content = await readFile(join(albumDir, "feed.xml"), "utf-8");
    expect(content).toContain("<itunes:author>JohnDoe</itunes:author>");
  });

  test("sorts episodes by disc, track, then filename", async () => {
    const albumDir = join(DATA_DIR, "Artist", "Album");
    const sourceDir = join(FILES_DIR, "Artist", "Album");
    await mkdir(albumDir, { recursive: true });
    await mkdir(sourceDir, { recursive: true });

    await writeEpisodeEntry(albumDir, "b.mp3", {
      title: "Track B",
      fileName: "b.mp3",
      filePath: "Artist/Album/b.mp3",
      fileSize: 1000,
      mimeType: "audio/mpeg",
      discNumber: 1,
      trackNumber: 2,
      episodeNumber: 2,
      pubDate: "2024-01-15T10:01:00.000Z",
      guid: "Artist/Album/b.mp3",
    });
    await writeEpisodeEntry(albumDir, "a.mp3", {
      title: "Track A",
      fileName: "a.mp3",
      filePath: "Artist/Album/a.mp3",
      fileSize: 1000,
      mimeType: "audio/mpeg",
      discNumber: 1,
      trackNumber: 1,
      episodeNumber: 1,
      pubDate: "2024-01-15T10:00:00.000Z",
      guid: "Artist/Album/a.mp3",
    });

    await Effect.runPromise(Effect.provide(folderMetaSync(folderMetaSyncEvent(albumDir)), TestLayer));

    const content = await readFile(join(albumDir, "feed.xml"), "utf-8");
    const trackAPos = content.indexOf("Track A");
    const trackBPos = content.indexOf("Track B");
    expect(trackAPos).toBeLessThan(trackBPos);
  });

  test("returns FeedXmlCreated when feed.xml is new", async () => {
    const albumDir = join(DATA_DIR, "Author", "Album");
    const sourceDir = join(FILES_DIR, "Author", "Album");
    await mkdir(albumDir, { recursive: true });
    await mkdir(sourceDir, { recursive: true });

    await writeEpisodeEntry(albumDir, "01.mp3", {
      title: "Track 1",
      fileName: "01.mp3",
      filePath: "Author/Album/01.mp3",
      fileSize: 1000,
      mimeType: "audio/mpeg",
      episodeNumber: 1,
      pubDate: "2024-01-15T10:00:00.000Z",
      guid: "Author/Album/01.mp3",
    });

    const cascades = await Effect.runPromise(Effect.provide(folderMetaSync(folderMetaSyncEvent(albumDir)), TestLayer));

    expect(cascades).toEqual([{ _tag: "FeedXmlCreated", path: albumDir }]);
  });

  test("returns empty cascades when feed.xml already existed", async () => {
    const albumDir = join(DATA_DIR, "Author", "Album");
    const sourceDir = join(FILES_DIR, "Author", "Album");
    await mkdir(albumDir, { recursive: true });
    await mkdir(sourceDir, { recursive: true });

    await Bun.write(join(albumDir, "feed.xml"), "<existing/>");

    await writeEpisodeEntry(albumDir, "01.mp3", {
      title: "Track 1",
      fileName: "01.mp3",
      filePath: "Author/Album/01.mp3",
      fileSize: 1000,
      mimeType: "audio/mpeg",
      episodeNumber: 1,
      pubDate: "2024-01-15T10:00:00.000Z",
      guid: "Author/Album/01.mp3",
    });

    const cascades = await Effect.runPromise(Effect.provide(folderMetaSync(folderMetaSyncEvent(albumDir)), TestLayer));

    expect(cascades).toEqual([]);
  });

  test("returns FeedXmlDeleted when all episodes removed", async () => {
    const albumDir = join(DATA_DIR, "Author", "Album");
    const sourceDir = join(FILES_DIR, "Author", "Album");
    await mkdir(albumDir, { recursive: true });
    await mkdir(sourceDir, { recursive: true });

    await Bun.write(join(albumDir, "feed.xml"), "<existing/>");

    const cascades = await Effect.runPromise(Effect.provide(folderMetaSync(folderMetaSyncEvent(albumDir)), TestLayer));

    expect(cascades).toEqual([{ _tag: "FeedXmlDeleted", path: albumDir }]);
  });

  test("writes _entry.xml for non-root folders", async () => {
    const albumDir = join(DATA_DIR, "Author", "Album");
    const sourceDir = join(FILES_DIR, "Author", "Album");
    await mkdir(albumDir, { recursive: true });
    await mkdir(sourceDir, { recursive: true });

    await writeEpisodeEntry(albumDir, "01.mp3", {
      title: "Track 1",
      fileName: "01.mp3",
      filePath: "Author/Album/01.mp3",
      fileSize: 1000,
      mimeType: "audio/mpeg",
      episodeNumber: 1,
      pubDate: "2024-01-15T10:00:00.000Z",
      guid: "Author/Album/01.mp3",
    });

    await Effect.runPromise(Effect.provide(folderMetaSync(folderMetaSyncEvent(albumDir)), TestLayer));

    const entryPath = join(albumDir, "_entry.xml");
    const content = await readFile(entryPath, "utf-8");

    expect(content).toContain("<folder>");
    expect(content).toContain("<title>Album</title>");
    expect(content).toContain("<href>/Author/Album/feed.xml</href>");
    expect(content).toContain("<feedCount>1</feedCount>");
  });

  test("does not create _entry.xml for root folder", async () => {
    await Effect.runPromise(Effect.provide(folderMetaSync(folderMetaSyncEvent(DATA_DIR)), TestLayer));

    const entryPath = join(DATA_DIR, "_entry.xml");
    const exists = await stat(entryPath)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);
  });

  test("generates navigation feed for folders-only directory", async () => {
    await writeFolderEntry(DATA_DIR, "Author1", "Author One", "/Author1/feed.xml", 5);
    await writeFolderEntry(DATA_DIR, "Author2", "Author Two", "/Author2/feed.xml", 3);

    await Effect.runPromise(Effect.provide(folderMetaSync(folderMetaSyncEvent(DATA_DIR)), TestLayer));

    const content = await readFile(join(DATA_DIR, "feed.xml"), "utf-8");
    expect(content).toContain("<feed>");
    expect(content).toContain("Author One");
    expect(content).toContain("Author Two");
  });

  test("logs processing info", async () => {
    await Effect.runPromise(Effect.provide(folderMetaSync(folderMetaSyncEvent(DATA_DIR)), TestLayer));

    expect(mockLogger.infoCalls.some((c) => c.tag === "FolderMetaSync" && c.msg.includes("Processing"))).toBe(true);
  });
});
