import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readdir, rename, rm, stat, lstat, symlink, unlink, utimes } from "node:fs/promises";
import { dirname, join } from "node:path";
import { err, ok } from "neverthrow";
import { XMLParser } from "fast-xml-parser";
import { ApplicationLifecycle } from "../../../src/app-lifecycle.ts";
import { buildContext, type AppContext, type FileSystemService } from "../../../src/context.ts";
import { startConsumer } from "../../../src/effect/consumer.ts";
import { registerHandlers } from "../../../src/effect/handlers/index.ts";
import { createFileStructure, createTempDir, cleanupTempDir } from "../../helpers/fs-helpers.ts";

const tempDirs: string[] = [];

const controllers: AbortController[] = [];

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;

  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });

  return { promise, resolve };
}

function realFs(): FileSystemService {
  return {
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
    exists: async (path) => Bun.file(path).exists(),
    writeFile: async (path, content) => {
      await Bun.write(path, content);
    },
    atomicWrite: async (path, content) => {
      await mkdir(dirname(path), { recursive: true });
      const tmpPath = `${path}.tmp`;
      await Bun.write(tmpPath, content);
      await rename(tmpPath, path);
    },
    symlink: async (target, path) => {
      try {
        await unlink(path);
      } catch {
        // missing link is fine
      }

      await symlink(target, path);
    },
    unlink: (path) => unlink(path),
  };
}

async function makeTempContext(): Promise<{
  ctx: AppContext;
  filesPath: string;
  dataPath: string;
  opmlWrites: string[];
  failOpmlWrites: (enabled: boolean) => void;
}> {
  const root = await createTempDir("initial-pass-lifecycle");
  tempDirs.push(root);
  const filesPath = join(root, "audiobooks");
  const dataPath = join(root, "data");
  await mkdir(filesPath, { recursive: true });
  await mkdir(dataPath, { recursive: true });

  const base = await buildContext();
  const fs = realFs();
  const opmlWrites: string[] = [];
  let shouldFailOpmlWrites = false;

  return {
    filesPath,
    dataPath,
    ctx: {
      ...base,
      config: {
        ...base.config,
        filesPath,
        dataPath,
      },
      fs: {
        ...fs,
        atomicWrite: async (path, content) => {
          if (path.endsWith("feed.opml")) opmlWrites.push(content);

          if (path.endsWith("feed.opml") && shouldFailOpmlWrites) {
            throw new Error("controlled OPML write failure");
          }

          await fs.atomicWrite(path, content);
        },
      },
    },
    opmlWrites,
    failOpmlWrites: (enabled) => {
      shouldFailOpmlWrites = enabled;
    },
  };
}

describe("initial synchronization lifecycle", () => {
  afterEach(async () => {
    for (const controller of controllers.splice(0)) controller.abort();
    await Promise.all(tempDirs.splice(0).map((dir) => cleanupTempDir(dir)));
  });

  test("held publication keeps admission ready and publication readiness false", async () => {
    // #given
    const { ctx } = await makeTempContext();
    const app = new ApplicationLifecycle(ctx);
    const controller = new AbortController();
    controllers.push(controller);
    const handlerStarted = deferred();
    const releaseHandler = deferred();
    let passFinished = false;

    ctx.handlers.register("FolderCreated", async () => {
      handlerStarted.resolve();
      await releaseHandler.promise;

      return ok([]);
    });

    const consumerTask = startConsumer(ctx, controller.signal);
    app.markAdmissionReady();

    // #when
    const passTask = app.runInitialSync().then(() => {
      passFinished = true;
    });

    await handlerStarted.promise;

    // #then
    expect(app.isAdmissionReady()).toBe(true);
    expect(app.isPublicationReady()).toBe(false);
    expect(ctx.queue.size).toBe(0);
    await Promise.resolve();
    expect(passFinished).toBe(false);

    releaseHandler.resolve();
    await passTask;
    expect(passFinished).toBe(true);
    controller.abort();
    await consumerTask;
  });

  test("initial pass publishes RSS and one final OPML without data watcher notifications", async () => {
    // #given
    const { ctx, filesPath, dataPath, opmlWrites } = await makeTempContext();
    const app = new ApplicationLifecycle(ctx);
    const fixture = await Bun.file("test/fixtures/audio/untagged.mp3").arrayBuffer();
    await createFileStructure(filesPath, {
      Author: {
        "Book One": {
          "01-intro.mp3": Buffer.from(fixture),
        },
      },
    });
    registerHandlers(ctx.handlers);
    const controller = new AbortController();
    controllers.push(controller);
    const consumerTask = startConsumer(ctx, controller.signal);
    app.markAdmissionReady();

    // #when
    const successful = await app.runInitialSync();

    // #then
    const feedXml = await Bun.file(join(dataPath, "Author", "Book One", "feed.xml")).text();
    const opmlXml = await Bun.file(join(dataPath, "feed.opml")).text();
    expect(successful).toBe(true);
    expect(app.isPublicationReady()).toBe(true);
    expect(feedXml).toContain("<title>01-intro</title>");
    expect(opmlWrites).toHaveLength(1);
    expect(opmlXml).toContain("01-intro");
    expect(opmlXml).toContain("/Author/Book%20One/feed.xml");

    controller.abort();
    await consumerTask;
  });

  test("later watcher work does not extend the initial pass", async () => {
    // #given
    const { ctx } = await makeTempContext();
    const app = new ApplicationLifecycle(ctx);
    const controller = new AbortController();
    controllers.push(controller);
    const initialHandlerStarted = deferred();
    const releaseInitialHandler = deferred();
    const liveHandlerStarted = deferred();
    const releaseLiveHandler = deferred();
    let initialFinished = false;

    ctx.handlers.register("FolderCreated", async () => {
      initialHandlerStarted.resolve();
      ctx.queue.enqueue({ _tag: "FolderMetaSyncRequested", path: "/live/later" });
      await releaseInitialHandler.promise;

      return ok([]);
    });
    ctx.handlers.register("FolderMetaSyncRequested", async () => {
      liveHandlerStarted.resolve();
      await releaseLiveHandler.promise;

      return ok([]);
    });

    const consumerTask = startConsumer(ctx, controller.signal);
    app.markAdmissionReady();

    // #when
    const initialTask = app.runInitialSync().then((successful) => {
      initialFinished = successful;
    });

    await initialHandlerStarted.promise;
    releaseInitialHandler.resolve();
    await liveHandlerStarted.promise;
    await initialTask;

    // #then
    expect(initialFinished).toBe(true);
    expect(app.isPublicationReady()).toBe(true);

    releaseLiveHandler.resolve();
    controller.abort();
    await consumerTask;
  });

  test("coalesced covered work waits for the merged ordinary event and inherits its failure", async () => {
    // #given
    const { ctx, dataPath } = await makeTempContext();
    const app = new ApplicationLifecycle(ctx);
    const controller = new AbortController();
    controllers.push(controller);
    const mergedHandlerStarted = deferred();
    const releaseMergedHandler = deferred();
    let initialFinished = false;

    ctx.handlers.register("FolderCreated", async () => {
      ctx.queue.enqueue({ _tag: "FolderMetaSyncRequested", path: dataPath });

      return ok([{ _tag: "FolderMetaSyncRequested", path: dataPath }] as const);
    });
    ctx.handlers.register("FolderMetaSyncRequested", async () => {
      mergedHandlerStarted.resolve();
      await releaseMergedHandler.promise;

      return err(new Error("controlled merged event failure"));
    });

    const consumerTask = startConsumer(ctx, controller.signal);
    app.markAdmissionReady();

    // #when
    const initialTask = app.runInitialSync().then((successful) => {
      initialFinished = successful;
    });

    await mergedHandlerStarted.promise;
    await Promise.resolve();

    // #then
    expect(initialFinished).toBe(false);

    releaseMergedHandler.resolve();
    await initialTask;
    expect(initialFinished).toBe(false);
    expect(app.isPublicationReady()).toBe(false);

    controller.abort();
    await consumerTask;
  });

  test("failed final OPML publication leaves independent RSS work published but readiness false", async () => {
    // #given
    const { ctx, filesPath, dataPath, failOpmlWrites } = await makeTempContext();
    const app = new ApplicationLifecycle(ctx);
    const fixture = await Bun.file("test/fixtures/audio/untagged.mp3").arrayBuffer();
    await createFileStructure(filesPath, {
      Author: {
        "Book One": { "01-intro.mp3": Buffer.from(fixture) },
        "Book Two": { "01-start.mp3": Buffer.from(fixture) },
      },
    });
    registerHandlers(ctx.handlers);
    failOpmlWrites(true);
    const controller = new AbortController();
    controllers.push(controller);
    const consumerTask = startConsumer(ctx, controller.signal);
    app.markAdmissionReady();

    // #when
    const successful = await app.runInitialSync();

    // #then
    const firstFeed = await Bun.file(join(dataPath, "Author", "Book One", "feed.xml")).text();
    const secondFeed = await Bun.file(join(dataPath, "Author", "Book Two", "feed.xml")).text();
    expect(successful).toBe(false);
    expect(app.isPublicationReady()).toBe(false);
    expect(firstFeed).toContain("01-intro");
    expect(secondFeed).toContain("01-start");

    controller.abort();
    await consumerTask;
  });

  test.each([
    ["malformed XML", "<episode><title>broken"],
    ["missing fields", "<episode><title>broken</title></episode>"],
    [
      "invalid numbers",
      "<episode><title>broken</title><fileName>01-intro.mp3</fileName><filePath>Author/Book/01-intro.mp3</filePath><fileSize>NaN</fileSize><mimeType>audio/mpeg</mimeType><episodeNumber>1</episodeNumber><pubDate>2020-01-01T00:00:00Z</pubDate><guid>Author/Book/01-intro.mp3</guid></episode>",
    ],
  ])("startup rebuilds fresh but unusable episode metadata: %s", async (_name, cache) => {
    // #given
    const { ctx, filesPath, dataPath } = await makeTempContext();
    const fixture = Buffer.from(await Bun.file("test/fixtures/audio/untagged.mp3").arrayBuffer());
    await createFileStructure(filesPath, { Author: { Book: { "01-intro.mp3": fixture } } });
    const entryPath = join(dataPath, "Author/Book/01-intro.mp3/entry.xml");
    await mkdir(dirname(entryPath), { recursive: true });
    await Bun.write(entryPath, cache);
    await utimes(entryPath, new Date("2030-01-01"), new Date("2030-01-01"));
    registerHandlers(ctx.handlers);
    const controller = new AbortController();
    controllers.push(controller);
    const consumerTask = startConsumer(ctx, controller.signal);
    const app = new ApplicationLifecycle(ctx);

    // #when
    const successful = await app.runInitialSync();

    // #then
    const parsed = new XMLParser().parse(
      await Bun.file(join(dataPath, "Author/Book/feed.xml")).text(),
    );

    expect({
      successful,
      ready: app.isPublicationReady(),
      title: parsed.rss.channel.title,
      author: parsed.rss.channel["itunes:author"],
      item: {
        title: parsed.rss.channel.item.title,
        guid: parsed.rss.channel.item.guid,
        episode: parsed.rss.channel.item["itunes:episode"],
      },
    }).toEqual({
      successful: true,
      ready: true,
      title: "01-intro",
      author: "Author",
      item: { title: "01-intro", guid: "Author/Book/01-intro.mp3", episode: 1 },
    });
    controller.abort();
    await consumerTask;
  });

  test("startup prunes obsolete episodes and unmarked empty published subtrees", async () => {
    // #given
    const { ctx, filesPath, dataPath } = await makeTempContext();
    const fixture = Buffer.from(await Bun.file("test/fixtures/audio/untagged.mp3").arrayBuffer());
    await createFileStructure(filesPath, { Author: { Book: { "01-intro.mp3": fixture } } });
    registerHandlers(ctx.handlers);
    const controller = new AbortController();
    controllers.push(controller);
    const consumerTask = startConsumer(ctx, controller.signal);
    const seedApp = new ApplicationLifecycle(ctx);
    expect(await seedApp.runInitialSync()).toBe(true);
    await createFileStructure(dataPath, {
      Author: {
        Book: { "obsolete.mp3": { "entry.xml": "<episode><title>obsolete</title></episode>" } },
      },
      Empty: { Deep: { "feed.xml": "<rss><channel><title>Ghost</title></channel></rss>" } },
      _Removed: { "feed.xml": "<rss><channel><title>Hidden Ghost</title></channel></rss>" },
    });
    await mkdir(join(filesPath, "Empty/Deep"), { recursive: true });
    const app = new ApplicationLifecycle(ctx);

    // #when
    const successful = await app.runInitialSync();

    // #then
    const parser = new XMLParser({ ignoreAttributes: false });
    const opml = parser.parse(await Bun.file(join(dataPath, "feed.opml")).text());
    const root = parser.parse(await Bun.file(join(dataPath, "feed.xml")).text());
    expect({
      successful,
      paths: (await readdir(dataPath)).sort(),
      episodes: (await readdir(join(dataPath, "Author/Book"))).filter((name) =>
        name.endsWith(".mp3"),
      ),
      navigation: root.feed.item.title,
      outline: opml.opml.body.outline,
    }).toEqual({
      successful: true,
      paths: ["Author", "feed.opml", "feed.xml"],
      episodes: ["01-intro.mp3"],
      navigation: "Author",
      outline: {
        "@_text": "01-intro",
        "@_title": "01-intro",
        "@_type": "rss",
        "@_xmlUrl": "{{{BASE_URL}}}/Author/Book/feed.xml",
        "@_author": "Author",
      },
    });
    controller.abort();
    await consumerTask;
  });

  test.each(["missing", "stale"])(
    "recovery reuses episode metadata and repairs %s RSS and OPML without notifications",
    async (state) => {
      // #given
      const { ctx, filesPath, dataPath, opmlWrites } = await makeTempContext();
      const fixture = Buffer.from(await Bun.file("test/fixtures/audio/untagged.mp3").arrayBuffer());
      await createFileStructure(filesPath, {
        Author: {
          Book: {
            "02-end.mp3": fixture,
            "01-intro.mp3": fixture,
          },
        },
      });
      registerHandlers(ctx.handlers);
      const controller = new AbortController();
      controllers.push(controller);
      const consumerTask = startConsumer(ctx, controller.signal);
      expect(await new ApplicationLifecycle(ctx).runInitialSync()).toBe(true);
      const before = await Bun.file(join(dataPath, "Author/Book/01-intro.mp3/entry.xml")).text();
      const rssPath = join(dataPath, "Author/Book/feed.xml");
      const opmlPath = join(dataPath, "feed.opml");

      if (state === "missing") {
        await rm(rssPath);
        await rm(opmlPath);
      } else {
        await Bun.write(rssPath, "<rss><channel><title>obsolete</title></channel></rss>");
        await Bun.write(opmlPath, '<opml><body><outline text="obsolete"/></body></opml>');
      }

      let episodeWrites = 0;
      const atomicWrite = ctx.fs.atomicWrite;
      ctx.fs.atomicWrite = async (path, content) => {
        if (path.endsWith("/entry.xml")) episodeWrites++;
        await atomicWrite(path, content);
      };

      const app = new ApplicationLifecycle(ctx);

      // #when
      const startup = await app.runInitialSync();
      await rm(opmlPath);
      const reconciled = await app.runPublicationPass("Reconciliation");

      // #then
      const parser = new XMLParser({ ignoreAttributes: false });
      const channel = parser.parse(await Bun.file(rssPath).text()).rss.channel;
      const outlines = parser.parse(await Bun.file(opmlPath).text()).opml.body.outline;
      expect({
        startup,
        reconciled,
        episodeWrites,
        unchanged:
          before === (await Bun.file(join(dataPath, "Author/Book/01-intro.mp3/entry.xml")).text()),
        title: channel.title,
        author: channel["itunes:author"],
        episodes: channel.item.map(
          (item: { title: string; guid: { "#text": string }; "itunes:episode": number }) => ({
            title: item.title,
            guid: item.guid["#text"],
            number: item["itunes:episode"],
          }),
        ),
        outlines,
        opmlWrites: opmlWrites.length,
      }).toEqual({
        startup: true,
        reconciled: true,
        episodeWrites: 0,
        unchanged: true,
        title: "Book",
        author: "Author",
        episodes: [
          { title: "01-intro", guid: "Author/Book/01-intro.mp3", number: 1 },
          { title: "02-end", guid: "Author/Book/02-end.mp3", number: 2 },
        ],
        outlines: {
          "@_text": "Book",
          "@_title": "Book",
          "@_type": "rss",
          "@_xmlUrl": "{{{BASE_URL}}}/Author/Book/feed.xml",
          "@_author": "Author",
        },
        opmlWrites: 3,
      });
      controller.abort();
      await consumerTask;
    },
  );

  test.each(["missing", "stale"])(
    "reconciliation rebuilds %s cached metadata from unchanged source",
    async (state) => {
      // #given
      const { ctx, filesPath, dataPath } = await makeTempContext();
      const fixture = Buffer.from(await Bun.file("test/fixtures/audio/untagged.mp3").arrayBuffer());
      await createFileStructure(filesPath, { Author: { Book: { "01-intro.mp3": fixture } } });
      registerHandlers(ctx.handlers);
      const controller = new AbortController();
      controllers.push(controller);
      const consumerTask = startConsumer(ctx, controller.signal);
      const app = new ApplicationLifecycle(ctx);
      expect(await app.runInitialSync()).toBe(true);
      const entryPath = join(dataPath, "Author/Book/01-intro.mp3/entry.xml");

      if (state === "missing") {
        await rm(entryPath);
      } else {
        const cached = await Bun.file(entryPath).text();
        await Bun.write(
          entryPath,
          cached.replace("<title>01-intro</title>", "<title>obsolete</title>"),
        );
        await utimes(entryPath, new Date("2000-01-01"), new Date("2000-01-01"));
      }

      // #when
      const successful = await app.runPublicationPass("Reconciliation");

      // #then
      const parsed = new XMLParser().parse(
        await Bun.file(join(dataPath, "Author/Book/feed.xml")).text(),
      );

      expect({
        successful,
        title: parsed.rss.channel.item.title,
        guid: parsed.rss.channel.item.guid,
      }).toEqual({ successful: true, title: "01-intro", guid: "Author/Book/01-intro.mp3" });
      controller.abort();
      await consumerTask;
    },
  );

  test("failed RSS publication continues independent work and a recovery pass establishes readiness", async () => {
    // #given
    const { ctx, filesPath, dataPath } = await makeTempContext();
    const fixture = Buffer.from(await Bun.file("test/fixtures/audio/untagged.mp3").arrayBuffer());
    await createFileStructure(filesPath, {
      Author: {
        First: { "01-intro.mp3": fixture },
        Second: { "01-start.mp3": fixture },
      },
    });
    registerHandlers(ctx.handlers);
    const controller = new AbortController();
    controllers.push(controller);
    let fail = true;
    const fs = ctx.fs;

    const faultContext: AppContext = {
      ...ctx,
      fs: {
        ...fs,
        atomicWrite: async (path, content) => {
          if (fail && path === join(dataPath, "Author/First/feed.xml"))
            throw new Error("controlled RSS write failure");
          await fs.atomicWrite(path, content);
        },
      },
    };

    const consumerTask = startConsumer(faultContext, controller.signal);
    const app = new ApplicationLifecycle(faultContext);
    app.markAdmissionReady();

    // #when
    const initial = await app.runInitialSync();
    const readyAfterFailure = app.isPublicationReady();

    const independent = new XMLParser().parse(
      await Bun.file(join(dataPath, "Author/Second/feed.xml")).text(),
    ).rss.channel.item.title;

    fail = false;
    const recovery = await app.runPublicationPass("Reconciliation");

    // #then
    const parser = new XMLParser({ ignoreAttributes: false });

    const first = parser.parse(await Bun.file(join(dataPath, "Author/First/feed.xml")).text()).rss
      .channel;

    const outlines = parser.parse(await Bun.file(join(dataPath, "feed.opml")).text()).opml.body
      .outline;

    expect({
      initial,
      readyAfterFailure,
      independent,
      recovery,
      ready: app.isPublicationReady(),
      admission: app.isAdmissionReady(),
      firstTitle: first.title,
      outlines: outlines.map(
        (outline: { "@_title": string; "@_author": string; "@_xmlUrl": string }) => ({
          title: outline["@_title"],
          author: outline["@_author"],
          url: outline["@_xmlUrl"],
        }),
      ),
    }).toEqual({
      initial: false,
      readyAfterFailure: false,
      independent: "01-start",
      recovery: true,
      ready: true,
      admission: true,
      firstTitle: "01-intro",
      outlines: [
        { title: "01-intro", author: "Author", url: "{{{BASE_URL}}}/Author/First/feed.xml" },
        { title: "01-start", author: "Author", url: "{{{BASE_URL}}}/Author/Second/feed.xml" },
      ],
    });
    controller.abort();
    await consumerTask;
  });

  test("scheduled reconciliation skips a busy interval without deferring and retries at the next interval", async () => {
    // #given
    const { ctx, filesPath, dataPath } = await makeTempContext();
    const fixture = Buffer.from(await Bun.file("test/fixtures/audio/untagged.mp3").arrayBuffer());
    await createFileStructure(filesPath, { Author: { Book: { "01-intro.mp3": fixture } } });
    const controller = new AbortController();
    controllers.push(controller);
    const held = deferred();
    const release = deferred();
    const repaired = deferred();
    const starts: string[] = [];
    const fs = ctx.fs;

    const scheduledContext: AppContext = {
      ...ctx,
      config: { ...ctx.config, reconcileInterval: 60 },
      fs: {
        ...fs,
        atomicWrite: async (path, content) => {
          if (path === join(dataPath, "Author/Book/feed.xml") && starts.length === 1) {
            held.resolve();
            await release.promise;
          }

          await fs.atomicWrite(path, content);
        },
      },
      logger: {
        ...ctx.logger,
        info: (tag, message, context) => {
          ctx.logger.info(tag, message, context);

          if (message === "Starting" && (tag === "InitialSync" || tag === "Reconciliation"))
            starts.push(tag);

          if (tag === "Reconciliation" && message === "Published") repaired.resolve();
        },
      },
    };

    registerHandlers(ctx.handlers);
    const consumerTask = startConsumer(scheduledContext, controller.signal);
    const app = new ApplicationLifecycle(scheduledContext);
    const initialTask = app.runInitialSync();
    await held.promise;
    const intervals: number[] = [];
    const ticks: ReturnType<typeof deferred<void>>[] = [];
    let waiting = deferred();

    const wait = async (ms: number, signal: AbortSignal) => {
      intervals.push(ms);
      const tick = deferred();
      ticks.push(tick);
      const abort = () => tick.resolve();
      signal.addEventListener("abort", abort, { once: true });
      waiting.resolve();
      await tick.promise;
      signal.removeEventListener("abort", abort);
    };

    // #when
    const schedulerTask = app.startReconciliation(controller.signal, wait);
    await waiting.promise;
    waiting = deferred();
    ticks[0]!.resolve();
    await waiting.promise;
    release.resolve();
    expect(await initialTask).toBe(true);
    const startsBeforeNextInterval = [...starts];
    await rm(join(dataPath, "feed.opml"));
    waiting = deferred();
    ticks[1]!.resolve();
    await repaired.promise;
    await waiting.promise;
    controller.abort();
    await Promise.all([schedulerTask, consumerTask]);

    // #then
    const opml = new XMLParser({ ignoreAttributes: false }).parse(
      await Bun.file(join(dataPath, "feed.opml")).text(),
    );

    expect({
      startsBeforeNextInterval,
      starts,
      intervals,
      ready: app.isPublicationReady(),
      outline: opml.opml.body.outline["@_title"],
    }).toEqual({
      startsBeforeNextInterval: ["InitialSync"],
      starts: ["InitialSync", "Reconciliation"],
      intervals: [60000, 60000, 60000],
      ready: true,
      outline: "01-intro",
    });
  });

  test("disabled periodic reconciliation creates no timer or deferred pass", async () => {
    // #given
    const { ctx, opmlWrites } = await makeTempContext();

    const app = new ApplicationLifecycle({
      ...ctx,
      config: { ...ctx.config, reconcileInterval: 0 },
    });

    let waits = 0;
    const controller = new AbortController();

    // #when
    await app.startReconciliation(controller.signal, async () => {
      waits++;
      controller.abort();
    });

    // #then
    expect({
      waits,
      publicationWrites: opmlWrites.length,
      ready: app.isPublicationReady(),
    }).toEqual({ waits: 0, publicationWrites: 0, ready: false });
  });
});
