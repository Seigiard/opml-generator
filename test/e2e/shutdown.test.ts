import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { XMLParser } from "fast-xml-parser";

const image = `opml-shutdown-${process.env.COMPOSE_PROJECT_NAME ?? "local"}`;

const containers: string[] = [];

const roots: string[] = [];

async function docker(...args: string[]): Promise<string> {
  const result = await Bun.$`docker ${args}`.quiet();

  return result.stdout.toString().trim();
}

async function observe<T>(
  description: string,
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeout = 10_000,
): Promise<T> {
  const deadline = performance.now() + timeout;
  let latest: T;

  do {
    latest = await read();

    if (done(latest)) return latest;
    await Bun.sleep(25);
  } while (performance.now() < deadline);

  throw new Error(`${description} timed out: ${JSON.stringify(latest)}`);
}

beforeAll(async () => {
  await docker("build", "--target", "production", "-t", image, ".");
}, 120_000);

afterAll(async () => {
  for (const name of containers) await docker("rm", "-f", name);

  for (const root of roots) await rm(root, { recursive: true });
  await docker("image", "rm", image);
}, 30_000);

async function launch(operation: string, suffix: string, stage = "before", waitForGate = true) {
  const root = await mkdtemp(join(tmpdir(), "opml-shutdown-"));
  roots.push(root);
  const books = join(root, "books");
  const cache = join(root, "cache");
  const control = join(root, "control");
  await mkdir(join(books, "Author/Book"), { recursive: true });
  await mkdir(join(books, "Other/Book"), { recursive: true });
  await mkdir(cache);
  await mkdir(control);
  const fixture = await Bun.file("test/fixtures/audio/untagged.mp3").arrayBuffer();

  for (const file of ["Author/Book/01.mp3", "Author/Book/02.mp3", "Other/Book/01.mp3"])
    await Bun.write(join(books, file), fixture);
  await Bun.write(
    join(cache, "feed.opml"),
    '<opml version="2.0"><head><title>Seed</title></head><body/></opml>',
  );
  await Bun.write(join(control, "gate.json"), JSON.stringify({ operation, suffix, stage }));
  const name = `opml-shutdown-${crypto.randomUUID()}`;
  containers.push(name);

  const id = await docker(
    "run",
    "-d",
    "--name",
    name,
    "--init",
    "--restart=no",
    "--stop-timeout=15",
    "-p",
    "127.0.0.1::80",
    "--mount",
    `type=bind,src=${books},dst=/audiobooks,readonly`,
    "--mount",
    `type=bind,src=${cache},dst=/data`,
    "--mount",
    `type=bind,src=${control},dst=/shutdown-control`,
    "--mount",
    `type=bind,src=${join(process.cwd(), "test/e2e/shutdown-bootstrap.ts")},dst=/app/test/e2e/shutdown-bootstrap.ts,readonly`,
    "-e",
    "SERVER_MODULE=/app/test/e2e/shutdown-bootstrap.ts",
    "-e",
    "RECONCILE_INTERVAL=0",
    "-e",
    "LOG_LEVEL=debug",
    image,
  );

  if (waitForGate)
    await observe(
      "controlled operation entry",
      () => Bun.file(join(control, "entered")).exists(),
      Boolean,
    );
  const logs = () => docker("logs", name);

  const status = async (path: string, method = "GET", body = "") =>
    Number(
      await docker(
        "exec",
        name,
        "bun",
        "-e",
        `const r = await fetch('http://127.0.0.1:3000${path}', { method: '${method}', ${body ? `body: ${JSON.stringify(body)},` : ""} }); console.log(r.status);`,
      ),
    );

  const operations = async () =>
    (await Bun.file(join(control, "operations.jsonl")).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

  const state = async () =>
    JSON.parse(await docker("inspect", "--format", "{{json .State}}", name));

  const sources = async () =>
    Promise.all(
      ["Author/Book/01.mp3", "Author/Book/02.mp3", "Other/Book/01.mp3"].map(async (file) =>
        Bun.hash(await Bun.file(join(books, file)).arrayBuffer()).toString(),
      ),
    );

  return { name, id, books, cache, control, logs, status, operations, state, sources };
}

async function terminate(run: Awaited<ReturnType<typeof launch>>, release: boolean, stop = false) {
  const since = new Date().toISOString();
  const started = performance.now();

  const command = stop
    ? docker("stop", "--timeout=15", run.name)
    : docker("kill", "--signal=SIGTERM", run.name);

  await observe("production stopping", run.logs, (logs) =>
    logs.includes('"tag":"Lifecycle","msg":"Stopping"'),
  );

  const body = JSON.stringify({
    parent: "/audiobooks/Author/Book",
    name: "02.mp3",
    events: "CLOSE_WRITE",
  });

  const closed = await Promise.all([
    run.status("/ready"),
    run.status("/events/books", "POST", body),
    run.status("/events/data", "POST", body),
    run.status("/resync", "POST"),
  ]);

  const startsAtStop = (await run.logs())
    .split("\n")
    .filter((line) => line.includes('"event_type":"handler_start"')).length;

  if (release) await Bun.write(join(run.control, "release"), "release");

  const state = await observe(
    "container terminal state",
    run.state,
    (value) => value.Status === "exited",
    12_000,
  );

  await command;
  const waitCode = Number(await docker("wait", run.name));
  const elapsed = performance.now() - started;
  const logs = await run.logs();

  const events = await docker(
    "events",
    "--since",
    since,
    "--until",
    new Date().toISOString(),
    "--filter",
    `container=${run.id}`,
    "--format",
    "{{json .}}",
  );

  const kills = events
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((event) => event.Action === "kill")
    .map((event) => event.Actor.Attributes.signal);

  return {
    closed,
    exitCode: state.ExitCode,
    waitCode,
    oom: state.OOMKilled,
    bounded: elapsed < 12_000,
    forced: kills.includes("9"),
    newHandlers:
      logs.split("\n").filter((line) => line.includes('"event_type":"handler_start"')).length -
      startsAtStop,
    outcome: logs
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line))
      .find((entry) => entry.tag === "Server" && entry.msg === "Shutdown finished")?.outcome,
    reaped: (logs.match(/\[entrypoint\] Reaped /g) ?? []).length,
  };
}

test("real startup TERM closes admission before scan and waits its owned operation", async () => {
  // #given
  const run = await launch("mkdir", "/data");
  const ready = await run.status("/ready");
  // #when
  const outcome = await terminate(run, true);

  const starts = (await run.operations())
    .filter((event) => event.operation)
    .map((event) => event.operation);

  // #then
  expect({ ready, outcome, starts }).toEqual({
    ready: 503,
    outcome: {
      closed: [503, 503, 503, 503],
      exitCode: 0,
      waitCode: 0,
      oom: false,
      bounded: true,
      forced: false,
      newHandlers: 0,
      outcome: "completed",
      reaped: 3,
    },
    starts: ["mkdir"],
  });
}, 30_000);

test("real active-write TERM finishes one handler and restart repairs its RSS-to-OPML leftover", async () => {
  // #given
  const run = await launch("atomicWrite", "/Author/Book/feed.xml", "after");
  const unchanged = await run.sources();
  const rssWritten = await Bun.file(join(run.cache, "Author/Book/feed.xml")).exists();
  // #when
  const outcome = await terminate(run, true, true);

  const leftover = new XMLParser({ ignoreAttributes: false }).parse(
    await Bun.file(join(run.cache, "feed.opml")).text(),
  ).opml.body;

  await rm(join(run.control, "entered"));
  await rm(join(run.control, "release"));
  await Bun.write(
    join(run.control, "gate.json"),
    JSON.stringify({ operation: "mkdir", suffix: "/data", stage: "before" }),
  );
  await docker("start", run.name);
  await observe(
    "restart recovery entry",
    () => Bun.file(join(run.control, "entered")).exists(),
    Boolean,
  );
  const restartReady = await run.status("/ready");
  await Bun.write(join(run.control, "release"), "release");
  const port = (await docker("port", run.name, "80")).split(":").pop();
  await observe(
    "recovered readiness",
    async () => {
      try {
        return (await fetch(`http://127.0.0.1:${port}/ready`)).status;
      } catch {
        return 0;
      }
    },
    (value) => value === 200,
  );
  const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false });

  const channel = parser.parse(await Bun.file(join(run.cache, "Author/Book/feed.xml")).text()).rss
    .channel;

  const parsedOutlines = parser.parse(await Bun.file(join(run.cache, "feed.opml")).text()).opml.body
    .outline;

  const outlines = Array.isArray(parsedOutlines)
    ? parsedOutlines
    : parsedOutlines === undefined
      ? []
      : [parsedOutlines];

  const urls = outlines.map((outline: { "@_xmlUrl": string }) => outline["@_xmlUrl"]).sort();

  const episodes = channel.item.map(
    (item: { title: string; guid: { "#text": string }; "itunes:episode": string }) => [
      item.title,
      item["itunes:episode"],
      item.guid["#text"],
    ],
  );

  await docker("stop", "--timeout=15", run.name);
  // #then
  expect({
    outcome,
    rssWritten,
    restartReady,
    leftover,
    episodes,
    urls,
    unchanged: (await run.sources()).join() === unchanged.join(),
  }).toEqual({
    outcome: {
      closed: [503, 503, 503, 503],
      exitCode: 0,
      waitCode: 0,
      oom: false,
      bounded: true,
      forced: false,
      newHandlers: 0,
      outcome: "completed",
      reaped: 3,
    },
    rssWritten: true,
    restartReady: 503,
    leftover: "",
    episodes: [
      ["01", "1", "Author/Book/01.mp3"],
      ["02", "2", "Author/Book/02.mp3"],
    ],
    urls: ["{{{BASE_URL}}}/Author/Book/feed.xml", "{{{BASE_URL}}}/Other/Book/feed.xml"],
    unchanged: true,
  });
}, 40_000);

test("real blocked handler TERM expires the application budget without container KILL", async () => {
  // #given
  const run = await launch("atomicWrite", "/01.mp3/entry.xml");
  // #when
  const outcome = await terminate(run, false, true);
  // #then
  expect({
    outcome,
    written: await Bun.file(join(run.cache, "Author/Book/01.mp3/entry.xml")).exists(),
  }).toEqual({
    outcome: {
      closed: [503, 503, 503, 503],
      exitCode: 0,
      waitCode: 0,
      oom: false,
      bounded: true,
      forced: false,
      newHandlers: 0,
      outcome: "deadline",
      reaped: 3,
    },
    written: false,
  });
}, 30_000);

test("steady-state watcher TERM completes its active metadata writer without starting the pending episode", async () => {
  // #given
  const run = await launch("atomicWrite", "/03.mp3/entry.xml", "before", false);
  await observe(
    "initial publication",
    async () => {
      try {
        return await run.status("/ready");
      } catch {
        return 0;
      }
    },
    (value) => value === 200,
  );
  const fixture = await Bun.file("test/fixtures/audio/untagged.mp3").arrayBuffer();
  await Bun.write(join(run.books, "Author/Book/03.mp3"), fixture);

  const firstAdmission = await run.status(
    "/events/books",
    "POST",
    JSON.stringify({ parent: "/audiobooks/Author/Book", name: "03.mp3", events: "CLOSE_WRITE" }),
  );

  if (firstAdmission !== 202) throw new Error(`Source admission failed: ${firstAdmission}`);
  await observe(
    "watcher writer entry",
    () => Bun.file(join(run.control, "entered")).exists(),
    Boolean,
  );
  await Bun.write(join(run.books, "Author/Book/04.mp3"), fixture);

  const admitted = await run.status(
    "/events/books",
    "POST",
    JSON.stringify({ parent: "/audiobooks/Author/Book", name: "04.mp3", events: "CLOSE_WRITE" }),
  );

  // #when
  const outcome = await terminate(run, true);
  const activeWritten = await Bun.file(join(run.cache, "Author/Book/03.mp3/entry.xml")).exists();
  const pendingWritten = await Bun.file(join(run.cache, "Author/Book/04.mp3/entry.xml")).exists();
  const sourcePaths = ["01", "02", "03", "04"];

  const sourceHashes = () =>
    Promise.all(
      sourcePaths.map(async (name) =>
        Bun.hash(
          await Bun.file(join(run.books, `Author/Book/${name}.mp3`)).arrayBuffer(),
        ).toString(),
      ),
    );

  const before = await sourceHashes();
  await docker("start", run.name);
  await observe(
    "metadata and stale RSS recovery",
    async () => {
      try {
        return await run.status("/ready");
      } catch {
        return 0;
      }
    },
    (value) => value === 200,
  );

  const channel = new XMLParser({ parseTagValue: false }).parse(
    await Bun.file(join(run.cache, "Author/Book/feed.xml")).text(),
  ).rss.channel;

  const recovered = channel.item.map(
    (item: { title: string; "itunes:episode": string; guid: string }) => [
      item.title,
      item["itunes:episode"],
      item.guid,
    ],
  );

  await docker("stop", "--timeout=15", run.name);
  // #then
  expect({
    admitted,
    outcome,
    activeWritten,
    pendingWritten,
    recovered,
    unchanged: (await sourceHashes()).join() === before.join(),
  }).toEqual({
    admitted: 202,
    outcome: {
      closed: [503, 503, 503, 503],
      exitCode: 0,
      waitCode: 0,
      oom: false,
      bounded: true,
      forced: false,
      newHandlers: 0,
      outcome: "completed",
      reaped: 3,
    },
    activeWritten: true,
    pendingWritten: false,
    recovered: [
      ["01", "1", "Author/Book/01.mp3"],
      ["02", "2", "Author/Book/02.mp3"],
      ["03", "3", "Author/Book/03.mp3"],
      ["04", "4", "Author/Book/04.mp3"],
    ],
    unchanged: true,
  });
}, 30_000);

test("the real supervisor reaps an unexpectedly killed Bun child and returns failure", async () => {
  // #given
  const run = await launch("mkdir", "/data");
  // #when
  await docker("exec", run.name, "sh", "-c", 'kill -KILL "$(pidof bun)"');

  const state = await observe(
    "unexpected child exit",
    run.state,
    (value) => value.Status === "exited",
  ).catch(async (error) => {
    throw new Error(`${error}\n${await run.logs()}\n${await docker("top", run.name)}`);
  });

  const logs = await run.logs();
  // #then
  expect({
    code: state.ExitCode,
    wait: Number(await docker("wait", run.name)),
    unexpected: logs.includes("exited unexpectedly"),
    reaped: (logs.match(/\[entrypoint\] Reaped /g) ?? []).length,
  }).toEqual({ code: 1, wait: 1, unexpected: true, reaped: 3 });
}, 30_000);
