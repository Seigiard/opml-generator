import { afterEach, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { XMLParser } from "fast-xml-parser";
import { z } from "zod";
import { ApplicationLifecycle } from "../../../src/app-lifecycle.ts";
import { buildContext } from "../../../src/context.ts";
import { registerHandlers } from "../../../src/effect/handlers/index.ts";
import { createTempDir } from "../../helpers/fs-helpers.ts";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

const parser = new XMLParser({ ignoreAttributes: false });

const outline = z.object({ "@_xmlUrl": z.string() });

const opmlSchema = z.object({ opml: z.object({ body: z.object({ outline: z.array(outline) }) }) });

async function setup() {
  const root = await createTempDir("cache-layout");
  const filesPath = join(root, "books");
  const dataPath = join(root, "data");
  await mkdir(filesPath);
  await mkdir(dataPath);
  const base = await buildContext();
  const ctx = { ...base, config: { ...base.config, filesPath, dataPath } };
  registerHandlers(ctx.handlers);
  const app = new ApplicationLifecycle(ctx);
  app.startProcessing();
  cleanup.push(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });

  return { root, filesPath, dataPath, ctx, app };
}

test("unrestricted source names preserve all public subscriptions with root and parent episodes", async () => {
  // #given
  const env = await setup();
  const tagged = await Bun.file("test/fixtures/audio/tagged.mp3").arrayBuffer();

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
    await Bun.write(join(env.filesPath, path, "01.mp3"), tagged);
  }

  await Bun.write(
    join(env.filesPath, "Parent/direct.mp3"),
    Bun.file("test/fixtures/audio/untagged.mp3"),
  );
  await Bun.write(join(env.filesPath, "root.mp3"), Bun.file("test/fixtures/audio/untagged.mp3"));

  // #when
  const successful = await env.app.runInitialSync();

  const document = opmlSchema.parse(
    parser.parse(await Bun.file(join(env.dataPath, "feed.opml")).text()),
  );

  // #then
  expect({
    successful,
    ready: env.app.isPublicationReady(),
    paths: document.opml.body.outline.map((item) => item["@_xmlUrl"]).sort(),
  }).toEqual({
    successful: true,
    ready: true,
    paths: [
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
  });
});

test("mixed legacy projection reuses valid episode bytes before namespace cleanup and on restart", async () => {
  // #given
  const env = await setup();
  const paths = ["feed.xml/01.mp3", "~/01.mp3", "~feed.xml/01.mp3"];

  for (const path of paths)
    await Bun.write(join(env.filesPath, path), Bun.file("test/fixtures/audio/tagged.mp3"));
  expect(await env.app.runInitialSync()).toBe(true);
  const originals: string[] = [];

  for (const path of [
    "~/feed.xml/01.mp3/entry.xml",
    "~/~/01.mp3/entry.xml",
    "~feed.xml/01.mp3/entry.xml",
  ])
    originals.push(await Bun.file(join(env.dataPath, path)).text());
  await rm(join(env.dataPath, "~"), { recursive: true });
  await rm(join(env.dataPath, "feed.xml"));
  await Bun.write(join(env.dataPath, "feed.xml/01.mp3/entry.xml"), originals[0]!);
  await Bun.write(join(env.dataPath, "~/01.mp3/entry.xml"), originals[1]!);
  const audio = env.ctx.handlers.get("AudioFileCreated")!;
  let rebuilds = 0;
  env.ctx.handlers.register("AudioFileCreated", async (event, deps) => {
    rebuilds++;

    return audio(event, deps);
  });

  // #when
  const upgraded = await env.app.runPublicationPass("Reconciliation");
  const restarted = await env.app.runPublicationPass("Reconciliation");
  const actual: string[] = [];

  for (const path of [
    "~/feed.xml/01.mp3/entry.xml",
    "~/~/01.mp3/entry.xml",
    "~feed.xml/01.mp3/entry.xml",
  ])
    actual.push(await Bun.file(join(env.dataPath, path)).text());

  const document = opmlSchema.parse(
    parser.parse(await Bun.file(join(env.dataPath, "feed.opml")).text()),
  );

  // #then
  expect({
    upgraded,
    restarted,
    rebuilds,
    unchanged: JSON.stringify(actual) === JSON.stringify(originals),
    paths: document.opml.body.outline.map((item) => item["@_xmlUrl"]).sort(),
  }).toEqual({
    upgraded: true,
    restarted: true,
    rebuilds: 0,
    unchanged: true,
    paths: [
      "{{{BASE_URL}}}/feed.xml/feed.xml",
      "{{{BASE_URL}}}/~/feed.xml",
      "{{{BASE_URL}}}/~feed.xml/feed.xml",
    ].sort(),
  });
});

test("upgrade keeps an accepted replacement queued until its legacy snapshot is published", async () => {
  // #given
  const env = await setup();
  await Bun.write(
    join(env.filesPath, "feed.xml/01.mp3"),
    Bun.file("test/fixtures/audio/untagged.mp3"),
  );
  expect(await env.app.runInitialSync()).toBe(true);
  const entry = join(env.dataPath, "~/feed.xml/01.mp3/entry.xml");
  const old = await Bun.file(entry).text();
  await rm(join(env.dataPath, "~"), { recursive: true });
  await rm(join(env.dataPath, "feed.xml"));
  await Bun.write(join(env.dataPath, "feed.xml/01.mp3/entry.xml"), old);
  let entered!: () => void;
  let release!: () => void;

  const held = new Promise<void>((resolve) => {
    entered = resolve;
  });

  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const write = env.ctx.fs.atomicWrite;
  const info = env.ctx.logger.info;
  let first = true;
  let replacement = false;
  let starts = 0;
  env.ctx.fs.atomicWrite = async (path, content) => {
    if (path === entry && first) {
      first = false;
      entered();
      await gate;
    }

    await write(path, content);
  };

  env.ctx.logger.info = (tag, message, context) => {
    info(tag, message, context);

    if (
      replacement &&
      context?.event_tag === "SourcePathSyncRequested" &&
      context?.event_type === "handler_start"
    )
      starts++;
  };

  // #when
  const upgrade = env.app.runPublicationPass("Reconciliation");
  await held;
  await Bun.write(
    join(env.filesPath, "feed.xml/01.mp3"),
    Bun.file("test/fixtures/audio/tagged.mp3"),
  );
  replacement = true;
  env.app.admitBooksEvent({
    parent: join(env.filesPath, "feed.xml"),
    name: "01.mp3",
    events: "CLOSE_WRITE",
  });
  await env.ctx.queue.pause();

  try {
    expect(starts).toBe(0);
  } finally {
    release();
  }

  const successful = await upgrade;
  await env.app.waitForIdle();

  const item = z
    .object({
      rss: z.object({
        channel: z.object({
          item: z.object({ title: z.string(), guid: z.object({ "#text": z.string() }) }),
        }),
      }),
    })
    .parse(parser.parse(await Bun.file(join(env.dataPath, "~/feed.xml/feed.xml")).text())).rss
    .channel.item;

  // #then
  expect({ successful, title: item.title, guid: item.guid["#text"] }).toEqual({
    successful: true,
    title: "Test Title",
    guid: "feed.xml/01.mp3",
  });
});

test("interrupted namespace copy recovers its staged legacy metadata without audio reread", async () => {
  // #given
  const env = await setup();
  await Bun.write(
    join(env.filesPath, "feed.xml/01.mp3"),
    Bun.file("test/fixtures/audio/tagged.mp3"),
  );
  expect(await env.app.runInitialSync()).toBe(true);
  const target = join(env.dataPath, "~/feed.xml/01.mp3/entry.xml");
  const original = await Bun.file(target).text();
  await rm(join(env.dataPath, "~"), { recursive: true });
  await rm(join(env.dataPath, "feed.xml"));
  await Bun.write(join(env.dataPath, "feed.xml/01.mp3/entry.xml"), original);
  const write = env.ctx.fs.atomicWrite;
  const audio = env.ctx.handlers.get("AudioFileCreated")!;
  let failed = false;
  let rebuilds = 0;
  env.ctx.fs.atomicWrite = async (path, content) => {
    if (path === target && !failed) {
      failed = true;
      throw new Error("Interrupted canonical entry copy");
    }

    await write(path, content);
  };

  env.ctx.handlers.register("AudioFileCreated", async (event, deps) => {
    rebuilds++;

    return audio(event, deps);
  });

  // #when
  const interrupted = await env.app.runPublicationPass("Reconciliation");
  const recovered = await env.app.runPublicationPass("Reconciliation");

  // #then
  expect({
    interrupted,
    recovered,
    rebuilds,
    unchanged: original === (await Bun.file(target).text()),
    ready: env.app.isPublicationReady(),
  }).toEqual({ interrupted: false, recovered: true, rebuilds: 0, unchanged: true, ready: true });
});
