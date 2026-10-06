import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { XMLParser } from "fast-xml-parser";
import { z } from "zod";
import { ApplicationLifecycle } from "../../../src/app-lifecycle.ts";
import { buildContext } from "../../../src/context.ts";
import { startConsumer } from "../../../src/effect/consumer.ts";
import { registerHandlers } from "../../../src/effect/handlers/index.ts";
import { createTempDir } from "../../helpers/fs-helpers.ts";

const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false });

const cleanups: Array<() => Promise<void>> = [];

const episodeSchema = z.object({
  title: z.string(),
  guid: z.object({ "#text": z.string() }),
  "itunes:episode": z.coerce.number(),
});

const rssSchema = z.object({
  rss: z.object({
    channel: z.object({
      title: z.string(),
      "itunes:author": z.string().optional(),
      item: z.union([episodeSchema, z.array(episodeSchema)]).optional(),
    }),
  }),
});

const outlineSchema = z.object({
  "@_title": z.string(),
  "@_xmlUrl": z.string(),
  "@_author": z.string().optional(),
});

const opmlSchema = z.object({
  opml: z.object({
    body: z.union([
      z.object({ outline: z.union([outlineSchema, z.array(outlineSchema)]).optional() }),
      z.literal(""),
    ]),
  }),
});

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;

  const promise = new Promise<T>((done) => {
    resolve = done;
  });

  return { promise, resolve };
}

async function library() {
  const root = await createTempDir("watcher-publication");
  const filesPath = join(root, "audiobooks");
  const dataPath = join(root, "data");
  await mkdir(filesPath, { recursive: true });
  await mkdir(dataPath, { recursive: true });
  const base = await buildContext();
  let nextOpml = deferred();

  const ctx = {
    ...base,
    config: { ...base.config, filesPath, dataPath },
    fs: {
      ...base.fs,
      atomicWrite: async (path: string, content: string) => {
        await base.fs.atomicWrite(path, content);

        if (path === join(dataPath, "feed.opml")) nextOpml.resolve();
      },
    },
  };

  const app = new ApplicationLifecycle(ctx);
  registerHandlers(ctx.handlers);
  const controller = new AbortController();
  const consumer = startConsumer(ctx, controller.signal);
  app.markAdmissionReady();
  cleanups.push(async () => {
    controller.abort();
    await consumer;
    await rm(root, { recursive: true, force: true });
  });

  return {
    ctx,
    app,
    filesPath,
    dataPath,
    nextPublication: () => {
      nextOpml = deferred();

      return nextOpml.promise;
    },
    audio: async (path: string, fixture = "untagged.mp3") => {
      await Bun.write(join(filesPath, path), Bun.file(join("test/fixtures/audio", fixture)));
    },
  };
}

async function podcast(dataPath: string, path: string) {
  const xml = await Bun.file(join(dataPath, path, "feed.xml")).text();
  const channel = rssSchema.parse(parser.parse(xml)).rss.channel;

  const items =
    channel.item == null ? [] : Array.isArray(channel.item) ? channel.item : [channel.item];

  return {
    title: channel.title,
    author: channel["itunes:author"],
    episodes: items.map((item) => ({
      title: item.title,
      guid: item.guid["#text"],
      number: item["itunes:episode"],
    })),
  };
}

async function subscriptions(dataPath: string) {
  const xml = await Bun.file(join(dataPath, "feed.opml")).text();
  const body = opmlSchema.parse(parser.parse(xml)).opml.body;
  const outline = body === "" ? undefined : body.outline;
  const outlines = outline == null ? [] : Array.isArray(outline) ? outline : [outline];

  return outlines.map((item) => ({
    title: item["@_title"],
    author: item["@_author"],
    url: item["@_xmlUrl"],
  }));
}

describe("source watcher publication through ApplicationLifecycle", () => {
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  test("audio addition publishes RSS, OPML and navigation without data notifications", async () => {
    // #given
    const lib = await library();
    expect(await lib.app.runInitialSync()).toBe(true);
    await lib.audio("Author/Book/02-later.mp3");
    const completed = lib.nextPublication();

    // #when
    expect(
      lib.app.admitBooksEvent({
        parent: join(lib.filesPath, "Author/Book"),
        name: "02-later.mp3",
        events: "CLOSE_WRITE",
      }),
    ).toBe(true);
    await completed;
    await lib.app.waitForIdle();

    // #then
    expect({
      podcast: await podcast(lib.dataPath, "Author/Book"),
      subscriptions: await subscriptions(lib.dataPath),
    }).toEqual({
      podcast: {
        title: "02-later",
        author: "Author",
        episodes: [{ title: "02-later", guid: "Author/Book/02-later.mp3", number: 1 }],
      },
      subscriptions: [
        { title: "02-later", author: "Author", url: "{{{BASE_URL}}}/Author/Book/feed.xml" },
      ],
    });
    const navigation = parser.parse(await Bun.file(join(lib.dataPath, "feed.xml")).text());
    expect(navigation.feed.item.link).toBe("/Author/feed.xml");
  });

  test("delayed deletion after recreation publishes the current file at the same Episode identity", async () => {
    // #given
    const lib = await library();
    await lib.audio("Author/Book/01.mp3");
    expect(await lib.app.runInitialSync()).toBe(true);
    await rm(join(lib.filesPath, "Author/Book/01.mp3"));
    await lib.audio("Author/Book/01.mp3", "tagged.mp3");

    // #when
    expect(
      lib.app.admitBooksEvent({
        parent: join(lib.filesPath, "Author/Book"),
        name: "01.mp3",
        events: "DELETE",
      }),
    ).toBe(true);
    await lib.app.waitForIdle();

    // #then
    expect({
      podcast: await podcast(lib.dataPath, "Author/Book"),
      subscriptions: await subscriptions(lib.dataPath),
    }).toEqual({
      podcast: {
        title: "Test Title",
        author: "Author",
        episodes: [{ title: "Test Title", guid: "Author/Book/01.mp3", number: 1 }],
      },
      subscriptions: [
        { title: "Test Title", author: "Author", url: "{{{BASE_URL}}}/Author/Book/feed.xml" },
      ],
    });
  });

  test("last audio deletion removes the empty Catalog branch while retaining the other podcast", async () => {
    // #given
    const lib = await library();
    await lib.audio("Author/Book/01.mp3");
    await lib.audio("Keeper/Other/keep.mp3");
    expect(await lib.app.runInitialSync()).toBe(true);
    await rm(join(lib.filesPath, "Author/Book/01.mp3"));

    // #when
    expect(
      lib.app.admitBooksEvent({
        parent: join(lib.filesPath, "Author/Book"),
        name: "01.mp3",
        events: "DELETE",
      }),
    ).toBe(true);
    await lib.app.waitForIdle();

    // #then
    const navigation = parser.parse(await Bun.file(join(lib.dataPath, "feed.xml")).text());
    expect({
      subscriptions: await subscriptions(lib.dataPath),
      rootItems: navigation.feed.item,
      authorEntry: await Bun.file(join(lib.dataPath, "Author/_entry.xml")).exists(),
      bookFeed: await Bun.file(join(lib.dataPath, "Author/Book/feed.xml")).exists(),
    }).toEqual({
      subscriptions: [
        { title: "keep", author: "Keeper", url: "{{{BASE_URL}}}/Keeper/Other/feed.xml" },
      ],
      rootItems: { title: "Keeper", link: "/Keeper/feed.xml", description: "1 items" },
      authorEntry: false,
      bookFeed: false,
    });
  });

  test("same-path replacements update an existing podcast and do not lose repeated CLOSE_WRITE hints", async () => {
    // #given
    const lib = await library();
    await lib.audio("Author/Book/01.mp3");
    expect(await lib.app.runInitialSync()).toBe(true);

    const hint = {
      parent: join(lib.filesPath, "Author/Book"),
      name: "01.mp3",
      events: "CLOSE_WRITE",
    };

    expect(lib.app.admitBooksEvent(hint)).toBe(true);
    await lib.app.waitForIdle();
    await lib.audio("Author/Book/01.mp3", "tagged.mp3");

    // #when
    expect(lib.app.admitBooksEvent(hint)).toBe(true);
    await lib.app.waitForIdle();

    // #then
    expect({
      podcast: await podcast(lib.dataPath, "Author/Book"),
      subscriptions: await subscriptions(lib.dataPath),
    }).toEqual({
      podcast: {
        title: "Test Title",
        author: "Author",
        episodes: [{ title: "Test Title", guid: "Author/Book/01.mp3", number: 1 }],
      },
      subscriptions: [
        { title: "Test Title", author: "Author", url: "{{{BASE_URL}}}/Author/Book/feed.xml" },
      ],
    });
  });

  test("renaming an audio file creates the new Episode identity and renumbers listening order", async () => {
    // #given
    const lib = await library();
    await lib.audio("Author/Book/02-middle.mp3");
    await lib.audio("Author/Book/10-last.mp3");
    expect(await lib.app.runInitialSync()).toBe(true);
    await rename(
      join(lib.filesPath, "Author/Book/10-last.mp3"),
      join(lib.filesPath, "Author/Book/01-first.mp3"),
    );

    // #when
    expect(
      lib.app.admitBooksEvent({
        parent: join(lib.filesPath, "Author/Book"),
        name: "10-last.mp3",
        events: "MOVED_FROM",
      }),
    ).toBe(true);
    expect(
      lib.app.admitBooksEvent({
        parent: join(lib.filesPath, "Author/Book"),
        name: "01-first.mp3",
        events: "MOVED_TO",
      }),
    ).toBe(true);
    await lib.app.waitForIdle();

    // #then
    expect({
      podcast: await podcast(lib.dataPath, "Author/Book"),
      subscriptions: await subscriptions(lib.dataPath),
      oldEntry: await Bun.file(join(lib.dataPath, "Author/Book/10-last.mp3/entry.xml")).exists(),
    }).toEqual({
      podcast: {
        title: "Book",
        author: "Author",
        episodes: [
          { title: "01-first", guid: "Author/Book/01-first.mp3", number: 1 },
          { title: "02-middle", guid: "Author/Book/02-middle.mp3", number: 2 },
        ],
      },
      subscriptions: [
        { title: "Book", author: "Author", url: "{{{BASE_URL}}}/Author/Book/feed.xml" },
      ],
      oldEntry: false,
    });
  });

  test("renaming an author folder republishes descendant identities and Podcast author", async () => {
    // #given
    const lib = await library();
    await lib.audio("Old Author/Book/01.mp3", "tagged.mp3");
    expect(await lib.app.runInitialSync()).toBe(true);
    await rename(join(lib.filesPath, "Old Author"), join(lib.filesPath, "New Author"));

    // #when
    expect(
      lib.app.admitBooksEvent({
        parent: lib.filesPath,
        name: "Old Author",
        events: "MOVED_FROM,ISDIR",
      }),
    ).toBe(true);
    expect(
      lib.app.admitBooksEvent({
        parent: lib.filesPath,
        name: "New Author",
        events: "MOVED_TO,ISDIR",
      }),
    ).toBe(true);
    await lib.app.waitForIdle();

    // #then
    expect({
      podcast: await podcast(lib.dataPath, "New Author/Book"),
      subscriptions: await subscriptions(lib.dataPath),
      oldFeed: await Bun.file(join(lib.dataPath, "Old Author/Book/feed.xml")).exists(),
    }).toEqual({
      podcast: {
        title: "Test Title",
        author: "New Author",
        episodes: [{ title: "Test Title", guid: "New Author/Book/01.mp3", number: 1 }],
      },
      subscriptions: [
        {
          title: "Test Title",
          author: "New Author",
          url: "{{{BASE_URL}}}/New%20Author/Book/feed.xml",
        },
      ],
      oldFeed: false,
    });
  });

  test("initial completion inherits a failed parent cascade of metadata work coalesced with a watcher", async () => {
    // #given
    const lib = await library();
    await lib.audio("Author/Book/01.mp3");
    const initialStarted = deferred();
    const releaseInitial = deferred();
    const watcherFeedStarted = deferred();
    const releaseWatcherFeed = deferred();
    const scanFinished = deferred();
    const mkdirBase = lib.ctx.fs.mkdir;
    const writeBase = lib.ctx.fs.atomicWrite;
    const infoBase = lib.ctx.logger.info;
    let initialMkdir = true;
    let heldBookFeed = false;
    cleanups.push(async () => {
      releaseInitial.resolve();
      releaseWatcherFeed.resolve();
    });
    lib.ctx.fs.mkdir = async (path, options) => {
      if (path === lib.dataPath && initialMkdir) {
        initialMkdir = false;
        initialStarted.resolve();
        await releaseInitial.promise;
      }

      await mkdirBase(path, options);
    };

    lib.ctx.fs.atomicWrite = async (path, content) => {
      if (path === join(lib.dataPath, "Author/Book/feed.xml") && !heldBookFeed) {
        heldBookFeed = true;
        watcherFeedStarted.resolve();
        await releaseWatcherFeed.promise;
      }

      if (path === join(lib.dataPath, "feed.xml") && content.includes("/Author/feed.xml")) {
        throw new Error("controlled covered parent publication failure");
      }

      await writeBase(path, content);
    };

    lib.ctx.logger.info = (tag, message, context) => {
      infoBase(tag, message, context);

      if (tag === "InitialSync" && message === "Sync plan created") scanFinished.resolve();
    };

    // #when
    const initial = lib.app.runInitialSync();
    await initialStarted.promise;
    expect(
      lib.app.admitBooksEvent({
        parent: join(lib.filesPath, "Author/Book"),
        name: "01.mp3",
        events: "CLOSE_WRITE",
      }),
    ).toBe(true);
    await watcherFeedStarted.promise;
    releaseInitial.resolve();
    await scanFinished.promise;
    releaseWatcherFeed.resolve();
    const successful = await initial;
    await lib.app.waitForIdle();

    // #then
    expect({
      successful,
      ready: lib.app.isPublicationReady(),
      podcast: await podcast(lib.dataPath, "Author/Book"),
    }).toEqual({
      successful: false,
      ready: false,
      podcast: {
        title: "01",
        author: "Author",
        episodes: [{ title: "01", guid: "Author/Book/01.mp3", number: 1 }],
      },
    });
  });

  test("initial pass finishes with later watcher publication held, then converges to current sources", async () => {
    // #given
    const lib = await library();
    await lib.audio("Author/Book/01-first.mp3");
    const initialOpmlStarted = deferred();
    const releaseInitialOpml = deferred();
    const laterEntryStarted = deferred();
    const releaseLaterEntry = deferred();
    const writeBase = lib.ctx.fs.atomicWrite;
    let firstOpml = true;
    cleanups.push(async () => {
      releaseInitialOpml.resolve();
      releaseLaterEntry.resolve();
    });
    lib.ctx.fs.atomicWrite = async (path, content) => {
      if (path === join(lib.dataPath, "feed.opml") && firstOpml) {
        firstOpml = false;
        initialOpmlStarted.resolve();
        await releaseInitialOpml.promise;
      }

      if (path === join(lib.dataPath, "Later/Other/02-new.mp3/entry.xml")) {
        laterEntryStarted.resolve();
        await releaseLaterEntry.promise;
      }

      await writeBase(path, content);
    };

    // #when
    const initial = lib.app.runInitialSync();
    await initialOpmlStarted.promise;
    await lib.audio("Later/Other/02-new.mp3");
    expect(
      lib.app.admitBooksEvent({
        parent: join(lib.filesPath, "Later/Other"),
        name: "02-new.mp3",
        events: "CLOSE_WRITE",
      }),
    ).toBe(true);
    await laterEntryStarted.promise;
    expect(lib.app.isPublicationReady()).toBe(false);
    releaseInitialOpml.resolve();
    expect(await initial).toBe(true);
    expect(lib.app.isPublicationReady()).toBe(true);
    releaseLaterEntry.resolve();
    await lib.app.waitForIdle();

    // #then
    expect({
      first: await podcast(lib.dataPath, "Author/Book"),
      later: await podcast(lib.dataPath, "Later/Other"),
      subscriptions: await subscriptions(lib.dataPath),
    }).toEqual({
      first: {
        title: "01-first",
        author: "Author",
        episodes: [{ title: "01-first", guid: "Author/Book/01-first.mp3", number: 1 }],
      },
      later: {
        title: "02-new",
        author: "Later",
        episodes: [{ title: "02-new", guid: "Later/Other/02-new.mp3", number: 1 }],
      },
      subscriptions: [
        { title: "01-first", author: "Author", url: "{{{BASE_URL}}}/Author/Book/feed.xml" },
        { title: "02-new", author: "Later", url: "{{{BASE_URL}}}/Later/Other/feed.xml" },
      ],
    });
  });

  test("a delayed folder deletion reconciles a recreated subtree and removes obsolete descendants", async () => {
    // #given
    const lib = await library();
    await lib.audio("Author/Book/old.mp3");
    expect(await lib.app.runInitialSync()).toBe(true);
    await rm(join(lib.filesPath, "Author/Book"), { recursive: true });
    await lib.audio("Author/Book/current.mp3", "tagged.mp3");

    // #when
    expect(
      lib.app.admitBooksEvent({
        parent: join(lib.filesPath, "Author"),
        name: "Book",
        events: "DELETE,ISDIR",
      }),
    ).toBe(true);
    await lib.app.waitForIdle();

    // #then
    expect({
      podcast: await podcast(lib.dataPath, "Author/Book"),
      subscriptions: await subscriptions(lib.dataPath),
      oldEntry: await Bun.file(join(lib.dataPath, "Author/Book/old.mp3/entry.xml")).exists(),
    }).toEqual({
      podcast: {
        title: "Test Title",
        author: "Author",
        episodes: [{ title: "Test Title", guid: "Author/Book/current.mp3", number: 1 }],
      },
      subscriptions: [
        { title: "Test Title", author: "Author", url: "{{{BASE_URL}}}/Author/Book/feed.xml" },
      ],
      oldEntry: false,
    });
  });

  test("pending duplicate updates retain the sorted current subscription list", async () => {
    // #given
    const lib = await library();
    expect(await lib.app.runInitialSync()).toBe(true);
    await lib.audio("Author/Book/02-second.mp3");
    await lib.audio("Author/Book/01-first.mp3");
    await lib.audio("Other/Story/story.mp3");

    // #when
    for (const name of ["02-second.mp3", "01-first.mp3", "02-second.mp3", "01-first.mp3"]) {
      expect(
        lib.app.admitBooksEvent({
          parent: join(lib.filesPath, "Author/Book"),
          name,
          events: "CLOSE_WRITE",
        }),
      ).toBe(true);
    }

    expect(
      lib.app.admitBooksEvent({
        parent: join(lib.filesPath, "Other/Story"),
        name: "story.mp3",
        events: "CLOSE_WRITE",
      }),
    ).toBe(true);
    await lib.app.waitForIdle();

    // #then
    expect({
      podcast: await podcast(lib.dataPath, "Author/Book"),
      subscriptions: await subscriptions(lib.dataPath),
    }).toEqual({
      podcast: {
        title: "Book",
        author: "Author",
        episodes: [
          { title: "01-first", guid: "Author/Book/01-first.mp3", number: 1 },
          { title: "02-second", guid: "Author/Book/02-second.mp3", number: 2 },
        ],
      },
      subscriptions: [
        { title: "Book", author: "Author", url: "{{{BASE_URL}}}/Author/Book/feed.xml" },
        { title: "story", author: "Other", url: "{{{BASE_URL}}}/Other/Story/feed.xml" },
      ],
    });
  });

  test("supported audio and folder names beginning with underscores remain in RSS and navigation", async () => {
    // #given
    const lib = await library();
    expect(await lib.app.runInitialSync()).toBe(true);
    await lib.audio("_Author/_Book/_intro.mp3");

    // #when
    expect(
      lib.app.admitBooksEvent({ parent: lib.filesPath, name: "_Author", events: "MOVED_TO,ISDIR" }),
    ).toBe(true);
    await lib.app.waitForIdle();

    // #then
    const navigation = parser.parse(await Bun.file(join(lib.dataPath, "feed.xml")).text());
    expect({
      podcast: await podcast(lib.dataPath, "_Author/_Book"),
      subscriptions: await subscriptions(lib.dataPath),
      navigation: navigation.feed.item,
    }).toEqual({
      podcast: {
        title: "_intro",
        author: "_Author",
        episodes: [{ title: "_intro", guid: "_Author/_Book/_intro.mp3", number: 1 }],
      },
      subscriptions: [
        { title: "_intro", author: "_Author", url: "{{{BASE_URL}}}/_Author/_Book/feed.xml" },
      ],
      navigation: { title: "Author", link: "/_Author/feed.xml", description: "1 items" },
    });
  });

  test("a source access error retains publication and does not stop independent watcher updates", async () => {
    // #given
    const lib = await library();
    await lib.audio("Author/Book/original.mp3");
    await lib.audio("Other/Story/story.mp3");
    expect(await lib.app.runInitialSync()).toBe(true);
    await lib.audio("Other/Story/story.mp3", "tagged.mp3");
    const statBase = lib.ctx.fs.stat;
    lib.ctx.fs.stat = (path) => {
      if (path === join(lib.filesPath, "Author/Book/original.mp3")) {
        return Promise.reject(
          Object.assign(new Error("controlled source access error"), { code: "EACCES" }),
        );
      }

      return statBase(path);
    };

    // #when
    expect(
      lib.app.admitBooksEvent({
        parent: join(lib.filesPath, "Author/Book"),
        name: "original.mp3",
        events: "DELETE",
      }),
    ).toBe(true);
    expect(
      lib.app.admitBooksEvent({
        parent: join(lib.filesPath, "Other/Story"),
        name: "story.mp3",
        events: "CLOSE_WRITE",
      }),
    ).toBe(true);
    await lib.app.waitForIdle();

    // #then
    expect({
      original: await podcast(lib.dataPath, "Author/Book"),
      updated: await podcast(lib.dataPath, "Other/Story"),
      subscriptions: await subscriptions(lib.dataPath),
    }).toEqual({
      original: {
        title: "original",
        author: "Author",
        episodes: [{ title: "original", guid: "Author/Book/original.mp3", number: 1 }],
      },
      updated: {
        title: "Test Title",
        author: "Other",
        episodes: [{ title: "Test Title", guid: "Other/Story/story.mp3", number: 1 }],
      },
      subscriptions: [
        { title: "original", author: "Author", url: "{{{BASE_URL}}}/Author/Book/feed.xml" },
        { title: "Test Title", author: "Other", url: "{{{BASE_URL}}}/Other/Story/feed.xml" },
      ],
    });
  });

  test("a held pass-final OPML snapshot cannot overwrite newer watcher subscription information", async () => {
    // #given
    const lib = await library();
    await lib.audio("Author/Book/01-first.mp3");
    const initialWriteStarted = deferred();
    const releaseInitialWrite = deferred();
    const watcherOpmlStarted = deferred();
    const writeBase = lib.ctx.fs.atomicWrite;
    const readBase = lib.ctx.fs.readdir;
    const infoBase = lib.ctx.logger.info;
    let initialWriteHeld = false;
    let watcherPublicationStarted = false;
    let concurrentCollection = false;
    let opmlWrites = 0;
    cleanups.push(async () => {
      releaseInitialWrite.resolve();
    });
    lib.ctx.fs.readdir = (path) => {
      if (path === lib.dataPath && initialWriteHeld && watcherPublicationStarted)
        concurrentCollection = true;

      return readBase(path);
    };

    lib.ctx.fs.atomicWrite = async (path, content) => {
      if (path !== join(lib.dataPath, "feed.opml")) {
        await writeBase(path, content);

        return;
      }

      opmlWrites++;

      if (opmlWrites === 1) {
        initialWriteHeld = true;
        initialWriteStarted.resolve();
        await releaseInitialWrite.promise;
        await writeBase(path, content);
        initialWriteHeld = false;
      } else {
        await writeBase(path, content);
        releaseInitialWrite.resolve();
      }
    };

    lib.ctx.logger.info = (tag, message, context) => {
      infoBase(tag, message, context);

      if (
        tag === "Consumer" &&
        message === "Handler started" &&
        (context?.event_tag === "FeedXmlCreated" || context?.event_tag === "FeedXmlChanged")
      ) {
        watcherPublicationStarted = true;
        watcherOpmlStarted.resolve();
      }
    };

    // #when
    const initial = lib.app.runInitialSync();
    await initialWriteStarted.promise;
    await lib.audio("Later/Other/02-new.mp3");
    expect(
      lib.app.admitBooksEvent({
        parent: join(lib.filesPath, "Later/Other"),
        name: "02-new.mp3",
        events: "CLOSE_WRITE",
      }),
    ).toBe(true);
    await watcherOpmlStarted.promise;

    // A competing collector must finish its newer write before the held old snapshot.
    // A serialized collector can proceed only after the held write is released.
    if (!concurrentCollection) releaseInitialWrite.resolve();
    const successful = await initial;
    await lib.app.waitForIdle();

    // #then
    expect({ successful, subscriptions: await subscriptions(lib.dataPath) }).toEqual({
      successful: true,
      subscriptions: [
        { title: "01-first", author: "Author", url: "{{{BASE_URL}}}/Author/Book/feed.xml" },
        { title: "02-new", author: "Later", url: "{{{BASE_URL}}}/Later/Other/feed.xml" },
      ],
    });
  });
});
