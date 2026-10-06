import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readdir, rename, rm, stat, symlink, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ok } from "neverthrow";
import { buildContext, type AppContext, type FileSystemService } from "../../../src/context.ts";
import { adaptSyncPlan } from "../../../src/effect/adapters/sync-plan-adapter.ts";
import { startConsumer } from "../../../src/effect/consumer.ts";
import { registerHandlers } from "../../../src/effect/handlers/index.ts";
import { opmlSync } from "../../../src/effect/handlers/opml-sync.ts";
import { scanFiles, createSyncPlan } from "../../../src/scanner.ts";
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
          await fs.atomicWrite(path, content);
        },
      },
    },
    opmlWrites,
  };
}

async function runInitialPass(ctx: AppContext): Promise<void> {
  const files = await scanFiles(ctx.config.filesPath);
  const plan = await createSyncPlan(files, ctx.config.dataPath);
  const events = adaptSyncPlan(plan, ctx.config.filesPath);
  const passId = ctx.lifecycle.startPass();
  ctx.lifecycle.enqueueMany(ctx.queue, events, passId);
  await ctx.lifecycle.waitFor(passId);

  const result = await opmlSync(
    { _tag: "FeedXmlCreated", path: ctx.config.dataPath },
    { config: ctx.config, logger: ctx.logger, fs: ctx.fs },
  );

  if (result.isErr()) throw result.error;
}

describe("initial synchronization lifecycle", () => {
  afterEach(async () => {
    for (const controller of controllers.splice(0)) controller.abort();
    await Promise.all(tempDirs.splice(0).map((dir) => cleanupTempDir(dir)));
  });

  test("active handler keeps the pass unfinished when the pending queue is empty", async () => {
    // #given
    const { ctx } = await makeTempContext();
    const controller = new AbortController();
    controllers.push(controller);
    const handlerStarted = deferred();
    const releaseHandler = deferred();
    let passFinished = false;

    ctx.handlers.register("FolderMetaSyncRequested", async () => {
      handlerStarted.resolve();
      await releaseHandler.promise;

      return ok([]);
    });

    const consumerTask = startConsumer(ctx, controller.signal);
    const passId = ctx.lifecycle.startPass();

    // #when
    ctx.lifecycle.enqueue(
      ctx.queue,
      { _tag: "FolderMetaSyncRequested", path: "/tmp/book" },
      passId,
    );
    const passTask = ctx.lifecycle.waitFor(passId).then(() => {
      passFinished = true;
    });
    await handlerStarted.promise;

    // #then
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

    // #when
    await runInitialPass(ctx);

    // #then
    const feedXml = await Bun.file(join(dataPath, "Author", "Book One", "feed.xml")).text();
    const opmlXml = await Bun.file(join(dataPath, "feed.opml")).text();
    expect(feedXml).toContain("<title>01-intro</title>");
    expect(opmlWrites).toHaveLength(1);
    expect(opmlXml).toContain("01-intro");
    expect(opmlXml).toContain("/Author/Book%20One/feed.xml");

    controller.abort();
    await consumerTask;
  });
});
