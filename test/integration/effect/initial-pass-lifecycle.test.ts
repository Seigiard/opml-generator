import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readdir, rename, rm, stat, symlink, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { err, ok } from "neverthrow";
import { ApplicationLifecycle } from "../../../src/app-lifecycle.ts";
import { buildContext, type AppContext, type FileSystemService } from "../../../src/context.ts";
import { startConsumer } from "../../../src/effect/consumer.ts";
import { registerHandlers } from "../../../src/effect/handlers/index.ts";
import { createFileStructure, createTempDir, cleanupTempDir } from "../../helpers/fs-helpers.ts";

const tempDirs: string[] = [];
const controllers: AbortController[] = [];

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}

function realFs(): FileSystemService {
  return {
    mkdir: async (path, options) => {
      await mkdir(path, options);
    },
    rm: (path, options) => rm(path, options),
    readdir: (path) => readdir(path),
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
});
