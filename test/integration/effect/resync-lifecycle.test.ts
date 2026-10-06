import { afterEach, expect, test } from "bun:test";
import { mkdir, rm, utimes } from "node:fs/promises";
import { join } from "node:path";
import { XMLParser } from "fast-xml-parser";
import { ApplicationLifecycle } from "../../../src/app-lifecycle.ts";
import { buildContext } from "../../../src/context.ts";
import { startConsumer } from "../../../src/effect/consumer.ts";
import { registerHandlers } from "../../../src/effect/handlers/index.ts";
import { createHttpHandler } from "../../../src/http.ts";
import { createTempDir } from "../../helpers/fs-helpers.ts";

function gate() {
  let open!: () => void;

  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });

  return { promise, open };
}

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function setup() {
  const root = await createTempDir("resync-lifecycle");
  const filesPath = join(root, "books");
  const dataPath = join(root, "data");
  await mkdir(filesPath);
  await mkdir(dataPath);
  const base = await buildContext();
  const ctx = { ...base, config: { ...base.config, filesPath, dataPath } };
  registerHandlers(ctx.handlers);
  const app = new ApplicationLifecycle(ctx);
  app.markAdmissionReady();
  const controller = new AbortController();
  const consumer = startConsumer(ctx, controller.signal);
  cleanup.push(async () => {
    controller.abort();
    await consumer;
    await rm(root, { recursive: true });
  });
  const fixture = await Bun.file("test/fixtures/audio/untagged.mp3").arrayBuffer();
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: createHttpHandler(ctx, app) });
  cleanup.push(async () => {
    await server.stop(true);
  });

  const request = (path: string, body?: { parent: string; name: string; events: string }) =>
    fetch(new URL(path, server.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  async function audio(name = "01-intro.mp3", book = "Book") {
    const folder = join(filesPath, "Author", book);
    await mkdir(folder, { recursive: true });
    await Bun.write(join(folder, name), fixture);
  }

  return { ctx, app, audio, filesPath, dataPath, request };
}

async function publication(dataPath: string) {
  const parser = new XMLParser({ ignoreAttributes: false });

  const channel = parser.parse(await Bun.file(join(dataPath, "Author/Book/feed.xml")).text()).rss
    .channel;

  const items = Array.isArray(channel.item) ? channel.item : [channel.item];
  const body = parser.parse(await Bun.file(join(dataPath, "feed.opml")).text()).opml.body;
  const outlines = Array.isArray(body.outline) ? body.outline : [body.outline];

  return {
    title: channel.title,
    author: channel["itunes:author"],
    episodes: items.map(
      (item: { title: string; guid: { "#text": string }; "itunes:episode": number }) => ({
        title: item.title,
        guid: item.guid["#text"],
        number: item["itunes:episode"],
      }),
    ),
    outlines: outlines.map(
      (outline: { "@_title": string; "@_author": string; "@_xmlUrl": string }) => ({
        title: outline["@_title"],
        author: outline["@_author"],
        url: outline["@_xmlUrl"],
      }),
    ),
  };
}

test("resync waits for an active cache writer even with an empty pending queue", async () => {
  // #given
  const { ctx, app, audio, dataPath, request } = await setup();
  await audio();
  const held = gate();
  const release = gate();
  cleanup.push(async () => {
    release.open();
  });
  const write = ctx.fs.atomicWrite;
  let activeWrite = false;
  const overlaps: string[] = [];
  ctx.fs.atomicWrite = async (path, content) => {
    if (path.endsWith("/entry.xml")) {
      activeWrite = true;
      held.open();
      await release.promise;
    }

    await write(path, content);
    activeWrite = false;
  };

  let resets = 0;
  let resetStarts = 0;
  const makeDirectory = ctx.fs.mkdir;
  ctx.fs.mkdir = async (path, options) => {
    if (path === dataPath) {
      resetStarts++;

      if (activeWrite) overlaps.push("reset started before active write finished");
    }

    await makeDirectory(path, options);
  };

  const remove = ctx.fs.rm;
  ctx.fs.rm = async (path, options) => {
    if (activeWrite) overlaps.push(path);
    resets++;
    await remove(path, options);
  };

  app.admitBooksEvent({
    parent: join(ctx.config.filesPath, "Author/Book"),
    name: "01-intro.mp3",
    events: "CLOSE_WRITE",
  });
  await held.promise;

  // #when
  const accepted = await request("/resync");
  const task = app.getActivePass();
  const conflict = await request("/resync");
  const during = { pending: ctx.queue.size, resets, resetStarts, busy: app.isSyncing() };
  release.open();
  const successful = await task;
  await app.waitForIdle();

  // #then
  const rss = new XMLParser().parse(await Bun.file(join(dataPath, "Author/Book/feed.xml")).text());
  expect({
    statuses: [accepted.status, conflict.status],
    during,
    successful,
    title: rss.rss.channel.item.title,
    overlaps,
  }).toEqual({
    statuses: [202, 409],
    during: { pending: 0, resets: 0, resetStarts: 0, busy: true },
    successful: true,
    title: "01-intro",
    overlaps: [],
  });
});

test.each([
  ["InitialSync", "pre-scan"],
  ["Reconciliation", "pre-scan"],
  ["Resync", "pre-scan"],
  ["InitialSync", "RSS"],
  ["Reconciliation", "RSS"],
  ["Resync", "RSS"],
])("HTTP rejects resync during %s at the held %s operation", async (kind, phase) => {
  // #given
  const { ctx, app, audio, dataPath, request } = await setup();
  await audio();
  const held = gate();
  const release = gate();
  cleanup.push(async () => {
    release.open();
  });
  const makeDirectory = ctx.fs.mkdir;
  const write = ctx.fs.atomicWrite;
  let opmlWrites = 0;
  ctx.fs.mkdir = async (path, options) => {
    if (phase === "pre-scan" && path === dataPath) {
      held.open();
      await release.promise;
    }

    await makeDirectory(path, options);
  };

  ctx.fs.atomicWrite = async (path, content) => {
    if (phase === "RSS" && path === join(dataPath, "Author/Book/feed.xml")) {
      held.open();
      await release.promise;
    }

    if (path.endsWith("/feed.opml")) opmlWrites++;
    await write(path, content);
  };

  // #when
  const pass =
    kind === "Resync"
      ? app.runResync()
      : kind === "InitialSync"
        ? app.runInitialSync()
        : app.runPublicationPass(kind!);

  await held.promise;
  const response = await request("/resync");
  const message = await response.text();
  const readyWhileHeld = app.isPublicationReady();
  release.open();
  const successful = await pass;
  await app.waitForIdle();

  // #then
  expect({
    status: response.status,
    message,
    readyWhileHeld,
    successful,
    opmlWrites,
    active: app.getActivePass(),
    publication: await publication(dataPath),
  }).toEqual({
    status: 409,
    message: "Sync already in progress",
    readyWhileHeld: false,
    successful: true,
    opmlWrites: 1,
    active: undefined,
    publication: {
      title: "01-intro",
      author: "Author",
      episodes: [{ title: "01-intro", guid: "Author/Book/01-intro.mp3", number: 1 }],
      outlines: [
        { title: "01-intro", author: "Author", url: "{{{BASE_URL}}}/Author/Book/feed.xml" },
      ],
    },
  });
});

test("held reset admits HTTP notifications, excludes cache writes, and publishes current replacements", async () => {
  // #given
  const { ctx, app, audio, filesPath, dataPath, request } = await setup();
  await audio();
  expect(await app.runInitialSync()).toBe(true);
  const held = gate();
  const release = gate();
  cleanup.push(async () => {
    release.open();
  });
  const remove = ctx.fs.rm;
  const write = ctx.fs.atomicWrite;
  let resetting = false;
  const overlaps: string[] = [];
  ctx.fs.rm = async (path, options) => {
    resetting = true;
    held.open();
    await release.promise;
    await remove(path, options);
    resetting = false;
  };

  ctx.fs.atomicWrite = async (path, content) => {
    if (resetting) overlaps.push(path);
    await write(path, content);
  };

  // #when
  const accepted = await request("/resync");
  const pass = app.getActivePass();
  await held.promise;
  const conflict = await request("/resync");
  const sourceFolder = join(filesPath, "Author/Book");
  await rm(join(sourceFolder, "01-intro.mp3"));
  await audio("02-end.mp3");
  await audio("01-intro.mp3");

  const deleted = await request("/events/books", {
    parent: sourceFolder,
    name: "01-intro.mp3",
    events: "DELETE",
  });

  const added = await request("/events/books", {
    parent: sourceFolder,
    name: "02-end.mp3",
    events: "CLOSE_WRITE",
  });

  const readyDuringReset = app.isPublicationReady();
  release.open();
  const successful = await pass;
  await app.waitForIdle();

  // #then
  expect({
    statuses: [accepted.status, conflict.status, deleted.status, added.status],
    successful,
    readyDuringReset,
    ready: app.isPublicationReady(),
    overlaps,
    publication: await publication(dataPath),
  }).toEqual({
    statuses: [202, 409, 202, 202],
    successful: true,
    readyDuringReset: false,
    ready: true,
    overlaps: [],
    publication: {
      title: "Book",
      author: "Author",
      episodes: [
        { title: "01-intro", guid: "Author/Book/01-intro.mp3", number: 1 },
        { title: "02-end", guid: "Author/Book/02-end.mp3", number: 2 },
      ],
      outlines: [{ title: "Book", author: "Author", url: "{{{BASE_URL}}}/Author/Book/feed.xml" }],
    },
  });
});

test("resync rereads source metadata instead of retaining a fresh valid cache entry", async () => {
  // #given
  const { ctx, app, audio, dataPath } = await setup();
  await audio();
  expect(await app.runInitialSync()).toBe(true);
  const entry = join(dataPath, "Author/Book/01-intro.mp3/entry.xml");
  await Bun.write(
    entry,
    (await Bun.file(entry).text()).replace(
      "<title>01-intro</title>",
      "<title>Cached title</title>",
    ),
  );
  await utimes(entry, new Date("2030-01-01"), new Date("2030-01-01"));
  expect(await app.runPublicationPass("Reconciliation")).toBe(true);
  const before = (await publication(dataPath)).episodes;
  const write = ctx.fs.atomicWrite;
  let episodeWrites = 0;
  let opmlWrites = 0;
  ctx.fs.atomicWrite = async (path, content) => {
    if (path.endsWith("/entry.xml")) episodeWrites++;

    if (path.endsWith("/feed.opml")) opmlWrites++;
    await write(path, content);
  };

  // #when
  const successful = await app.runResync();

  // #then
  expect({
    before,
    successful,
    episodeWrites,
    opmlWrites,
    publication: await publication(dataPath),
  }).toEqual({
    before: [{ title: "Cached title", guid: "Author/Book/01-intro.mp3", number: 1 }],
    successful: true,
    episodeWrites: 1,
    opmlWrites: 1,
    publication: {
      title: "01-intro",
      author: "Author",
      episodes: [{ title: "01-intro", guid: "Author/Book/01-intro.mp3", number: 1 }],
      outlines: [
        { title: "01-intro", author: "Author", url: "{{{BASE_URL}}}/Author/Book/feed.xml" },
      ],
    },
  });
});

test("held rebuild admits source changes and repairs a scanned episode removed during RSS publication", async () => {
  // #given
  const { ctx, app, audio, dataPath, filesPath, request } = await setup();
  await audio();
  const held = gate();
  const release = gate();
  cleanup.push(async () => {
    release.open();
  });
  const write = ctx.fs.atomicWrite;
  let firstRss = true;
  ctx.fs.atomicWrite = async (path, content) => {
    if (firstRss && path === join(dataPath, "Author/Book/feed.xml")) {
      firstRss = false;
      held.open();
      await release.promise;
    }

    await write(path, content);
  };

  // #when
  const accepted = await request("/resync");
  const pass = app.getActivePass();
  await held.promise;
  const conflict = await request("/resync");
  await rm(join(filesPath, "Author/Book/01-intro.mp3"));
  await audio("02-end.mp3");

  const deleted = await request("/events/books", {
    parent: join(filesPath, "Author/Book"),
    name: "01-intro.mp3",
    events: "DELETE",
  });

  const added = await request("/events/books", {
    parent: join(filesPath, "Author/Book"),
    name: "02-end.mp3",
    events: "CLOSE_WRITE",
  });

  const readiness = app.isPublicationReady();
  release.open();
  const successful = await pass;
  await app.waitForIdle();

  // #then
  expect({
    statuses: [accepted.status, conflict.status, deleted.status, added.status],
    successful,
    readiness,
    publication: await publication(dataPath),
  }).toEqual({
    statuses: [202, 409, 202, 202],
    successful: true,
    readiness: false,
    publication: {
      title: "02-end",
      author: "Author",
      episodes: [{ title: "02-end", guid: "Author/Book/02-end.mp3", number: 1 }],
      outlines: [{ title: "02-end", author: "Author", url: "{{{BASE_URL}}}/Author/Book/feed.xml" }],
    },
  });
});

test("resync finishes after its final OPML while later real watcher publication is still active", async () => {
  // #given
  const { ctx, app, audio, dataPath, filesPath, request } = await setup();
  await audio();
  const finalHeld = gate();
  const finalRelease = gate();
  const rssHeld = gate();
  const rssRelease = gate();
  const laterHeld = gate();
  const laterRelease = gate();
  cleanup.push(async () => {
    finalRelease.open();
    rssRelease.open();
    laterRelease.open();
  });
  const write = ctx.fs.atomicWrite;
  let opmlWrites = 0;
  let laterActive = false;
  ctx.fs.atomicWrite = async (path, content) => {
    if (path === join(dataPath, "feed.xml")) {
      rssHeld.open();
      await rssRelease.promise;
    }

    if (path.endsWith("/feed.opml")) {
      opmlWrites++;

      if (opmlWrites === 1) {
        finalHeld.open();
        await finalRelease.promise;
      }
    }

    if (path === join(dataPath, "Author/Later/03-later.mp3/entry.xml")) {
      laterActive = true;
      laterHeld.open();
      await laterRelease.promise;
      laterActive = false;
    }

    await write(path, content);
  };

  // #when
  const pass = app.runResync();
  await rssHeld.promise;
  await audio("03-later.mp3", "Later");

  const accepted = await request("/events/books", {
    parent: join(filesPath, "Author/Later"),
    name: "03-later.mp3",
    events: "CLOSE_WRITE",
  });

  rssRelease.open();
  await laterHeld.promise;
  await finalHeld.promise;
  const readyBeforeFinal = app.isPublicationReady();
  finalRelease.open();
  const successful = await pass;

  const atCompletion = {
    laterActive,
    opmlWrites,
    ready: app.isPublicationReady(),
    busy: app.isSyncing(),
  };

  const covered = await publication(dataPath);
  laterRelease.open();
  await app.waitForIdle();

  // #then
  const parser = new XMLParser({ ignoreAttributes: false });

  const outlines = parser.parse(await Bun.file(join(dataPath, "feed.opml")).text()).opml.body
    .outline;

  expect({
    accepted: accepted.status,
    successful,
    readyBeforeFinal,
    atCompletion,
    covered,
    titles: outlines.map((outline: { "@_title": string }) => outline["@_title"]),
  }).toEqual({
    accepted: 202,
    successful: true,
    readyBeforeFinal: false,
    atCompletion: { laterActive: true, opmlWrites: 1, ready: true, busy: false },
    covered: {
      title: "01-intro",
      author: "Author",
      episodes: [{ title: "01-intro", guid: "Author/Book/01-intro.mp3", number: 1 }],
      outlines: [
        { title: "01-intro", author: "Author", url: "{{{BASE_URL}}}/Author/Book/feed.xml" },
      ],
    },
    titles: ["01-intro", "03-later"],
  });
});

test.each(["InitialSync", "Reconciliation", "Resync"])(
  "HTTP rejects resync during %s through final OPML without deferring another pass",
  async (kind) => {
    // #given
    const { ctx, app, audio, dataPath, request } = await setup();
    await audio();
    const held = gate();
    const release = gate();
    cleanup.push(async () => {
      release.open();
    });
    const write = ctx.fs.atomicWrite;
    let opmlWrites = 0;
    ctx.fs.atomicWrite = async (path, content) => {
      if (path.endsWith("/feed.opml")) {
        opmlWrites++;
        held.open();
        await release.promise;
      }

      await write(path, content);
    };

    // #when
    const pass =
      kind === "Resync"
        ? app.runResync()
        : kind === "InitialSync"
          ? app.runInitialSync()
          : app.runPublicationPass(kind);

    await held.promise;
    const response = await request("/resync");
    const text = await response.text();
    release.open();
    const successful = await pass;
    await app.waitForIdle();

    // #then
    expect({
      status: response.status,
      text,
      successful,
      opmlWrites,
      active: app.getActivePass(),
      publication: await publication(dataPath),
    }).toEqual({
      status: 409,
      text: "Sync already in progress",
      successful: true,
      opmlWrites: 1,
      active: undefined,
      publication: {
        title: "01-intro",
        author: "Author",
        episodes: [{ title: "01-intro", guid: "Author/Book/01-intro.mp3", number: 1 }],
        outlines: [
          { title: "01-intro", author: "Author", url: "{{{BASE_URL}}}/Author/Book/feed.xml" },
        ],
      },
    });
  },
);

test.each(["cleanup", "episode", "RSS", "OPML"])(
  "failed resync %s releases ownership and HTTP manual recovery restores publication",
  async (phase) => {
    // #given
    const { ctx, app, audio, dataPath, filesPath, request } = await setup();
    await audio();
    await audio("02-independent.mp3", "Other");
    await mkdir(join(dataPath, "obsolete"));
    const write = ctx.fs.atomicWrite;
    const remove = ctx.fs.rm;
    let fail = true;
    const faultHeld = gate();
    const faultRelease = gate();
    cleanup.push(async () => {
      faultRelease.open();
    });
    ctx.fs.rm = async (path, options) => {
      if (fail && phase === "cleanup") {
        faultHeld.open();
        await faultRelease.promise;
        throw new Error("controlled reset failure");
      }

      await remove(path, options);
    };

    ctx.fs.atomicWrite = async (path, content) => {
      if (
        fail &&
        ((phase === "episode" && path === join(dataPath, "Author/Book/01-intro.mp3/entry.xml")) ||
          (phase === "RSS" && path === join(dataPath, "Author/Book/feed.xml")) ||
          (phase === "OPML" && path.endsWith("/feed.opml")))
      ) {
        faultHeld.open();
        await faultRelease.promise;
        throw new Error("controlled mandatory write failure");
      }

      await write(path, content);
    };

    // #when
    const firstResponse = await request("/resync");
    await faultHeld.promise;
    const failedPass = app.getActivePass();
    faultRelease.open();
    const failed = await failedPass;
    const readyAfterFailure = app.isPublicationReady();

    const independentBeforeRepair = await Bun.file(
      join(dataPath, "Author/Other/feed.xml"),
    ).exists();

    fail = false;

    const admitted = await request("/events/books", {
      parent: join(filesPath, "Author/Other"),
      name: "02-independent.mp3",
      events: "CLOSE_WRITE",
    });

    await app.waitForIdle();

    const independent = new XMLParser().parse(
      await Bun.file(join(dataPath, "Author/Other/feed.xml")).text(),
    ).rss.channel.item.title;

    const recoveryResponse = await request("/resync");
    const recovered = await app.getActivePass();
    const parser = new XMLParser({ ignoreAttributes: false });

    const channel = parser.parse(await Bun.file(join(dataPath, "Author/Book/feed.xml")).text()).rss
      .channel;

    const outlines = parser.parse(await Bun.file(join(dataPath, "feed.opml")).text()).opml.body
      .outline;

    // #then
    expect({
      statuses: [firstResponse.status, admitted.status, recoveryResponse.status],
      failed,
      readyAfterFailure,
      independent,
      independentBeforeRepair,
      recovered,
      ready: app.isPublicationReady(),
      title: channel.item.title,
      titles: outlines.map((outline: { "@_title": string }) => outline["@_title"]),
    }).toEqual({
      statuses: [202, 202, 202],
      failed: false,
      readyAfterFailure: false,
      independent: "02-independent",
      independentBeforeRepair: phase !== "cleanup",
      recovered: true,
      ready: true,
      title: "01-intro",
      titles: ["01-intro", "02-independent"],
    });
  },
);

test("failed initial publication remains unready and accepts manual HTTP recovery", async () => {
  // #given
  const { ctx, app, audio, dataPath, request } = await setup();
  await audio();
  const write = ctx.fs.atomicWrite;
  let fail = true;
  const held = gate();
  const release = gate();
  cleanup.push(async () => {
    release.open();
  });
  ctx.fs.atomicWrite = async (path, content) => {
    if (path.endsWith("/feed.opml")) {
      if (fail) throw new Error("controlled initial publication failure");
      held.open();
      await release.promise;
    }

    await write(path, content);
  };

  // #when
  const initial = await app.runInitialSync();
  const initialReady = app.isPublicationReady();
  fail = false;
  const response = await request("/resync");
  const pass = app.getActivePass();
  await held.promise;
  const beforeFinal = app.isPublicationReady();
  release.open();
  const recovered = await pass;

  // #then
  expect({
    initial,
    initialReady,
    accepted: response.status,
    beforeFinal,
    recovered,
    ready: app.isPublicationReady(),
    publication: await publication(dataPath),
  }).toEqual({
    initial: false,
    initialReady: false,
    accepted: 202,
    beforeFinal: false,
    recovered: true,
    ready: true,
    publication: {
      title: "01-intro",
      author: "Author",
      episodes: [{ title: "01-intro", guid: "Author/Book/01-intro.mp3", number: 1 }],
      outlines: [
        { title: "01-intro", author: "Author", url: "{{{BASE_URL}}}/Author/Book/feed.xml" },
      ],
    },
  });
});
