import { afterEach, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
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
  const root = await createTempDir("shutdown-lifecycle");
  const filesPath = join(root, "books");
  const dataPath = join(root, "data");
  await mkdir(join(filesPath, "Author/Book"), { recursive: true });
  await mkdir(dataPath);
  const fixture = await Bun.file("test/fixtures/audio/untagged.mp3").arrayBuffer();
  await Bun.write(join(filesPath, "Author/Book/01.mp3"), fixture);
  await Bun.write(join(filesPath, "Author/Book/02.mp3"), fixture);
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
  const http = createHttpHandler(ctx, app);

  const request = (path: string) =>
    http(
      new Request(`http://localhost${path}`, {
        method: "POST",
        body: JSON.stringify({ parent: filesPath, name: "Author", events: "CREATE,ISDIR" }),
      }),
    );

  return { ctx, app, consumer, dataPath, filesPath, request };
}

test.each(["InitialSync", "Reconciliation", "Resync"])(
  "stopping owns %s setup and rejects all admission after its await",
  async (kind) => {
    // #given
    const { ctx, app, consumer, dataPath, request } = await setup();
    const entered = gate();
    const release = gate();
    cleanup.push(async () => {
      release.open();
    });
    const make = ctx.fs.mkdir;
    const starts: string[] = [];
    ctx.fs.mkdir = async (path, options) => {
      starts.push("mkdir");
      entered.open();
      await release.promise;
      await make(path, options);
    };

    const read = ctx.fs.readdir;
    ctx.fs.readdir = async (path) => {
      starts.push("readdir");

      return read(path);
    };

    const pass = kind === "Resync" ? app.runResync() : app.runPublicationPass(kind);
    await entered.promise;
    // #when
    const stopping = app.shutdown(1000);
    const owned = app.getActivePass() === pass;

    const statuses = await Promise.all(
      ["/events/books", "/events/data", "/resync"].map(
        async (path) => (await request(path)).status,
      ),
    );

    const rejectedPass = await app.runInitialSync();
    release.open();
    const outcome = await stopping;
    await consumer;
    // #then
    expect({
      owned,
      statuses,
      rejectedPass,
      outcome,
      successful: await pass,
      ready: app.isPublicationReady(),
      starts,
      cache: await read(dataPath),
    }).toEqual({
      owned: true,
      statuses: [503, 503, 503],
      rejectedPass: false,
      outcome: "completed",
      successful: false,
      ready: false,
      starts: ["mkdir"],
      cache: [],
    });
  },
);

test.each(["InitialSync", "Reconciliation", "Resync"])(
  "stopping %s completes the real active RSS write, leaves cascades, and fresh startup repairs unchanged sources",
  async (kind) => {
    // #given
    const { ctx, app, consumer, dataPath, filesPath } = await setup();
    const entered = gate();
    const release = gate();
    cleanup.push(async () => {
      release.open();
    });
    const write = ctx.fs.atomicWrite;
    let held = false;
    const writes: string[] = [];
    ctx.fs.atomicWrite = async (path, content) => {
      writes.push(path.slice(dataPath.length));
      await write(path, content);

      if (!held && path.endsWith("/Author/Book/feed.xml")) {
        held = true;
        entered.open();
        await release.promise;
      }
    };

    const before = Bun.hash(await Bun.file(join(filesPath, "Author/Book/01.mp3")).arrayBuffer());
    const pass = kind === "Resync" ? app.runResync() : app.runPublicationPass(kind);
    await entered.promise;
    // #when
    const stopping = app.shutdown(1000);
    const atStop = [...writes];
    release.open();
    const outcome = await stopping;
    await consumer;
    const leftoverRss = await Bun.file(join(dataPath, "Author/Book/feed.xml")).exists();
    const leftoverOpml = await Bun.file(join(dataPath, "feed.opml")).exists();
    const nextBase = await buildContext();
    const nextCtx = { ...nextBase, config: ctx.config };
    registerHandlers(nextCtx.handlers);
    const next = new ApplicationLifecycle(nextCtx);
    next.markAdmissionReady();
    const nextController = new AbortController();
    const nextConsumer = startConsumer(nextCtx, nextController.signal);
    cleanup.push(async () => {
      nextController.abort();
      await nextConsumer;
    });
    const recovered = await next.runInitialSync();
    const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false });

    const rss = parser.parse(await Bun.file(join(dataPath, "Author/Book/feed.xml")).text()).rss
      .channel;

    const outline = parser.parse(await Bun.file(join(dataPath, "feed.opml")).text()).opml.body
      .outline;

    // #then
    expect({
      outcome,
      stoppedPass: await pass,
      writesAfterStop: writes.slice(atStop.length),
      leftoverRss,
      leftoverOpml,
      recovered,
      ready: next.isPublicationReady(),
      unchanged:
        before === Bun.hash(await Bun.file(join(filesPath, "Author/Book/01.mp3")).arrayBuffer()),
      episodes: rss.item.map(
        (item: { title: string; "itunes:episode": number; guid: { "#text": string } }) => [
          item.title,
          item["itunes:episode"],
          item.guid["#text"],
        ],
      ),
      url: outline["@_xmlUrl"],
    }).toEqual({
      outcome: "completed",
      stoppedPass: false,
      writesAfterStop: ["/Author/Book/_entry.xml"],
      leftoverRss: true,
      leftoverOpml: false,
      recovered: true,
      ready: true,
      unchanged: true,
      episodes: [
        ["01", "1", "Author/Book/01.mp3"],
        ["02", "2", "Author/Book/02.mp3"],
      ],
      url: "{{{BASE_URL}}}/Author/Book/feed.xml",
    });
  },
);

test("deadline terminates the wait but retains a held startup task and forbids work when it resumes", async () => {
  // #given
  const { ctx, app, consumer, dataPath } = await setup();
  const entered = gate();
  const release = gate();
  cleanup.push(async () => {
    release.open();
  });
  const make = ctx.fs.mkdir;
  ctx.fs.mkdir = async (path, options) => {
    entered.open();
    await release.promise;
    await make(path, options);
  };

  const pass = app.runInitialSync();
  await entered.promise;
  // #when
  const started = performance.now();
  const outcome = await app.shutdown(30);
  const bounded = performance.now() - started < 500;
  const retained = app.getActivePass() === pass;
  release.open();
  const result = await pass;
  await consumer;
  // #then
  expect({
    outcome,
    bounded,
    retained,
    result,
    cache: await ctx.fs.readdir(dataPath),
    repeat: await app.shutdown(),
  }).toEqual({
    outcome: "deadline",
    bounded: true,
    retained: true,
    result: false,
    cache: [],
    repeat: "deadline",
  });
});

test("stopping during resync's active-writer wait cannot begin reset or resume delivery", async () => {
  // #given
  const { ctx, app, consumer, filesPath, dataPath } = await setup();
  const entered = gate();
  const release = gate();
  cleanup.push(async () => {
    release.open();
  });
  const write = ctx.fs.atomicWrite;
  let writes = 0;
  ctx.fs.atomicWrite = async (path, content) => {
    writes++;
    entered.open();
    await release.promise;
    await write(path, content);
  };

  let resets = 0;
  const remove = ctx.fs.rm;
  ctx.fs.rm = async (path, options) => {
    resets++;
    await remove(path, options);
  };

  app.admitBooksEvent({
    parent: join(filesPath, "Author/Book"),
    name: "01.mp3",
    events: "CLOSE_WRITE",
  });
  await entered.promise;
  app.admitBooksEvent({
    parent: join(filesPath, "Author/Book"),
    name: "02.mp3",
    events: "CLOSE_WRITE",
  });
  const pass = app.runResync();
  // #when
  const stopping = app.shutdown(1000);
  release.open();
  const outcome = await stopping;
  await consumer;
  // #then
  expect({
    outcome,
    result: await pass,
    resets,
    writes,
    first: await Bun.file(join(dataPath, "Author/Book/01.mp3/entry.xml")).exists(),
    second: await Bun.file(join(dataPath, "Author/Book/02.mp3/entry.xml")).exists(),
  }).toEqual({
    outcome: "completed",
    result: false,
    resets: 0,
    writes: 1,
    first: true,
    second: false,
  });
});

test("resync resumed after removing one real entry cannot remove another entry after stopping", async () => {
  // #given
  const { ctx, app, consumer, dataPath } = await setup();
  await Bun.write(join(dataPath, "stale-a"), "old");
  await Bun.write(join(dataPath, "stale-b"), "old");
  const entered = gate();
  const release = gate();
  cleanup.push(async () => {
    release.open();
  });
  const remove = ctx.fs.rm;
  const removed: string[] = [];
  ctx.fs.rm = async (path, options) => {
    removed.push(path);
    await remove(path, options);
    entered.open();
    await release.promise;
  };

  const pass = app.runResync();
  await entered.promise;
  // #when
  const stopping = app.shutdown(1000);
  release.open();
  const outcome = await stopping;
  await consumer;
  // #then
  expect({
    outcome,
    result: await pass,
    removals: removed.length,
    remaining: (await ctx.fs.readdir(dataPath)).length,
  }).toEqual({ outcome: "completed", result: false, removals: 1, remaining: 1 });
});

test("reconciliation interval awakened after stopping cannot admit a scan", async () => {
  // #given
  const { ctx, app, consumer } = await setup();
  const scheduled = gate();
  const tick = gate();
  const controller = new AbortController();
  let scans = 0;
  const make = ctx.fs.mkdir;
  ctx.fs.mkdir = async (path, options) => {
    scans++;
    await make(path, options);
  };

  const reconciler = app.startReconciliation(controller.signal, async () => {
    scheduled.open();
    await tick.promise;
  });

  await scheduled.promise;
  // #when
  const stopping = app.shutdown(1000);
  tick.open();
  const outcome = await stopping;
  await reconciler;
  await consumer;
  // #then
  expect({ outcome, scans, active: app.getActivePass() }).toEqual({
    outcome: "completed",
    scans: 0,
    active: undefined,
  });
});

test("an active RSS handler resumed after the shutdown deadline cannot start its next metadata write", async () => {
  // #given
  const { ctx, app, consumer, dataPath } = await setup();
  const entered = gate();
  const release = gate();
  cleanup.push(async () => {
    release.open();
  });
  const write = ctx.fs.atomicWrite;
  const writes: string[] = [];
  ctx.fs.atomicWrite = async (path, content) => {
    writes.push(path);
    await write(path, content);

    if (path.endsWith("/Author/Book/feed.xml")) {
      entered.open();
      await release.promise;
    }
  };

  const pass = app.runInitialSync();
  await entered.promise;
  // #when
  const outcome = await app.shutdown(30);
  const before = writes.length;
  release.open();
  await consumer;
  // #then
  expect({
    outcome,
    pass: await pass,
    laterWrites: writes.slice(before),
    opml: await Bun.file(join(dataPath, "feed.opml")).exists(),
  }).toEqual({ outcome: "deadline", pass: false, laterWrites: [], opml: false });
});

test("already delivered source hints cannot start their handler after synchronous stopping", async () => {
  // #given
  const { ctx, app, consumer, filesPath, dataPath } = await setup();
  let starts = 0;
  const info = ctx.logger.info;
  ctx.logger.info = (tag, message, context) => {
    if (context?.event_type === "handler_start") starts++;
    info(tag, message, context);
  };

  // #when
  const admitted = app.admitBooksEvent({
    parent: join(filesPath, "Author/Book"),
    name: "01.mp3",
    events: "CLOSE_WRITE",
  });

  const outcome = await app.shutdown(1000);
  await consumer;
  // #then
  expect({ admitted, outcome, starts, cache: await ctx.fs.readdir(dataPath) }).toEqual({
    admitted: true,
    outcome: "completed",
    starts: 0,
    cache: [],
  });
});

test("fresh startup repairs a real partially reset cache and stale OPML from unchanged current sources", async () => {
  // #given
  const { ctx, app, consumer, filesPath, dataPath } = await setup();
  await app.runInitialSync();
  await rm(join(filesPath, "Author/Book/02.mp3"));
  const sourceHash = Bun.hash(await Bun.file(join(filesPath, "Author/Book/01.mp3")).arrayBuffer());
  const entered = gate();
  const release = gate();
  cleanup.push(async () => {
    release.open();
  });
  const remove = ctx.fs.rm;
  ctx.fs.rm = async (path, options) => {
    await remove(path, options);

    if (path === join(dataPath, "Author")) {
      entered.open();
      await release.promise;
    }
  };

  const reset = app.runResync();
  await entered.promise;
  // #when
  const stopping = app.shutdown(1000);
  release.open();
  const outcome = await stopping;
  await consumer;
  const oldOpml = await Bun.file(join(dataPath, "feed.opml")).exists();
  const oldRss = await Bun.file(join(dataPath, "Author/Book/feed.xml")).exists();
  const nextBase = await buildContext();
  const nextCtx = { ...nextBase, config: ctx.config };
  registerHandlers(nextCtx.handlers);
  const next = new ApplicationLifecycle(nextCtx);
  next.startProcessing();
  cleanup.push(async () => {
    await next.shutdown(1000);
  });
  const recoveryEntered = gate();
  const recoveryRelease = gate();
  cleanup.push(async () => {
    recoveryRelease.open();
  });
  const make = nextCtx.fs.mkdir;
  nextCtx.fs.mkdir = async (path, options) => {
    if (path === dataPath) {
      recoveryEntered.open();
      await recoveryRelease.promise;
    }

    await make(path, options);
  };

  const repair = next.runInitialSync();
  await recoveryEntered.promise;
  const readyDuringRecovery = next.isPublicationReady();
  recoveryRelease.open();
  const recovered = await repair;
  const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false });

  const channel = parser.parse(await Bun.file(join(dataPath, "Author/Book/feed.xml")).text()).rss
    .channel;

  const outline = parser.parse(await Bun.file(join(dataPath, "feed.opml")).text()).opml.body
    .outline;

  // #then
  expect({
    outcome,
    reset: await reset,
    oldOpml,
    oldRss,
    readyDuringRecovery,
    recovered,
    ready: next.isPublicationReady(),
    unchanged:
      sourceHash === Bun.hash(await Bun.file(join(filesPath, "Author/Book/01.mp3")).arrayBuffer()),
    missingSource: await Bun.file(join(filesPath, "Author/Book/02.mp3")).exists(),
    title: channel.item.title,
    number: channel.item["itunes:episode"],
    guid: channel.item.guid["#text"],
    url: outline["@_xmlUrl"],
    obsoleteEpisode: await Bun.file(join(dataPath, "Author/Book/02.mp3/entry.xml")).exists(),
  }).toEqual({
    outcome: "completed",
    reset: false,
    oldOpml: true,
    oldRss: false,
    readyDuringRecovery: false,
    recovered: true,
    ready: true,
    unchanged: true,
    missingSource: false,
    title: "01",
    number: "1",
    guid: "Author/Book/01.mp3",
    url: "{{{BASE_URL}}}/Author/Book/feed.xml",
    obsoleteEpisode: false,
  });
});

test("pass-final OPML resumed after collection cannot begin its atomic write after stopping", async () => {
  // #given
  const { ctx, app, consumer, dataPath } = await setup();
  const entered = gate();
  const release = gate();
  cleanup.push(async () => {
    release.open();
  });
  let collecting = false;
  const info = ctx.logger.info;
  ctx.logger.info = (tag, message, context) => {
    if (tag === "OpmlSync" && message === "Regenerating OPML") collecting = true;
    info(tag, message, context);
  };

  const read = ctx.fs.readdir;
  ctx.fs.readdir = async (path) => {
    const entries = await read(path);

    if (collecting && path === dataPath) {
      entered.open();
      await release.promise;
    }

    return entries;
  };

  const pass = app.runInitialSync();
  await entered.promise;
  // #when
  const stopping = app.shutdown(1000);
  release.open();
  const outcome = await stopping;
  await consumer;
  // #then
  expect({
    outcome,
    pass: await pass,
    rss: await Bun.file(join(dataPath, "Author/Book/feed.xml")).exists(),
    opml: await Bun.file(join(dataPath, "feed.opml")).exists(),
    ready: app.isPublicationReady(),
  }).toEqual({ outcome: "completed", pass: false, rss: true, opml: false, ready: false });
});

test.each(["books", "data"])(
  "HTTP %s notification whose body resumes after stopping receives closed admission",
  async (watcher) => {
    // #given
    const { ctx, app, consumer } = await setup();
    let stream!: ReadableStreamDefaultController<Uint8Array>;

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        stream = controller;
      },
    });

    const response = createHttpHandler(
      ctx,
      app,
    )(new Request(`http://localhost/events/${watcher}`, { method: "POST", body }));

    // #when
    const outcome = await app.shutdown(1000);
    stream.enqueue(
      new TextEncoder().encode(
        JSON.stringify({ parent: ctx.config.dataPath, name: "_entry.xml", events: "CLOSE_WRITE" }),
      ),
    );
    stream.close();
    await consumer;
    // #then
    expect({ outcome, status: (await response).status, pending: ctx.queue.size }).toEqual({
      outcome: "completed",
      status: 503,
      pending: 0,
    });
  },
);

test("stopping before a held setup await prevents actual source-directory scanning", async () => {
  // #given
  const { ctx, app, consumer, filesPath } = await setup();
  const marker = join(filesPath, "oracle-marker");
  await Bun.write(marker, "not audio");

  const watcher = Bun.spawn(
    ["inotifywait", "-m", "-r", "-e", "open", "--format", "%w%f", filesPath],
    { stdout: "pipe", stderr: "pipe" },
  );

  const first = gate();
  const last = gate();
  const opens: string[] = [];
  let markers = 0;

  const pump = (async () => {
    let buffered = "";
    const reader = watcher.stdout.getReader();

    while (true) {
      const chunk = await reader.read();

      if (chunk.done) break;
      buffered += new TextDecoder().decode(chunk.value);
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";

      for (const line of lines) {
        if (line === marker) {
          markers++;

          if (markers === 1) first.open();

          if (markers === 2) last.open();
        } else if (markers === 1) opens.push(line);
      }
    }
  })();

  cleanup.push(async () => {
    watcher.kill("SIGTERM");
    await watcher.exited;
    await pump;
  });
  const setupReader = watcher.stderr.getReader();
  let status = "";

  while (!status.includes("Watches established.")) {
    const chunk = await setupReader.read();

    if (chunk.done) throw new Error(`Filesystem observation could not start: ${status}`);
    status += new TextDecoder().decode(chunk.value);
  }

  await Bun.file(marker).text();
  await first.promise;
  const entered = gate();
  const release = gate();
  cleanup.push(async () => {
    release.open();
  });
  const make = ctx.fs.mkdir;
  ctx.fs.mkdir = async (path, options) => {
    entered.open();
    await release.promise;
    await make(path, options);
  };

  const pass = app.runInitialSync();
  await entered.promise;
  // #when
  const stopping = app.shutdown(1000);
  release.open();
  const outcome = await stopping;
  await consumer;
  // An observed marker is an event-order barrier, not a quiet-period guess.
  await Bun.file(marker).text();
  await last.promise;
  // #then
  expect({ outcome, pass: await pass, opens }).toEqual({
    outcome: "completed",
    pass: false,
    opens: [],
  });
});
