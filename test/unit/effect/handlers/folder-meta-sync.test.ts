import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { folderMetaSync } from "../../../../src/effect/handlers/folder-meta-sync.ts";
import type { HandlerDeps } from "../../../../src/context.ts";
import type { EventType } from "../../../../src/effect/types.ts";
import type { LogContext } from "../../../../src/logging/types.ts";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdir, rm, stat, readFile, readdir, rename } from "node:fs/promises";
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

function realDeps(): HandlerDeps {
  return {
    config: { filesPath: FILES_DIR, dataPath: DATA_DIR, port: 3000, reconcileInterval: 1800 },
    logger: {
      info: (tag, msg, ctx) => {
        mockLogger.infoCalls.push({ tag, msg, ctx });
      },
      warn: (tag, msg) => {
        mockLogger.warnCalls.push({ tag, msg });
      },
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
      symlink: async () => {},
      unlink: async () => {},
    },
  };
}

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
    // #given
    const event: EventType = { _tag: "AudioFileCreated", parent: DATA_DIR, name: "track.mp3" };
    // #when
    const result = await folderMetaSync(event, realDeps());
    // #then
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual([]);
  });

  test("generates podcast RSS feed.xml when episodes exist", async () => {
    // #given
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

    // #when
    const result = await folderMetaSync(folderMetaSyncEvent(albumDir), realDeps());

    // #then
    expect(result.isOk()).toBe(true);
    const feedPath = join(albumDir, "feed.xml");
    const content = await readFile(feedPath, "utf-8");

    expect(content).toContain("<rss");
    expect(content).toContain('xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"');
    expect(content).toContain("<title>Chapter 1</title>");
    expect(content).toContain("<itunes:type>serial</itunes:type>");
    expect(content).toContain("<itunes:episode>1</itunes:episode>");
    expect(content).toContain("audio/mpeg");
  });

  test("enclosure URL includes filesPath prefix for nginx routing", async () => {
    // #given
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

    // #when
    await folderMetaSync(folderMetaSyncEvent(albumDir), realDeps());

    // #then
    const content = await readFile(join(albumDir, "feed.xml"), "utf-8");
    const urlMatch = content.match(/enclosure[^>]*url="([^"]+)"/);
    expect(urlMatch).toBeTruthy();
    expect(urlMatch![1]).toContain(`${FILES_DIR}/Author/Album/01.mp3`);
  });

  test("uses folder name as podcast title when multiple episodes", async () => {
    // #given
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

    // #when
    await folderMetaSync(folderMetaSyncEvent(albumDir), realDeps());

    // #then
    const content = await readFile(join(albumDir, "feed.xml"), "utf-8");
    expect(content).toContain("<title>My Album</title>");
  });

  test("uses parent folder as podcast author", async () => {
    // #given
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

    // #when
    await folderMetaSync(folderMetaSyncEvent(albumDir), realDeps());

    // #then
    const content = await readFile(join(albumDir, "feed.xml"), "utf-8");
    expect(content).toContain("<itunes:author>JohnDoe</itunes:author>");
  });

  test("sorts episodes by disc, track, then filename", async () => {
    // #given
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

    // #when
    await folderMetaSync(folderMetaSyncEvent(albumDir), realDeps());

    // #then
    const content = await readFile(join(albumDir, "feed.xml"), "utf-8");
    const trackAPos = content.indexOf("Track A");
    const trackBPos = content.indexOf("Track B");
    expect(trackAPos).toBeLessThan(trackBPos);
  });

  test("renumbers episodes by sorted order, ignoring stale episodeNumber from entry.xml", async () => {
    // #given
    const albumDir = join(DATA_DIR, "Author", "Book");
    const sourceDir = join(FILES_DIR, "Author", "Book");
    await mkdir(albumDir, { recursive: true });
    await mkdir(sourceDir, { recursive: true });

    await writeEpisodeEntry(albumDir, "Flashback_007.mp3", {
      title: "Flashback_007",
      fileName: "Flashback_007.mp3",
      filePath: "Author/Book/Flashback_007.mp3",
      fileSize: 1000,
      mimeType: "audio/mpeg",
      episodeNumber: 1,
      pubDate: "2024-01-15T10:00:00.000Z",
      guid: "Author/Book/Flashback_007.mp3",
    });
    await writeEpisodeEntry(albumDir, "Flashback_029.mp3", {
      title: "Flashback_029",
      fileName: "Flashback_029.mp3",
      filePath: "Author/Book/Flashback_029.mp3",
      fileSize: 1000,
      mimeType: "audio/mpeg",
      episodeNumber: 2,
      pubDate: "2024-01-15T10:01:00.000Z",
      guid: "Author/Book/Flashback_029.mp3",
    });
    await writeEpisodeEntry(albumDir, "Flashback_023.mp3", {
      title: "Flashback_023",
      fileName: "Flashback_023.mp3",
      filePath: "Author/Book/Flashback_023.mp3",
      fileSize: 1000,
      mimeType: "audio/mpeg",
      episodeNumber: 3,
      pubDate: "2024-01-15T10:02:00.000Z",
      guid: "Author/Book/Flashback_023.mp3",
    });

    // #when
    await folderMetaSync(folderMetaSyncEvent(albumDir), realDeps());

    // #then — feed.xml should have episodes in natural filename order: 007, 023, 029
    const content = await readFile(join(albumDir, "feed.xml"), "utf-8");
    const pos007 = content.indexOf("Flashback_007");
    const pos023 = content.indexOf("Flashback_023");
    const pos029 = content.indexOf("Flashback_029");
    expect(pos007).toBeLessThan(pos023);
    expect(pos023).toBeLessThan(pos029);
  });

  test("returns FeedXmlCreated when feed.xml is new", async () => {
    // #given
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

    // #when
    const result = await folderMetaSync(folderMetaSyncEvent(albumDir), realDeps());

    // #then
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual([{ _tag: "FeedXmlCreated", path: albumDir }]);
  });

  test("returns empty cascades when feed.xml already existed", async () => {
    // #given
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

    // #when
    const result = await folderMetaSync(folderMetaSyncEvent(albumDir), realDeps());

    // #then
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual([]);
  });

  test("returns FeedXmlDeleted when all episodes removed", async () => {
    // #given
    const albumDir = join(DATA_DIR, "Author", "Album");
    const sourceDir = join(FILES_DIR, "Author", "Album");
    await mkdir(albumDir, { recursive: true });
    await mkdir(sourceDir, { recursive: true });

    await Bun.write(join(albumDir, "feed.xml"), "<existing/>");

    // #when
    const result = await folderMetaSync(folderMetaSyncEvent(albumDir), realDeps());

    // #then
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual([{ _tag: "FeedXmlDeleted", path: albumDir }]);
  });

  test("writes _entry.xml for non-root folders", async () => {
    // #given
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

    // #when
    await folderMetaSync(folderMetaSyncEvent(albumDir), realDeps());

    // #then
    const entryPath = join(albumDir, "_entry.xml");
    const content = await readFile(entryPath, "utf-8");

    expect(content).toContain("<folder>");
    expect(content).toContain("<title>Album</title>");
    expect(content).toContain("<href>/Author/Album/feed.xml</href>");
    expect(content).toContain("<feedCount>1</feedCount>");
  });

  test("does not create _entry.xml for root folder", async () => {
    // #when
    await folderMetaSync(folderMetaSyncEvent(DATA_DIR), realDeps());

    // #then
    const entryPath = join(DATA_DIR, "_entry.xml");
    const exists = await stat(entryPath)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);
  });

  test("generates navigation feed for folders-only directory", async () => {
    // #given
    await writeFolderEntry(DATA_DIR, "Author1", "Author One", "/Author1/feed.xml", 5);
    await writeFolderEntry(DATA_DIR, "Author2", "Author Two", "/Author2/feed.xml", 3);

    // #when
    await folderMetaSync(folderMetaSyncEvent(DATA_DIR), realDeps());

    // #then
    const content = await readFile(join(DATA_DIR, "feed.xml"), "utf-8");
    expect(content).toContain("<feed>");
    expect(content).toContain("Author One");
    expect(content).toContain("Author Two");
  });

  test("logs processing info", async () => {
    // #when
    await folderMetaSync(folderMetaSyncEvent(DATA_DIR), realDeps());

    // #then
    expect(mockLogger.infoCalls.some((c) => c.tag === "FolderMetaSync" && c.msg.includes("Processing"))).toBe(true);
  });
});
