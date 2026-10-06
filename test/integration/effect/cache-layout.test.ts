import { afterEach, expect, test } from "bun:test";
import { mkdir, rename, rm } from "node:fs/promises";
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

test("punctuation-only and whitespace folder names publish usable podcast titles", async () => {
  // #given
  const env = await setup();

  for (const folder of ["---", "   ", "my-awesome-book"]) {
    for (const name of ["01.mp3", "02.mp3"])
      await Bun.write(
        join(env.filesPath, folder, name),
        Bun.file("test/fixtures/audio/tagged.mp3"),
      );
  }

  // #when
  const successful = await env.app.runInitialSync();
  const text = z.object({ "@_text": z.string() });

  const titles = z
    .object({ opml: z.object({ body: z.object({ outline: z.array(text) }) }) })
    .parse(parser.parse(await Bun.file(join(env.dataPath, "feed.opml")).text()))
    .opml.body.outline.map((item) => item["@_text"])
    .sort();

  // #then
  expect({ successful, titles }).toEqual({
    successful: true,
    titles: ["---", "My awesome book", "Untitled"],
  });
});

test("normal reconciliation after a reserved-name pass keeps readiness and watcher delivery", async () => {
  // #given
  const env = await setup();
  const tagged = Bun.file("test/fixtures/audio/tagged.mp3");
  await Bun.write(join(env.filesPath, "Author/feed.xml/01.mp3"), tagged);
  expect(await env.app.runInitialSync()).toBe(true);
  const opml = join(env.dataPath, "feed.opml");
  const feed = join(env.dataPath, "Author/~/feed.xml/feed.xml");
  const write = env.ctx.fs.atomicWrite;
  let armed = true;
  let entered!: () => void;
  let release!: () => void;
  let published!: () => void;

  const held = new Promise<void>((resolve) => {
    entered = resolve;
  });

  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const delivered = new Promise<void>((resolve) => {
    published = resolve;
  });

  env.ctx.fs.atomicWrite = async (path, content) => {
    if (path === opml && armed) {
      armed = false;
      entered();
      await gate;
    }

    await write(path, content);

    if (path === feed && content.includes("Author/feed.xml/02.mp3")) published();
  };

  // #when
  const reconciliation = env.app.runPublicationPass("Reconciliation");
  await held;
  const ready = env.app.isPublicationReady();
  await Bun.write(join(env.filesPath, "Author/feed.xml/02.mp3"), tagged);

  env.app.admitBooksEvent({
    parent: join(env.filesPath, "Author/feed.xml/"),
    name: "02.mp3",
    events: "CLOSE_WRITE",
  });

  await delivered;
  release();
  const successful = await reconciliation;

  // #then
  expect({ ready, successful }).toEqual({ ready: true, successful: true });
});

test("a legacy source branch at the journal name upgrades and reuses its metadata on restart", async () => {
  // #given
  const env = await setup();
  const source = "~/.upgrade/manifest.json/track.mp3";
  await Bun.write(join(env.filesPath, source), Bun.file("test/fixtures/audio/tagged.mp3"));
  await Bun.write(join(env.filesPath, "Plain/01.mp3"), Bun.file("test/fixtures/audio/tagged.mp3"));
  expect(await env.app.runInitialSync()).toBe(true);
  const canonical = join(env.dataPath, "~/~/.upgrade/manifest.json/track.mp3/entry.xml");
  const original = await Bun.file(canonical).text();
  await rm(join(env.dataPath, "~"), { recursive: true });
  await Bun.write(join(env.dataPath, source, "entry.xml"), original);
  const audio = env.ctx.handlers.get("AudioFileCreated")!;
  let rebuilds = 0;
  env.ctx.handlers.register("AudioFileCreated", async (event, deps) => {
    rebuilds++;

    return audio(event, deps);
  });

  // #when
  const upgraded = await env.app.runPublicationPass("Reconciliation");
  const restarted = await env.app.runPublicationPass("Reconciliation");

  const document = opmlSchema.parse(
    parser.parse(await Bun.file(join(env.dataPath, "feed.opml")).text()),
  );

  // #then
  expect({
    upgraded,
    restarted,
    rebuilds,
    unchanged: original === (await Bun.file(canonical).text()),
    paths: document.opml.body.outline.map((item) => item["@_xmlUrl"]).sort(),
  }).toEqual({
    upgraded: true,
    restarted: true,
    rebuilds: 0,
    unchanged: true,
    paths: [
      "{{{BASE_URL}}}/Plain/feed.xml",
      "{{{BASE_URL}}}/~/.upgrade/manifest.json/feed.xml",
    ].sort(),
  });
});

test("repeated interrupted upgrades keep every staged legacy entry reusable", async () => {
  // #given
  const env = await setup();
  const books = ["A", "B", "C"];

  for (const book of books)
    await Bun.write(
      join(env.filesPath, book, "feed.xml/01.mp3"),
      Bun.file("test/fixtures/audio/tagged.mp3"),
    );
  expect(await env.app.runInitialSync()).toBe(true);
  const originals: string[] = [];

  for (const book of books) {
    const canonical = join(env.dataPath, book, "~/feed.xml/01.mp3/entry.xml");
    originals.push(await Bun.file(canonical).text());
    await rm(join(env.dataPath, book), { recursive: true });
    await Bun.write(join(env.dataPath, book, "feed.xml/01.mp3/entry.xml"), originals.at(-1)!);
  }

  const second = join(env.dataPath, "B/~/feed.xml/01.mp3/entry.xml");
  const write = env.ctx.fs.atomicWrite;
  const audio = env.ctx.handlers.get("AudioFileCreated")!;
  let interruption: "copy" | "manifest" | undefined = "copy";
  let rebuilds = 0;
  env.ctx.fs.atomicWrite = async (path, content) => {
    if (interruption === "copy" && path === second) {
      interruption = "manifest";
      throw new Error("Interrupted canonical entry copy");
    }

    if (interruption === "manifest" && path.endsWith("/manifest.json")) {
      interruption = undefined;
      throw new Error("Interrupted journal replacement");
    }

    await write(path, content);
  };

  env.ctx.handlers.register("AudioFileCreated", async (event, deps) => {
    rebuilds++;

    return audio(event, deps);
  });

  // #when
  const first = await env.app.runPublicationPass("Reconciliation");
  const retried = await env.app.runPublicationPass("Reconciliation");
  const recovered = await env.app.runPublicationPass("Reconciliation");
  const actual: string[] = [];

  for (const book of books)
    actual.push(await Bun.file(join(env.dataPath, book, "~/feed.xml/01.mp3/entry.xml")).text());

  // #then
  expect({
    first,
    retried,
    recovered,
    rebuilds,
    unchanged: JSON.stringify(actual) === JSON.stringify(originals),
  }).toEqual({ first: false, retried: false, recovered: true, rebuilds: 0, unchanged: true });
});

test("cache entries removed during upgrade detection do not fail the pass", async () => {
  // #given
  const env = await setup();

  for (const book of ["Book", "Other"])
    await Bun.write(
      join(env.filesPath, book, "01.mp3"),
      Bun.file("test/fixtures/audio/tagged.mp3"),
    );
  expect(await env.app.runInitialSync()).toBe(true);
  const book = join(env.dataPath, "Book");
  const gone = join(env.dataPath, "Gone");
  const feed = join(book, "feed.xml");
  await Bun.write(`${feed}.tmp`, await Bun.file(feed).text());
  await Bun.write(join(gone, "01.mp3/entry.xml"), "<episode/>");
  const readdir = env.ctx.fs.readdir;
  const lstat = env.ctx.fs.lstat;
  let renamePending = true;
  let removePending = true;

  env.ctx.fs.readdir = async (path) => {
    const names = await readdir(path);

    if (path === book && renamePending) {
      renamePending = false;
      await rename(`${feed}.tmp`, feed);
    }

    return names;
  };

  env.ctx.fs.lstat = async (path) => {
    const info = await lstat(path);

    if (path === gone && removePending) {
      removePending = false;
      await rm(gone, { recursive: true });
    }

    return info;
  };

  // #when
  const successful = await env.app.runPublicationPass("Reconciliation");

  const title = z
    .object({ rss: z.object({ channel: z.object({ title: z.string() }) }) })
    .parse(parser.parse(await Bun.file(feed).text())).rss.channel.title;

  const document = opmlSchema.parse(
    parser.parse(await Bun.file(join(env.dataPath, "feed.opml")).text()),
  );

  // #then
  expect({
    successful,
    ready: env.app.isPublicationReady(),
    raced: !renamePending && !removePending,
    title,
    paths: document.opml.body.outline.map((item) => item["@_xmlUrl"]).sort(),
  }).toEqual({
    successful: true,
    ready: true,
    raced: true,
    title: "Test Title",
    paths: ["{{{BASE_URL}}}/Book/feed.xml", "{{{BASE_URL}}}/Other/feed.xml"],
  });
});
