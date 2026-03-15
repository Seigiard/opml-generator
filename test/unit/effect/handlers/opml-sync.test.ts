import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { opmlSync } from "../../../../src/effect/handlers/opml-sync.ts";
import type { HandlerDeps } from "../../../../src/context.ts";
import type { EventType } from "../../../../src/effect/types.ts";
import type { LogContext } from "../../../../src/logging/types.ts";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdir, rm, stat, readFile, readdir, rename } from "node:fs/promises";
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
      symlink: async () => {},
      unlink: async () => {},
    },
  };
}

function makePodcastRss(title: string, overrides: Partial<{ author: string; description: string; imageUrl: string }> = {}): string {
  return generatePodcastRss(
    { title, author: overrides.author ?? "Test Author", description: overrides.description, imageUrl: overrides.imageUrl },
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
    const result = await opmlSync(event, realDeps());
    // #then
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual([]);
  });

  test("generates feed.opml with discovered podcast feeds", async () => {
    // #given
    const albumDir = join(DATA_DIR, "Author", "Album");
    await mkdir(albumDir, { recursive: true });
    await Bun.write(join(albumDir, "feed.xml"), makePodcastRss("My Audiobook"));
    // #when
    const event: EventType = { _tag: "FeedXmlCreated", path: albumDir };
    await opmlSync(event, realDeps());
    // #then
    const content = await readFile(join(DATA_DIR, "feed.opml"), "utf-8");
    expect(content).toContain("<opml");
    expect(content).toContain('version="2.0"');
    expect(content).toContain("My Audiobook");
    expect(content).toContain("/Author/Album/feed.xml");
  });

  test("handles FeedXmlDeleted event", async () => {
    // #given
    const event: EventType = { _tag: "FeedXmlDeleted", path: join(DATA_DIR, "Author", "Album") };
    // #when
    const result = await opmlSync(event, realDeps());
    // #then
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual([]);
    const content = await readFile(join(DATA_DIR, "feed.opml"), "utf-8");
    expect(content).toContain("<opml");
  });

  test("excludes navigation feeds from OPML", async () => {
    // #given
    const podcastDir = join(DATA_DIR, "Author", "Podcast");
    const navDir = join(DATA_DIR, "Author");
    await mkdir(podcastDir, { recursive: true });
    await Bun.write(join(podcastDir, "feed.xml"), makePodcastRss("Real Podcast"));
    await Bun.write(join(navDir, "feed.xml"), `<?xml version="1.0"?><feed><title>Navigation</title></feed>`);
    // #when
    const event: EventType = { _tag: "FeedXmlCreated", path: podcastDir };
    await opmlSync(event, realDeps());
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
    await opmlSync(event, realDeps());
    // #then
    const content = await readFile(join(DATA_DIR, "feed.opml"), "utf-8");
    expect(content).toContain("Alpha Book");
    expect(content).toContain("Beta Book");
    const alphaPos = content.indexOf("Alpha Book");
    const betaPos = content.indexOf("Beta Book");
    expect(alphaPos).toBeLessThan(betaPos);
  });

  test("writes valid OPML with no feeds when data is empty", async () => {
    // #given
    const event: EventType = { _tag: "FeedXmlCreated", path: DATA_DIR };
    // #when
    await opmlSync(event, realDeps());
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
    await opmlSync(event, realDeps());
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
    const result = await opmlSync(event, realDeps());
    // #then
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual([]);
  });

  test("includes author, description, and imageUrl in OPML outlines", async () => {
    // #given
    const albumDir = join(DATA_DIR, "Author", "Album");
    await mkdir(albumDir, { recursive: true });
    await Bun.write(
      join(albumDir, "feed.xml"),
      makePodcastRss("Rich Feed", {
        author: "Jane Doe",
        description: "A great audiobook",
        imageUrl: "/data/Author/Album/cover.jpg",
      }),
    );
    // #when
    const event: EventType = { _tag: "FeedXmlCreated", path: albumDir };
    await opmlSync(event, realDeps());
    // #then
    const content = await readFile(join(DATA_DIR, "feed.opml"), "utf-8");
    expect(content).toContain('author="Jane Doe"');
    expect(content).toContain('description="A great audiobook"');
    expect(content).toContain("imageUrl=");
    expect(content).toContain("cover.jpg");
  });

  test("omits author and imageUrl when not present in feed", async () => {
    // #given
    const albumDir = join(DATA_DIR, "Minimal", "Book");
    await mkdir(albumDir, { recursive: true });
    const minimalRss = `<?xml version="1.0"?><rss version="2.0"><channel><title>Minimal</title></channel></rss>`;
    await Bun.write(join(albumDir, "feed.xml"), minimalRss);
    // #when
    const event: EventType = { _tag: "FeedXmlCreated", path: albumDir };
    await opmlSync(event, realDeps());
    // #then
    const content = await readFile(join(DATA_DIR, "feed.opml"), "utf-8");
    expect(content).toContain("Minimal");
    expect(content).not.toContain("author=");
    expect(content).not.toContain("imageUrl=");
  });

  test("logs OPML generation info", async () => {
    // #given
    const event: EventType = { _tag: "FeedXmlCreated", path: DATA_DIR };
    // #when
    await opmlSync(event, realDeps());
    // #then
    expect(mockLogger.infoCalls.some((c) => c.tag === "OpmlSync" && c.msg === "Regenerating OPML")).toBe(true);
    expect(mockLogger.infoCalls.some((c) => c.tag === "OpmlSync" && c.msg === "OPML generated")).toBe(true);
  });
});
