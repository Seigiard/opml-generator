import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Effect } from "effect";
import { XMLParser } from "fast-xml-parser";
import { acquireOutputTree } from "@seigiard/sync-engine";
import { z } from "zod";
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
  utimes,
} from "node:fs/promises";
import { join } from "node:path";
import {
  openEpisodeSynchronization,
  startEpisodeSynchronization,
} from "../../src/engine/composition.ts";
import { opmlEngineStatePath } from "../../src/engine/policy.ts";
import type { HandlerDeps } from "../../src/context.ts";
import { createTempDir, cleanupTempDir } from "../helpers/fs-helpers.ts";

const AUDIO_FIXTURES = join(import.meta.dir, "../fixtures/audio");

const parser = new XMLParser({ ignoreAttributes: false });

const BASE_URL = "{{{BASE_URL}}}";

const tinyPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

const rssItemSchema = z.object({
  title: z.string(),
  guid: z.object({ "#text": z.string() }),
  enclosure: z.object({ "@_url": z.string() }),
  link: z.string().optional(),
  "itunes:episode": z.number(),
});

const rssSchema = z.object({
  rss: z.object({
    channel: z.object({
      title: z.string(),
      link: z.string().optional(),
      "itunes:author": z.string().optional(),
      "itunes:image": z.object({ "@_href": z.string() }).optional(),
      "atom:link": z.object({ "@_href": z.string() }).optional(),
      item: z
        .union([rssItemSchema, z.array(rssItemSchema)])
        .transform((items) => (Array.isArray(items) ? items : [items])),
    }),
  }),
});

const opmlSchema = z.object({
  opml: z.object({
    body: z.object({
      outline: z
        .union([
          z.object({
            "@_title": z.string(),
            "@_xmlUrl": z.string(),
            "@_imageUrl": z.string().optional(),
          }),
          z.array(
            z.object({
              "@_title": z.string(),
              "@_xmlUrl": z.string(),
              "@_imageUrl": z.string().optional(),
            }),
          ),
        ])
        .transform((outlines) => (Array.isArray(outlines) ? outlines : [outlines])),
    }),
  }),
});

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

async function readRss(path: string): Promise<z.infer<typeof rssSchema>> {
  // SAFETY: XMLParser output is immediately validated by rssSchema.
  const parsed = parser.parse(await Bun.file(path).text()) as unknown;

  return rssSchema.parse(parsed);
}

async function readOpml(path: string): Promise<z.infer<typeof opmlSchema>> {
  // SAFETY: XMLParser output is immediately validated by opmlSchema.
  const parsed = parser.parse(await Bun.file(path).text()) as unknown;

  return opmlSchema.parse(parsed);
}

function firstRssItem(rss: z.infer<typeof rssSchema>): z.infer<typeof rssItemSchema> {
  const item = rss.rss.channel.item[0];

  if (!item) throw new Error("Expected RSS feed to contain at least one item");

  return item;
}

function firstOpmlOutline(
  opml: z.infer<typeof opmlSchema>,
): z.infer<typeof opmlSchema>["opml"]["body"]["outline"][number] {
  const outline = opml.opml.body.outline[0];

  if (!outline) throw new Error("Expected OPML to contain at least one outline");

  return outline;
}

function rssGuids(rss: z.infer<typeof rssSchema>): string[] {
  return rss.rss.channel.item.map((item) => item.guid["#text"]);
}

function opmlUrls(opml: z.infer<typeof opmlSchema>): string[] {
  return opml.opml.body.outline.map((outline) => outline["@_xmlUrl"]);
}

async function completesWithin(effect: Effect.Effect<unknown, unknown>, milliseconds: number) {
  return Promise.race([
    Effect.runPromise(effect).then(() => true),
    Bun.sleep(milliseconds).then(() => false),
  ]);
}

function publicMetadataPath(url: string): string {
  if (!url.startsWith(BASE_URL)) throw new Error(`Expected public metadata URL: ${url}`);

  return join(dataPath, decodeURIComponent(url.slice(BASE_URL.length)));
}

function sourceFilePath(url: string): string {
  if (!url.startsWith(BASE_URL)) throw new Error(`Expected source URL: ${url}`);

  return decodeURIComponent(url.slice(BASE_URL.length));
}

function countedDeps() {
  const deps = realDeps();
  const counts = { entryWrites: 0, feedWrites: 0, opmlWrites: 0 };

  return {
    counts,
    deps: {
      ...deps,
      fs: {
        ...deps.fs,
        atomicWrite: async (path: string, content: string) => {
          if (path.endsWith("entry.xml")) counts.entryWrites += 1;

          if (path.endsWith("feed.xml")) counts.feedWrites += 1;

          if (path.endsWith("feed.opml")) counts.opmlWrites += 1;

          await deps.fs.atomicWrite(path, content);
        },
      },
    },
  };
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

  test("freshness skips unchanged episode work and forced passes reprocess metadata-equivalent changes", async () => {
    // #given
    await mkdir(join(filesPath, "Author", "Album"), { recursive: true });
    const audioPath = join(filesPath, "Author", "Album", "01.mp3");
    await copyFile(join(AUDIO_FIXTURES, "tagged.mp3"), audioPath);
    const fixedTime = new Date("2024-01-02T03:04:05.000Z");
    await utimes(audioPath, fixedTime, fixedTime);
    const first = countedDeps();

    await Effect.runPromise(
      Effect.scoped(openEpisodeSynchronization({ ...first.deps, reconcileIntervalMs: 0 })),
    );
    const unchanged = countedDeps();

    // #when
    await Effect.runPromise(
      Effect.scoped(openEpisodeSynchronization({ ...unchanged.deps, reconcileIntervalMs: 0 })),
    );
    const bytes = new Uint8Array(await Bun.file(audioPath).arrayBuffer());
    bytes[bytes.length - 1] = bytes[bytes.length - 1] === 0 ? 1 : 0;
    await Bun.write(audioPath, bytes);
    await utimes(audioPath, fixedTime, fixedTime);
    const plain = countedDeps();
    await Effect.runPromise(
      Effect.scoped(openEpisodeSynchronization({ ...plain.deps, reconcileIntervalMs: 0 })),
    );
    const forced = countedDeps();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const live = yield* startEpisodeSynchronization({
            ...forced.deps,
            reconcileIntervalMs: 0,
          });

          yield* live.ready;
          yield* live.requestPass({ force: true });
          yield* live.awaitCompletion;
        }),
      ),
    );

    // #then
    const episode = await readEpisode(join(dataPath, "Author", "Album", "01.mp3", "entry.xml"));
    expect({
      firstEntryWritten: first.counts.entryWrites > 0,
      unchangedEntryWrites: unchanged.counts.entryWrites,
      plainEntryWrites: plain.counts.entryWrites,
      forcedEntryWrites: forced.counts.entryWrites,
      title: episode.title,
    }).toEqual({
      firstEntryWritten: true,
      unchangedEntryWrites: 0,
      plainEntryWrites: 0,
      forcedEntryWrites: 1,
      title: "Test Title",
    });
  });

  test("hinted changes reprocess episode output while plain metadata-equivalent passes skip it", async () => {
    // #given
    await mkdir(join(filesPath, "Author", "Album"), { recursive: true });
    const audioPath = join(filesPath, "Author", "Album", "01.mp3");
    await copyFile(join(AUDIO_FIXTURES, "tagged.mp3"), audioPath);
    const fixedTime = new Date("2024-01-02T03:04:05.000Z");
    await utimes(audioPath, fixedTime, fixedTime);
    const first = countedDeps();

    await Effect.runPromise(
      Effect.scoped(openEpisodeSynchronization({ ...first.deps, reconcileIntervalMs: 0 })),
    );
    const bytes = new Uint8Array(await Bun.file(audioPath).arrayBuffer());
    bytes[bytes.length - 1] = bytes[bytes.length - 1] === 0 ? 1 : 0;
    await Bun.write(audioPath, bytes);
    await utimes(audioPath, fixedTime, fixedTime);

    const plain = countedDeps();
    await Effect.runPromise(
      Effect.scoped(openEpisodeSynchronization({ ...plain.deps, reconcileIntervalMs: 0 })),
    );
    const hinted = countedDeps();

    // #when
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const live = yield* startEpisodeSynchronization({
            ...hinted.deps,
            reconcileIntervalMs: 0,
          });

          yield* live.ready;
          yield* live.notify(["Author/Album/01.mp3"]);
          yield* live.awaitCompletion;
        }),
      ),
    );

    // #then
    expect({
      firstEntryWritten: first.counts.entryWrites > 0,
      plainEntryWrites: plain.counts.entryWrites,
      hintedEntryWrites: hinted.counts.entryWrites,
    }).toEqual({
      firstEntryWritten: true,
      plainEntryWrites: 0,
      hintedEntryWrites: 1,
    });
  });

  test("processing version bumps reprocess unchanged episode outputs", async () => {
    // #given
    await mkdir(join(filesPath, "Author", "Album"), { recursive: true });
    await copyFile(
      join(AUDIO_FIXTURES, "tagged.mp3"),
      join(filesPath, "Author", "Album", "01.mp3"),
    );
    const first = countedDeps();
    await Effect.runPromise(
      Effect.scoped(openEpisodeSynchronization({ ...first.deps, reconcileIntervalMs: 0 })),
    );
    const bumped = countedDeps();

    // #when
    await Effect.runPromise(
      Effect.scoped(
        openEpisodeSynchronization({
          ...bumped.deps,
          reconcileIntervalMs: 0,
          processingVersions: { episode: "2" },
        }),
      ),
    );

    // #then
    expect({
      firstEntryWritten: first.counts.entryWrites > 0,
      bumpedEntryWrites: bumped.counts.entryWrites,
    }).toEqual({
      firstEntryWritten: true,
      bumpedEntryWrites: 1,
    });
  });

  test("plain passes repair missing folder RSS without rewriting unchanged episodes", async () => {
    // #given
    await mkdir(join(filesPath, "Author", "Album"), { recursive: true });
    await copyFile(
      join(AUDIO_FIXTURES, "tagged.mp3"),
      join(filesPath, "Author", "Album", "01.mp3"),
    );
    await Effect.runPromise(
      Effect.scoped(openEpisodeSynchronization({ ...realDeps(), reconcileIntervalMs: 0 })),
    );
    await rm(join(dataPath, "Author", "Album", "feed.xml"));
    const repaired = countedDeps();

    // #when
    await Effect.runPromise(
      Effect.scoped(openEpisodeSynchronization({ ...repaired.deps, reconcileIntervalMs: 0 })),
    );

    // #then
    const rss = await readRss(join(dataPath, "Author", "Album", "feed.xml"));
    expect({
      entryWrites: repaired.counts.entryWrites,
      feedRepaired: repaired.counts.feedWrites > 0,
      guids: rssGuids(rss),
    }).toEqual({
      entryWrites: 0,
      feedRepaired: true,
      guids: ["Author/Album/01.mp3"],
    });
  });

  test("folder processing version bumps regenerate unchanged RSS only", async () => {
    // #given
    await mkdir(join(filesPath, "Author", "Album"), { recursive: true });
    await copyFile(
      join(AUDIO_FIXTURES, "tagged.mp3"),
      join(filesPath, "Author", "Album", "01.mp3"),
    );
    await Effect.runPromise(
      Effect.scoped(openEpisodeSynchronization({ ...realDeps(), reconcileIntervalMs: 0 })),
    );
    const bumped = countedDeps();

    // #when
    await Effect.runPromise(
      Effect.scoped(
        openEpisodeSynchronization({
          ...bumped.deps,
          reconcileIntervalMs: 0,
          processingVersions: { folder: "2" },
        }),
      ),
    );

    // #then
    expect({
      entryWrites: bumped.counts.entryWrites,
      feedRegenerated: bumped.counts.feedWrites > 0,
      opmlWrites: bumped.counts.opmlWrites,
    }).toEqual({
      entryWrites: 0,
      feedRegenerated: true,
      opmlWrites: 1,
    });
  });

  test("unchanged plain passes skip folder RSS and final OPML writes", async () => {
    // #given
    await mkdir(join(filesPath, "Author", "Album"), { recursive: true });
    await copyFile(
      join(AUDIO_FIXTURES, "tagged.mp3"),
      join(filesPath, "Author", "Album", "01.mp3"),
    );
    await Effect.runPromise(
      Effect.scoped(openEpisodeSynchronization({ ...realDeps(), reconcileIntervalMs: 0 })),
    );
    const unchanged = countedDeps();

    // #when
    await Effect.runPromise(
      Effect.scoped(openEpisodeSynchronization({ ...unchanged.deps, reconcileIntervalMs: 0 })),
    );

    // #then
    expect(unchanged.counts).toEqual({ entryWrites: 0, feedWrites: 0, opmlWrites: 1 });
  });

  test("publishes folder RSS and one final OPML after episode work drains", async () => {
    // #given
    await mkdir(join(filesPath, "Author", "Album"), { recursive: true });
    await copyFile(
      join(AUDIO_FIXTURES, "tagged.mp3"),
      join(filesPath, "Author", "Album", "01.mp3"),
    );
    await copyFile(
      join(AUDIO_FIXTURES, "tagged.mp3"),
      join(filesPath, "Author", "Album", "02.mp3"),
    );

    // #when
    await Effect.runPromise(
      Effect.scoped(openEpisodeSynchronization({ ...realDeps(), reconcileIntervalMs: 0 })),
    );

    // #then
    const rss = await readRss(join(dataPath, "Author", "Album", "feed.xml"));
    const opml = await readOpml(join(dataPath, "feed.opml"));
    const firstItem = firstRssItem(rss);
    const firstOutline = firstOpmlOutline(opml);

    expect({
      rssTitle: rss.rss.channel.title,
      rssAuthor: rss.rss.channel["itunes:author"],
      self: rss.rss.channel["atom:link"]?.["@_href"],
      itemTitles: rss.rss.channel.item.map((item) => item.title),
      itemEpisodes: rss.rss.channel.item.map((item) => item["itunes:episode"]),
      firstGuid: firstItem.guid["#text"],
      opmlTitle: firstOutline["@_title"],
      opmlXmlUrl: firstOutline["@_xmlUrl"],
    }).toEqual({
      rssTitle: "Album",
      rssAuthor: "Author",
      self: "{{{BASE_URL}}}/Author/Album/feed.xml",
      itemTitles: ["Test Title", "Test Title"],
      itemEpisodes: [1, 2],
      firstGuid: "Author/Album/01.mp3",
      opmlTitle: "Album",
      opmlXmlUrl: "{{{BASE_URL}}}/Author/Album/feed.xml",
    });
  });

  test("held required RSS work prevents final OPML publication", async () => {
    // #given
    await mkdir(join(filesPath, "Author", "Album"), { recursive: true });
    await copyFile(
      join(AUDIO_FIXTURES, "tagged.mp3"),
      join(filesPath, "Author", "Album", "01.mp3"),
    );
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();

    // #when
    const held = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const live = yield* startEpisodeSynchronization({
            ...realDeps(),
            reconcileIntervalMs: 0,
            beforeFolderWork: () =>
              Effect.promise(async () => {
                entered.resolve();
                await release.promise;
              }),
          });

          yield* Effect.promise(() => entered.promise);
          const statusWhileHeld = yield* live.status;

          const opmlExistsWhileHeld = yield* Effect.promise(() =>
            Bun.file(join(dataPath, "feed.opml")).exists(),
          );

          const readyWhileHeld = yield* Effect.promise(() => completesWithin(live.ready, 25));

          release.resolve();
          yield* live.ready;
          yield* live.awaitCompletion;
          const statusAfterRelease = yield* live.status;

          return { statusWhileHeld, opmlExistsWhileHeld, readyWhileHeld, statusAfterRelease };
        }),
      ),
    );

    // #then
    expect({
      state: held.statusWhileHeld.state,
      opmlExistsWhileHeld: held.opmlExistsWhileHeld,
      readyWhileHeld: held.readyWhileHeld,
      stateAfterRelease: held.statusAfterRelease.state,
    }).toEqual({
      state: "working",
      opmlExistsWhileHeld: false,
      readyWhileHeld: false,
      stateAfterRelease: "complete",
    });
    expect(await Bun.file(join(dataPath, "feed.opml")).exists()).toBe(true);
  });

  test("late source work added while RSS is held is published before completion", async () => {
    // #given
    await mkdir(join(filesPath, "Author", "Album"), { recursive: true });
    await copyFile(
      join(AUDIO_FIXTURES, "tagged.mp3"),
      join(filesPath, "Author", "Album", "01.mp3"),
    );
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let holdFirstFolder = true;

    // #when
    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const live = yield* startEpisodeSynchronization({
            ...realDeps(),
            reconcileIntervalMs: 0,
            beforeFolderWork: () => {
              if (!holdFirstFolder) return Effect.void;
              holdFirstFolder = false;

              return Effect.promise(async () => {
                entered.resolve();
                await release.promise;
              });
            },
          });

          yield* Effect.promise(() => entered.promise);
          yield* Effect.promise(() =>
            copyFile(
              join(AUDIO_FIXTURES, "tagged.mp3"),
              join(filesPath, "Author", "Album", "02.mp3"),
            ),
          );
          yield* live.notify(["Author/Album/02.mp3"]);
          const readyWhileHeld = yield* Effect.promise(() => completesWithin(live.ready, 25));

          release.resolve();
          yield* live.awaitCompletion;
          const statusAfterFollowUp = yield* live.status;

          return { readyWhileHeld, statusAfterFollowUp };
        }),
      ),
    );

    // #then
    const rss = await readRss(join(dataPath, "Author", "Album", "feed.xml"));
    const opml = await readOpml(join(dataPath, "feed.opml"));

    expect({
      readyWhileHeld: observed.readyWhileHeld,
      stateAfterFollowUp: observed.statusAfterFollowUp.state,
      itemGuids: rss.rss.channel.item.map((item) => item.guid["#text"]),
      outlineTitles: opml.opml.body.outline.map((outline) => outline["@_title"]),
    }).toEqual({
      readyWhileHeld: false,
      stateAfterFollowUp: "complete",
      itemGuids: ["Author/Album/01.mp3", "Author/Album/02.mp3"],
      outlineTitles: ["Album"],
    });
  });

  test("forced follow-up resync preserves readable output while busy and repairs stale episode output", async () => {
    // #given
    await mkdir(join(filesPath, "Author", "Album"), { recursive: true });
    await copyFile(
      join(AUDIO_FIXTURES, "tagged.mp3"),
      join(filesPath, "Author", "Album", "01.mp3"),
    );
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let holdNextFolder = false;

    // #when
    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const live = yield* startEpisodeSynchronization({
            ...realDeps(),
            reconcileIntervalMs: 0,
            beforeFolderWork: () => {
              if (!holdNextFolder) return Effect.void;
              holdNextFolder = false;

              return Effect.promise(async () => {
                entered.resolve();
                await release.promise;
              });
            },
          });

          yield* live.ready;
          yield* Effect.promise(() =>
            Bun.write(join(dataPath, "Author", "Album", "01.mp3", "entry.xml"), "<episode />"),
          );
          holdNextFolder = true;
          yield* Effect.promise(() =>
            copyFile(
              join(AUDIO_FIXTURES, "tagged.mp3"),
              join(filesPath, "Author", "Album", "02.mp3"),
            ),
          );
          yield* live.notify(["Author/Album/02.mp3"]);
          yield* Effect.promise(() => entered.promise);

          const readableWhileBusy = {
            rssTitle: (yield* Effect.promise(() =>
              readRss(join(dataPath, "Author", "Album", "feed.xml")),
            )).rss.channel.title,
            opmlTitle: firstOpmlOutline(
              yield* Effect.promise(() => readOpml(join(dataPath, "feed.opml"))),
            )["@_title"],
          };

          yield* live.requestPass({ force: true });
          release.resolve();
          yield* live.awaitCompletion;
          const statusAfterFollowUp = yield* live.status;

          return { readableWhileBusy, statusAfterFollowUp };
        }),
      ),
    );

    // #then
    const repairedEpisode = await readEpisode(
      join(dataPath, "Author", "Album", "01.mp3", "entry.xml"),
    );

    const rss = await readRss(join(dataPath, "Author", "Album", "feed.xml"));

    expect({
      readableWhileBusy: observed.readableWhileBusy,
      stateAfterFollowUp: observed.statusAfterFollowUp.state,
      repairedTitle: repairedEpisode.title,
      itemGuids: rss.rss.channel.item.map((item) => item.guid["#text"]),
    }).toEqual({
      readableWhileBusy: { rssTitle: "Test Title", opmlTitle: "Test Title" },
      stateAfterFollowUp: "complete",
      repairedTitle: "Test Title",
      itemGuids: ["Author/Album/01.mp3", "Author/Album/02.mp3"],
    });
  });

  test("published RSS and OPML references resolve to existing output and source files", async () => {
    // #given
    await mkdir(join(filesPath, "Author", "Album"), { recursive: true });
    await copyFile(
      join(AUDIO_FIXTURES, "tagged.mp3"),
      join(filesPath, "Author", "Album", "01.mp3"),
    );
    await Bun.write(join(filesPath, "Author", "Album", "cover.png"), tinyPng);

    // #when
    await Effect.runPromise(
      Effect.scoped(openEpisodeSynchronization({ ...realDeps(), reconcileIntervalMs: 0 })),
    );

    // #then
    const rss = await readRss(join(dataPath, "Author", "Album", "feed.xml"));
    const opml = await readOpml(join(dataPath, "feed.opml"));
    const firstItem = firstRssItem(rss);
    const firstOutline = firstOpmlOutline(opml);

    expect({
      itemLink: firstItem.link,
      enclosureExists: await Bun.file(sourceFilePath(firstItem.enclosure["@_url"])).exists(),
      selfExists: await Bun.file(
        publicMetadataPath(rss.rss.channel["atom:link"]!["@_href"]),
      ).exists(),
      coverExists: await Bun.file(
        publicMetadataPath(rss.rss.channel["itunes:image"]!["@_href"]),
      ).exists(),
      outlineFeedExists: await Bun.file(publicMetadataPath(firstOutline["@_xmlUrl"])).exists(),
      outlineCoverExists: await Bun.file(publicMetadataPath(firstOutline["@_imageUrl"]!)).exists(),
    }).toEqual({
      itemLink: undefined,
      enclosureExists: true,
      selfExists: true,
      coverExists: true,
      outlineFeedExists: true,
      outlineCoverExists: true,
    });
  });

  test("a follow-up pass removes deleted episode output and republishes RSS and OPML", async () => {
    // #given
    await mkdir(join(filesPath, "Author", "Album"), { recursive: true });
    await copyFile(
      join(AUDIO_FIXTURES, "tagged.mp3"),
      join(filesPath, "Author", "Album", "01.mp3"),
    );
    await copyFile(
      join(AUDIO_FIXTURES, "tagged.mp3"),
      join(filesPath, "Author", "Album", "02.mp3"),
    );

    // #when
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const live = yield* startEpisodeSynchronization({
            ...realDeps(),
            reconcileIntervalMs: 0,
          });

          yield* live.ready;
          yield* Effect.promise(() => rm(join(filesPath, "Author", "Album", "02.mp3")));
          yield* live.notify(["Author/Album/02.mp3"]);
          yield* live.awaitCompletion;
        }),
      ),
    );

    // #then
    const rss = await readRss(join(dataPath, "Author", "Album", "feed.xml"));
    expect({
      removedEntryExists: await Bun.file(
        join(dataPath, "Author", "Album", "02.mp3", "entry.xml"),
      ).exists(),
      guids: rssGuids(rss),
      opmlExists: await Bun.file(join(dataPath, "feed.opml")).exists(),
    }).toEqual({
      removedEntryExists: false,
      guids: ["Author/Album/01.mp3"],
      opmlExists: true,
    });
  });

  test("a source file vanishing during handling completes as cleanup instead of requeueing forever", async () => {
    // #given
    await mkdir(join(filesPath, "Author", "Album"), { recursive: true });
    const audioPath = join(filesPath, "Author", "Album", "01.mp3");
    await copyFile(join(AUDIO_FIXTURES, "tagged.mp3"), audioPath);
    const deps = realDeps();
    const realLstat = deps.fs.lstat;
    let deletedBeforeHandling = false;
    let targetLstats = 0;
    deps.fs.lstat = async (path) => {
      if (path === audioPath) {
        targetLstats += 1;

        if (!deletedBeforeHandling) {
          deletedBeforeHandling = true;
          await rm(audioPath);
        }
      }

      return realLstat(path);
    };

    // #when
    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const live = yield* startEpisodeSynchronization({ ...deps, reconcileIntervalMs: 0 });
          const completed = yield* Effect.promise(() => completesWithin(live.awaitCompletion, 250));
          const status = yield* live.status;

          return { completed, status };
        }),
      ),
    );

    // #then
    expect({
      completed: observed.completed,
      state: observed.status.state,
      targetLstats,
      entryExists: await Bun.file(
        join(dataPath, "Author", "Album", "01.mp3", "entry.xml"),
      ).exists(),
    }).toEqual({
      completed: true,
      state: "complete",
      targetLstats: 2,
      entryExists: false,
    });
  });

  test("removing a whole source folder drops its RSS and OPML outline", async () => {
    // #given
    await mkdir(join(filesPath, "Author", "Keep"), { recursive: true });
    await mkdir(join(filesPath, "Author", "Remove"), { recursive: true });
    await copyFile(join(AUDIO_FIXTURES, "tagged.mp3"), join(filesPath, "Author", "Keep", "01.mp3"));
    await copyFile(
      join(AUDIO_FIXTURES, "tagged.mp3"),
      join(filesPath, "Author", "Remove", "01.mp3"),
    );

    // #when
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const live = yield* startEpisodeSynchronization({
            ...realDeps(),
            reconcileIntervalMs: 0,
          });

          yield* live.ready;
          yield* Effect.promise(() => rm(join(filesPath, "Author", "Remove"), { recursive: true }));
          yield* live.notify(["Author/Remove"]);
          yield* live.awaitCompletion;
        }),
      ),
    );

    // #then
    const opml = await readOpml(join(dataPath, "feed.opml"));
    expect({
      removedFeedExists: await Bun.file(join(dataPath, "Author", "Remove", "feed.xml")).exists(),
      urls: opmlUrls(opml),
    }).toEqual({
      removedFeedExists: false,
      urls: ["{{{BASE_URL}}}/Author/Keep/feed.xml"],
    });
  });

  test("renaming a whole source folder drops the old RSS and OPML outline", async () => {
    // #given
    await mkdir(join(filesPath, "Author", "Old"), { recursive: true });
    await copyFile(join(AUDIO_FIXTURES, "tagged.mp3"), join(filesPath, "Author", "Old", "01.mp3"));

    // #when
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const live = yield* startEpisodeSynchronization({
            ...realDeps(),
            reconcileIntervalMs: 0,
          });

          yield* live.ready;
          yield* Effect.promise(() =>
            rename(join(filesPath, "Author", "Old"), join(filesPath, "Author", "New")),
          );
          yield* live.notify(["Author/Old", "Author/New"]);
          yield* live.awaitCompletion;
        }),
      ),
    );

    // #then
    const opml = await readOpml(join(dataPath, "feed.opml"));
    const rss = await readRss(join(dataPath, "Author", "New", "feed.xml"));
    expect({
      oldFeedExists: await Bun.file(join(dataPath, "Author", "Old", "feed.xml")).exists(),
      newGuids: rssGuids(rss),
      urls: opmlUrls(opml),
    }).toEqual({
      oldFeedExists: false,
      newGuids: ["Author/New/01.mp3"],
      urls: ["{{{BASE_URL}}}/Author/New/feed.xml"],
    });
  });

  test("replacing an audio file with a same-name directory keeps new child episodes", async () => {
    // #given
    await mkdir(join(filesPath, "Author"), { recursive: true });
    await copyFile(join(AUDIO_FIXTURES, "tagged.mp3"), join(filesPath, "Author", "Book.mp3"));

    // #when
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const live = yield* startEpisodeSynchronization({
            ...realDeps(),
            reconcileIntervalMs: 0,
          });

          yield* live.ready;
          yield* Effect.promise(async () => {
            await rm(join(filesPath, "Author", "Book.mp3"));
            await mkdir(join(filesPath, "Author", "Book.mp3"));
            await copyFile(
              join(AUDIO_FIXTURES, "tagged.mp3"),
              join(filesPath, "Author", "Book.mp3", "01.mp3"),
            );
          });
          yield* live.notify(["Author/Book.mp3", "Author/Book.mp3/01.mp3"]);
          yield* live.awaitCompletion;
        }),
      ),
    );

    // #then
    const opml = await readOpml(join(dataPath, "feed.opml"));
    const rss = await readRss(join(dataPath, "Author", "Book.mp3", "feed.xml"));
    expect({
      staleEntryExists: await Bun.file(join(dataPath, "Author", "Book.mp3", "entry.xml")).exists(),
      childEntryExists: await Bun.file(
        join(dataPath, "Author", "Book.mp3", "01.mp3", "entry.xml"),
      ).exists(),
      guids: rssGuids(rss),
      urls: opmlUrls(opml),
    }).toEqual({
      staleEntryExists: false,
      childEntryExists: true,
      guids: ["Author/Book.mp3/01.mp3"],
      urls: ["{{{BASE_URL}}}/Author/Book.mp3/feed.xml"],
    });
  });

  test("a failed RSS update keeps prior published results and reports work errors", async () => {
    // #given
    await mkdir(join(filesPath, "Author", "Album"), { recursive: true });
    await copyFile(
      join(AUDIO_FIXTURES, "tagged.mp3"),
      join(filesPath, "Author", "Album", "01.mp3"),
    );
    let failFolderWork = false;

    // #when
    const status = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const live = yield* startEpisodeSynchronization({
            ...realDeps(),
            reconcileIntervalMs: 0,
            beforeFolderWork: () =>
              failFolderWork ? Effect.fail(new Error("controlled RSS failure")) : Effect.void,
          });

          yield* live.ready;
          failFolderWork = true;
          yield* live.requestPass({ force: true });
          yield* live.awaitCompletion;

          return yield* live.status;
        }),
      ),
    );

    // #then
    const rss = await readRss(join(dataPath, "Author", "Album", "feed.xml"));
    const opml = await readOpml(join(dataPath, "feed.opml"));
    const firstOutline = firstOpmlOutline(opml);

    expect({
      state: status.state,
      workState: status.work.state,
      errorsReported: status.work.errors.length > 0,
      rssTitle: rss.rss.channel.title,
      opmlTitle: firstOutline["@_title"],
    }).toEqual({
      state: "complete-with-errors",
      workState: "complete-with-errors",
      errorsReported: true,
      rssTitle: "Test Title",
      opmlTitle: "Test Title",
    });
  });

  test("keeps cache projection names separate from the engine state area", async () => {
    // #given
    await mkdir(join(filesPath, "feed.xml"), { recursive: true });
    await mkdir(join(filesPath, "~feed.xml"), { recursive: true });
    await mkdir(join(filesPath, "draft.tmp"), { recursive: true });
    await copyFile(join(AUDIO_FIXTURES, "tagged.mp3"), join(filesPath, "feed.xml", "01.mp3"));
    await copyFile(join(AUDIO_FIXTURES, "tagged.mp3"), join(filesPath, "~feed.xml", "02.mp3"));
    await copyFile(join(AUDIO_FIXTURES, "tagged.mp3"), join(filesPath, "draft.tmp", "03.mp3"));

    // #when
    await Effect.runPromise(
      Effect.scoped(openEpisodeSynchronization({ ...realDeps(), reconcileIntervalMs: 0 })),
    );

    // #then
    const reservedNameEpisode = await readEpisode(
      join(dataPath, "~", "feed.xml", "01.mp3", "entry.xml"),
    );

    const prefixNameEpisode = await readEpisode(join(dataPath, "~feed.xml", "02.mp3", "entry.xml"));

    const suffixNameEpisode = await readEpisode(
      join(dataPath, "~", "draft.tmp", "03.mp3", "entry.xml"),
    );

    const reservedRss = await readRss(join(dataPath, "~", "feed.xml", "feed.xml"));
    const prefixRss = await readRss(join(dataPath, "~feed.xml", "feed.xml"));
    const suffixRss = await readRss(join(dataPath, "~", "draft.tmp", "feed.xml"));
    const opml = await readOpml(join(dataPath, "feed.opml"));

    expect({
      reservedPath: reservedNameEpisode.filePath,
      prefixPath: prefixNameEpisode.filePath,
      suffixPath: suffixNameEpisode.filePath,
      rssSelfUrls: [
        reservedRss.rss.channel["atom:link"]?.["@_href"],
        prefixRss.rss.channel["atom:link"]?.["@_href"],
        suffixRss.rss.channel["atom:link"]?.["@_href"],
      ],
      opmlUrls: opml.opml.body.outline.map((outline) => outline["@_xmlUrl"]).sort(),
      stateExists: await Bun.file(join(dataPath, "~", ".sync-engine", "lock")).exists(),
      misplacedEntryExists: await Bun.file(
        join(dataPath, "~", ".sync-engine", "01.mp3", "entry.xml"),
      ).exists(),
    }).toEqual({
      reservedPath: "feed.xml/01.mp3",
      prefixPath: "~feed.xml/02.mp3",
      suffixPath: "draft.tmp/03.mp3",
      rssSelfUrls: [
        "{{{BASE_URL}}}/feed.xml/feed.xml",
        "{{{BASE_URL}}}/~feed.xml/feed.xml",
        "{{{BASE_URL}}}/draft.tmp/feed.xml",
      ],
      opmlUrls: [
        "{{{BASE_URL}}}/draft.tmp/feed.xml",
        "{{{BASE_URL}}}/feed.xml/feed.xml",
        "{{{BASE_URL}}}/~feed.xml/feed.xml",
      ],
      stateExists: true,
      misplacedEntryExists: false,
    });
  });

  test("unrestricted source names publish every public subscription path", async () => {
    // #given
    const tagged = Bun.file(join(AUDIO_FIXTURES, "tagged.mp3"));

    for (const path of [
      "feed.xml",
      "feed.opml",
      "_entry.xml",
      "entry.xml",
      "cover.jpg",
      "feed.xml.tmp",
      "~",
      "~feed.xml",
      "Nested/feed.xml/entry.xml/cover.jpg",
      "Parent/feed.xml",
    ]) {
      await Bun.write(join(filesPath, path, "01.mp3"), tagged);
    }

    await Bun.write(join(filesPath, "Parent", "direct.mp3"), tagged);
    await Bun.write(join(filesPath, "root.mp3"), tagged);

    // #when
    await Effect.runPromise(
      Effect.scoped(openEpisodeSynchronization({ ...realDeps(), reconcileIntervalMs: 0 })),
    );

    // #then
    const opml = await readOpml(join(dataPath, "feed.opml"));

    expect(opml.opml.body.outline.map((outline) => outline["@_xmlUrl"]).sort()).toEqual(
      [
        "{{{BASE_URL}}}/feed.xml",
        "{{{BASE_URL}}}/feed.xml/feed.xml",
        "{{{BASE_URL}}}/feed.opml/feed.xml",
        "{{{BASE_URL}}}/_entry.xml/feed.xml",
        "{{{BASE_URL}}}/entry.xml/feed.xml",
        "{{{BASE_URL}}}/cover.jpg/feed.xml",
        "{{{BASE_URL}}}/feed.xml.tmp/feed.xml",
        "{{{BASE_URL}}}/~/feed.xml",
        "{{{BASE_URL}}}/~feed.xml/feed.xml",
        "{{{BASE_URL}}}/Nested/feed.xml/entry.xml/cover.jpg/feed.xml",
        "{{{BASE_URL}}}/Parent/feed.xml",
        "{{{BASE_URL}}}/Parent/feed.xml/feed.xml",
      ].sort(),
    );
  });

  test("punctuation-only and whitespace folder names publish usable podcast titles", async () => {
    // #given
    const tagged = Bun.file(join(AUDIO_FIXTURES, "tagged.mp3"));

    for (const folder of ["---", "   ", "my-awesome-book"])
      for (const name of ["01.mp3", "02.mp3"])
        await Bun.write(join(filesPath, folder, name), tagged);

    // #when
    await Effect.runPromise(
      Effect.scoped(openEpisodeSynchronization({ ...realDeps(), reconcileIntervalMs: 0 })),
    );

    // #then
    const opml = await readOpml(join(dataPath, "feed.opml"));

    expect(opml.opml.body.outline.map((outline) => outline["@_title"]).sort()).toEqual([
      "---",
      "My awesome book",
      "Untitled",
    ]);
  });

  test("live file move removes the old feed and publishes the moved feed identity", async () => {
    // #given
    await mkdir(join(filesPath, "Author", "Old"), { recursive: true });
    await mkdir(join(filesPath, "Author", "New"), { recursive: true });
    await copyFile(join(AUDIO_FIXTURES, "tagged.mp3"), join(filesPath, "Author", "Old", "01.mp3"));

    // #when
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const live = yield* startEpisodeSynchronization({
            ...realDeps(),
            reconcileIntervalMs: 0,
          });

          yield* live.ready;
          yield* Effect.promise(() =>
            rename(
              join(filesPath, "Author", "Old", "01.mp3"),
              join(filesPath, "Author", "New", "01.mp3"),
            ),
          );
          yield* live.notify(["Author/Old/01.mp3", "Author/New/01.mp3"]);
          yield* live.awaitCompletion;
        }),
      ),
    );

    // #then
    const opml = await readOpml(join(dataPath, "feed.opml"));
    const rss = await readRss(join(dataPath, "Author", "New", "feed.xml"));

    expect({
      oldFeedExists: await Bun.file(join(dataPath, "Author", "Old", "feed.xml")).exists(),
      newGuid: firstRssItem(rss).guid["#text"],
      opmlUrls: opml.opml.body.outline.map((outline) => outline["@_xmlUrl"]),
    }).toEqual({
      oldFeedExists: false,
      newGuid: "Author/New/01.mp3",
      opmlUrls: ["{{{BASE_URL}}}/Author/New/feed.xml"],
    });
  });

  test("source read failure keeps prior published results instead of confirming deletion", async () => {
    // #given
    await mkdir(join(filesPath, "Author", "Album"), { recursive: true });
    await copyFile(
      join(AUDIO_FIXTURES, "tagged.mp3"),
      join(filesPath, "Author", "Album", "01.mp3"),
    );
    const deps = realDeps();
    await Effect.runPromise(
      Effect.scoped(openEpisodeSynchronization({ ...deps, reconcileIntervalMs: 0 })),
    );

    const status = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const live = yield* startEpisodeSynchronization({ ...deps, reconcileIntervalMs: 0 });
          yield* live.ready;
          const realLstat = deps.fs.lstat;
          deps.fs.lstat = async (path) => {
            if (path === join(filesPath, "Author", "Album", "01.mp3"))
              throw new Error("EACCES controlled read failure");

            return realLstat(path);
          };

          // #when
          yield* live.notify(["Author/Album/01.mp3"]);
          yield* live.awaitCompletion;

          return yield* live.status;
        }),
      ),
    );

    // #then
    const opml = await readOpml(join(dataPath, "feed.opml"));
    const rss = await readRss(join(dataPath, "Author", "Album", "feed.xml"));

    expect({
      state: status.state,
      entryExists: await Bun.file(
        join(dataPath, "Author", "Album", "01.mp3", "entry.xml"),
      ).exists(),
      guid: firstRssItem(rss).guid["#text"],
      opmlUrl: firstOpmlOutline(opml)["@_xmlUrl"],
    }).toEqual({
      state: "complete-with-errors",
      entryExists: true,
      guid: "Author/Album/01.mp3",
      opmlUrl: "{{{BASE_URL}}}/Author/Album/feed.xml",
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
