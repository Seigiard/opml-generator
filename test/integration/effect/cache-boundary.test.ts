import { afterEach, expect, test } from "bun:test";
import { mkdir, rename, rm, symlink } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { ApplicationLifecycle } from "../../../src/app-lifecycle.ts";
import { buildContext } from "../../../src/context.ts";
import { registerHandlers } from "../../../src/effect/handlers/index.ts";
import type { EventType } from "../../../src/effect/types.ts";
import { createTempDir } from "../../helpers/fs-helpers.ts";

const seedOpml = '<opml version="2.0"><head><title>Previous</title></head><body/></opml>';

test("a cache alias cannot remove or rewrite sibling metadata", async () => {
  // #given
  const env = await sandbox();
  await Bun.write(join(env.filesPath, "Book/01.mp3"), "source bytes");
  const foreign = join(dirname(env.dataPath), "keep/entry.xml");
  await Bun.write(foreign, "foreign marker");
  await symlink(join(dirname(env.dataPath), "keep"), join(env.dataPath, "Book"));

  // #when
  const successful = await env.app.runInitialSync();
  await env.app.waitForIdle();

  // #then
  expect({
    successful,
    ready: env.app.isPublicationReady(),
    sibling: await text(env.keep),
    foreign: await text(foreign),
    source: await text(join(env.filesPath, "Book/01.mp3")),
    opml: await text(join(env.dataPath, "feed.opml")),
  }).toEqual({
    successful: false,
    ready: false,
    sibling: "sibling bytes",
    foreign: "foreign marker",
    source: "source bytes",
    opml: seedOpml,
  });
});

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function sandbox(shared = false) {
  const root = await createTempDir("cache-boundary");
  const filesPath = join(root, "library/books");
  const dataPath = join(root, shared ? "library/data" : "cache/generated");
  const keep = join(dirname(dataPath), "keep/sentinel");
  await mkdir(filesPath, { recursive: true });
  await mkdir(dataPath, { recursive: true });
  await Bun.write(keep, "sibling bytes");
  await Bun.write(join(dataPath, "feed.opml"), seedOpml);
  const base = await buildContext();

  const ctx = {
    ...base,
    config: { ...base.config, filesPath, dataPath },
    fs: {
      ...base.fs,
      rm: async (path: string, options?: { recursive?: boolean }) => {
        const local = relative(root, resolve(path));

        // The outer test sandbox protects unrelated host paths even under the old faulty cascade.
        if (local === ".." || local.startsWith("../")) throw new Error("Harness sandbox exit");
        await base.fs.rm(path, options);
      },
    },
  };

  registerHandlers(ctx.handlers);
  const app = new ApplicationLifecycle(ctx);
  app.startProcessing();
  cleanups.push(async () => {
    await app.shutdown(1000);
    await rm(root, { recursive: true, force: true });
  });

  return { root, filesPath, dataPath, keep, ctx, app };
}

async function text(path: string) {
  try {
    return await Bun.file(path).text();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "missing";
    throw error;
  }
}

test.each([
  "disappeared after scan",
  "configured symlink",
  "excluded resync root",
  "missing resync root",
])("%s fails without deleting cache, sources, or siblings", async (kind) => {
  // #given
  const env = await sandbox(kind === "configured symlink");
  let source = join(env.filesPath, "01.mp3");
  await Bun.write(source, "source bytes");

  if (kind === "configured symlink") {
    const real = join(env.root, "library/real-books");
    await rename(env.filesPath, real);
    source = join(real, "01.mp3");
    await symlink(real, env.filesPath);
  } else if (kind.endsWith("resync root")) {
    const real = join(env.root, "library/real-books");
    await rename(env.filesPath, real);
    source = join(real, "01.mp3");

    if (kind === "excluded resync root") await Bun.write(env.filesPath, "excluded root");
  } else {
    const info = env.ctx.logger.info;
    const inspect = env.ctx.fs.lstat;
    let planned = false;
    let moved = false;
    env.ctx.logger.info = (tag, message, context) => {
      info(tag, message, context);

      if (message === "Sync plan created") planned = true;
    };

    env.ctx.fs.lstat = async (path) => {
      if (planned && !moved) {
        moved = true;
        const real = join(env.root, "library/real-books");
        await rename(env.filesPath, real);
        source = join(real, "01.mp3");
      }

      return inspect(path);
    };
  }

  // #when
  const successful = kind.endsWith("resync root")
    ? await env.app.runResync()
    : await env.app.runInitialSync();

  await env.app.waitForIdle();

  // #then
  expect({
    successful,
    ready: env.app.isPublicationReady(),
    source: await text(source),
    sibling: await text(env.keep),
    opml: await text(join(env.dataPath, "feed.opml")),
  }).toEqual({
    successful: false,
    ready: false,
    source: "source bytes",
    sibling: "sibling bytes",
    opml: seedOpml,
  });
});

test.each(["metadata", "folder delete", "audio delete", "root marker"])(
  "out-of-cache %s work fails before mutation or parent cascades",
  async (kind) => {
    // #given
    const env = await sandbox();

    const event: EventType =
      kind === "metadata"
        ? { _tag: "FolderMetaSyncRequested", path: dirname(env.dataPath) }
        : kind === "root marker"
          ? { _tag: "FolderEntryXmlChanged", parent: env.dataPath }
          : {
              _tag: kind === "folder delete" ? "FolderDeleted" : "AudioFileDeleted",
              parent: dirname(env.filesPath),
              name: "keep",
            };

    env.ctx.handlers.register("FolderCreated", async () =>
      (await import("neverthrow")).ok([event]),
    );

    // #when
    const successful = await env.app.runInitialSync();
    await env.app.waitForIdle();

    // #then
    expect({
      successful,
      ready: env.app.isPublicationReady(),
      sibling: await text(env.keep),
      opml: await text(join(env.dataPath, "feed.opml")),
    }).toEqual({
      successful: false,
      ready: false,
      sibling: "sibling bytes",
      opml: seedOpml,
    });
  },
);
