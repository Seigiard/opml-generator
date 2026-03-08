import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { Effect, Layer } from "effect";
import { ConfigService, LoggerService, FileSystemService } from "../../../../src/effect/services.ts";
import { opmlSync } from "../../../../src/effect/handlers/opml-sync.ts";
import type { EventType } from "../../../../src/effect/types.ts";
import type { LogContext } from "../../../../src/logging/types.ts";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdir, rm, stat, readFile } from "node:fs/promises";
import { generatePodcastRss } from "../../../../src/rss/podcast-rss.ts";

const TEST_DIR = join(tmpdir(), `opml-sync-test-${Date.now()}`);
const DATA_DIR = join(TEST_DIR, "data");
const FILES_DIR = join(TEST_DIR, "files");

const mockLogger = {
  infoCalls: [] as Array<{ tag: string; msg: string; ctx?: LogContext }>,
  reset() {
    this.infoCalls = [];
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
  warn: () => Effect.void,
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

function makePodcastRss(title: string): string {
  return generatePodcastRss(
    { title, author: "Test Author" },
    [
      {
        title: "Episode 1",
        guid: "ep1",
        pubDate: "2024-01-15T10:00:00.000Z",
        enclosureUrl: "/test/ep1.mp3",
        enclosureLength: 1000,
        enclosureType: "audio/mpeg",
        episodeNumber: 1,
      },
    ],
  );
}

const NAVIGATION_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed>
  <title>Navigation</title>
  <item><title>Subfolder</title></item>
</feed>`;

describe("opmlSync handler", () => {
  beforeEach(async () => {
    mockLogger.reset();
    await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
    await mkdir(DATA_DIR, { recursive: true });
    await mkdir(FILES_DIR, { recursive: true });
  });

  afterAll(async () => {
    await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
  });

  test("returns empty array for unrelated events", async () => {
    // #given
    const event: EventType = { _tag: "AudioFileCreated", parent: DATA_DIR, name: "track.mp3" };

    // #when
    const cascades = await Effect.runPromise(Effect.provide(opmlSync(event), TestLayer));

    // #then
    expect(cascades).toEqual([]);
  });

  test("generates feed.opml with discovered podcast feeds", async () => {
    // #given
    const albumDir = join(DATA_DIR, "Author", "Album");
    await mkdir(albumDir, { recursive: true });
    await Bun.write(join(albumDir, "feed.xml"), makePodcastRss("My Audiobook"));

    // #when
    const event: EventType = { _tag: "FeedXmlCreated", path: albumDir };
    await Effect.runPromise(Effect.provide(opmlSync(event), TestLayer));

    // #then
    const opmlPath = join(DATA_DIR, "feed.opml");
    const content = await readFile(opmlPath, "utf-8");
    expect(content).toContain("<opml");
    expect(content).toContain('version="2.0"');
    expect(content).toContain("My Audiobook");
    expect(content).toContain("/Author/Album/feed.xml");
  });

  test("handles FeedXmlDeleted event", async () => {
    // #given — empty data dir, no feeds
    const event: EventType = { _tag: "FeedXmlDeleted", path: join(DATA_DIR, "Author", "Album") };

    // #when
    const cascades = await Effect.runPromise(Effect.provide(opmlSync(event), TestLayer));

    // #then
    expect(cascades).toEqual([]);
    const opmlPath = join(DATA_DIR, "feed.opml");
    const content = await readFile(opmlPath, "utf-8");
    expect(content).toContain("<opml");
  });

  test("excludes navigation feeds from OPML", async () => {
    // #given
    const podcastDir = join(DATA_DIR, "Author", "Podcast");
    const navDir = join(DATA_DIR, "Author");
    await mkdir(podcastDir, { recursive: true });
    await Bun.write(join(podcastDir, "feed.xml"), makePodcastRss("Real Podcast"));
    await Bun.write(join(navDir, "feed.xml"), NAVIGATION_FEED);

    // #when
    const event: EventType = { _tag: "FeedXmlCreated", path: podcastDir };
    await Effect.runPromise(Effect.provide(opmlSync(event), TestLayer));

    // #then
    const content = await readFile(join(DATA_DIR, "feed.opml"), "utf-8");
    expect(content).toContain("Real Podcast");
    expect(content).not.toContain("Navigation");
  });

  test("collects feeds from multiple nested directories", async () => {
    // #given
    const dir1 = join(DATA_DIR, "Author1", "Book1");
    const dir2 = join(DATA_DIR, "Author2", "Book2");
    await mkdir(dir1, { recursive: true });
    await mkdir(dir2, { recursive: true });
    await Bun.write(join(dir1, "feed.xml"), makePodcastRss("Alpha Book"));
    await Bun.write(join(dir2, "feed.xml"), makePodcastRss("Beta Book"));

    // #when
    const event: EventType = { _tag: "FeedXmlCreated", path: dir1 };
    await Effect.runPromise(Effect.provide(opmlSync(event), TestLayer));

    // #then
    const content = await readFile(join(DATA_DIR, "feed.opml"), "utf-8");
    expect(content).toContain("Alpha Book");
    expect(content).toContain("Beta Book");

    const alphaPos = content.indexOf("Alpha Book");
    const betaPos = content.indexOf("Beta Book");
    expect(alphaPos).toBeLessThan(betaPos);
  });

  test("writes valid OPML with no feeds when data is empty", async () => {
    // #given — empty data dir
    const event: EventType = { _tag: "FeedXmlCreated", path: DATA_DIR };

    // #when
    await Effect.runPromise(Effect.provide(opmlSync(event), TestLayer));

    // #then
    const content = await readFile(join(DATA_DIR, "feed.opml"), "utf-8");
    expect(content).toContain("<opml");
    expect(content).toContain("Audiobooks");
  });

  test("skips unparseable feed.xml files", async () => {
    // #given
    const goodDir = join(DATA_DIR, "Good", "Podcast");
    const badDir = join(DATA_DIR, "Bad", "Podcast");
    await mkdir(goodDir, { recursive: true });
    await mkdir(badDir, { recursive: true });
    await Bun.write(join(goodDir, "feed.xml"), makePodcastRss("Good Feed"));
    await Bun.write(join(badDir, "feed.xml"), "<<<not valid xml>>>");

    // #when
    const event: EventType = { _tag: "FeedXmlCreated", path: goodDir };
    await Effect.runPromise(Effect.provide(opmlSync(event), TestLayer));

    // #then
    const content = await readFile(join(DATA_DIR, "feed.opml"), "utf-8");
    expect(content).toContain("Good Feed");
  });

  test("returns empty cascades (terminal handler)", async () => {
    // #given
    const albumDir = join(DATA_DIR, "Author", "Album");
    await mkdir(albumDir, { recursive: true });
    await Bun.write(join(albumDir, "feed.xml"), makePodcastRss("Test"));

    // #when
    const event: EventType = { _tag: "FeedXmlCreated", path: albumDir };
    const cascades = await Effect.runPromise(Effect.provide(opmlSync(event), TestLayer));

    // #then
    expect(cascades).toEqual([]);
  });

  test("logs OPML generation info", async () => {
    // #given
    const event: EventType = { _tag: "FeedXmlCreated", path: DATA_DIR };

    // #when
    await Effect.runPromise(Effect.provide(opmlSync(event), TestLayer));

    // #then
    expect(mockLogger.infoCalls.some((c) => c.tag === "OpmlSync" && c.msg === "Regenerating OPML")).toBe(true);
    expect(mockLogger.infoCalls.some((c) => c.tag === "OpmlSync" && c.msg === "OPML generated")).toBe(true);
  });
});
