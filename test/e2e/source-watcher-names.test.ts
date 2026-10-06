import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { XMLParser } from "fast-xml-parser";
import { z } from "zod";

const image = `opml-source-names-${process.env.COMPOSE_PROJECT_NAME ?? "local"}`;

const parser = new XMLParser({ ignoreAttributes: false });

const outline = z.object({ "@_xmlUrl": z.string() });

const opmlSchema = z.object({
  opml: z.object({ body: z.object({ outline: z.union([outline, z.array(outline)]) }) }),
});

const podcastSchema = z.object({
  rss: z.object({
    channel: z.object({
      item: z.object({ title: z.string(), guid: z.object({ "#text": z.string() }) }),
    }),
  }),
});

const containers: string[] = [];

const roots: string[] = [];

test("public HTTP preserves unrestricted namespace, episode identity, ranges and legacy reuse across restart", async () => {
  // #given
  const root = await mkdtemp(join(tmpdir(), "namespace-http-"));
  roots.push(root);
  const books = join(root, "books");
  const cache = join(root, "cache");
  await mkdir(books);
  await mkdir(cache);

  const cases: Array<[string, string]> = [
    ["feed.xml", "/feed.xml/feed.xml"],
    ["feed.opml", "/feed.opml/feed.xml"],
    ["_entry.xml", "/_entry.xml/feed.xml"],
    ["entry.xml", "/entry.xml/feed.xml"],
    ["cover.jpg", "/cover.jpg/feed.xml"],
    ["feed.xml.tmp", "/feed.xml.tmp/feed.xml"],
    ["~", "/~/feed.xml"],
    ["~feed.xml", "/~feed.xml/feed.xml"],
    ["Nested/feed.xml/entry.xml/cover.jpg", "/Nested/feed.xml/entry.xml/cover.jpg/feed.xml"],
    ["Parent/feed.xml", "/Parent/feed.xml/feed.xml"],
  ];

  for (const [name] of cases)
    await Bun.write(join(books, name!, "01.mp3"), Bun.file("test/fixtures/audio/tagged.mp3"));
  await Bun.write(join(books, "Parent/direct.mp3"), Bun.file("test/fixtures/audio/untagged.mp3"));
  await Bun.write(join(books, "root.mp3"), Bun.file("test/fixtures/audio/untagged.mp3"));
  const container = `opml-source-names-${crypto.randomUUID()}`;
  containers.push(container);
  await docker(
    "run",
    "-d",
    "--name",
    container,
    "--init",
    "--stop-timeout=15",
    "-p",
    "127.0.0.1::80",
    "--mount",
    `type=bind,src=${books},dst=/audiobooks,readonly`,
    "--mount",
    `type=bind,src=${cache},dst=/data`,
    "-e",
    "RECONCILE_INTERVAL=0",
    image,
  );
  let baseUrl = `http://${await docker("port", container, "80/tcp")}`;

  const ready = () =>
    observe(
      "namespace readiness",
      async () => {
        try {
          return (await fetch(`${baseUrl}/ready`)).status;
        } catch {
          return 0;
        }
      },
      (status) => status === 200,
    ).catch(async (error) => {
      throw new Error(`${error}\n${await docker("logs", container)}`);
    });

  await ready();

  const publication = async () => {
    const response = await fetch(`${baseUrl}/feed.opml`);

    if (response.status !== 200) throw new Error(`OPML HTTP status: ${response.status}`);
    const value = opmlSchema.parse(parser.parse(await response.text())).opml.body.outline;
    const outlines = Array.isArray(value) ? value : [value];
    const episodes = [];

    for (const [, url] of cases) {
      const rss = await fetch(`${baseUrl}${url}`);

      if (rss.status !== 200) throw new Error(`Public RSS failed: ${url} ${rss.status}`);
      const item = podcastSchema.parse(parser.parse(await rss.text())).rss.channel.item;
      episodes.push({ url, title: item.title, guid: item.guid["#text"] });
    }

    return { urls: outlines.map((entry) => new URL(entry["@_xmlUrl"]).pathname).sort(), episodes };
  };

  const first = await publication().catch(async (error) => {
    throw new Error(`${error}\n${await docker("logs", container)}`);
  });

  const original = await Bun.file(join(cache, "~/feed.xml/01.mp3/entry.xml")).text();
  await docker("stop", "--timeout=15", container);
  await rm(join(cache, "~/feed.xml"), { recursive: true });
  await rm(join(cache, "feed.xml"));
  await Bun.write(join(cache, "feed.xml/01.mp3/entry.xml"), original);

  // #when
  const since = new Date().toISOString();
  await docker("start", container);
  baseUrl = `http://${await docker("port", container, "80/tcp")}`;
  await ready();
  const second = await publication();
  const logs = await docker("logs", "--since", since, container);

  const range = await fetch(`${baseUrl}/audiobooks/feed.xml/01.mp3`, {
    headers: { Range: "bytes=0-99" },
  });

  // #then
  expect({
    first,
    second,
    reused: original === (await Bun.file(join(cache, "~/feed.xml/01.mp3/entry.xml")).text()),
    audioRebuilds: logs
      .split("\n")
      .filter((line) => line.includes('"tag":"AudioSync","msg":"Processing"')).length,
    range: [range.status, (await range.arrayBuffer()).byteLength],
  }).toEqual({
    first: {
      urls: ["/feed.xml", "/Parent/feed.xml", ...cases.map(([, url]) => url)].sort(),
      episodes: cases.map(([name, url]) => ({ url, title: "Test Title", guid: `${name}/01.mp3` })),
    },
    second: {
      urls: ["/feed.xml", "/Parent/feed.xml", ...cases.map(([, url]) => url)].sort(),
      episodes: cases.map(([name, url]) => ({ url, title: "Test Title", guid: `${name}/01.mp3` })),
    },
    reused: true,
    audioRebuilds: 0,
    range: [206, 100],
  });
}, 40_000);

async function docker(...args: string[]): Promise<string> {
  const result = await Bun.$`docker ${args}`.quiet();

  return (result.stdout.toString() + (args[0] === "logs" ? result.stderr.toString() : "")).trim();
}

async function observe<T>(
  description: string,
  read: () => Promise<T>,
  done: (value: T) => boolean,
): Promise<T> {
  const deadline = Date.now() + 10_000;
  let latest;

  do {
    latest = await read();

    if (done(latest)) return latest;
    await Bun.sleep(50);
  } while (Date.now() < deadline);

  throw new Error(`${description} did not converge: ${JSON.stringify(latest)}`);
}

beforeAll(async () => {
  await docker("build", "--target", "production", "-t", image, ".");
}, 120_000);

afterAll(async () => {
  for (const container of containers) {
    await docker("stop", "--timeout=15", container);
    await docker("rm", container);
  }

  for (const root of roots) await rm(root, { recursive: true });
  await docker("image", "rm", image);
}, 30_000);

test("a source _entry.xml directory never becomes a data marker notification at cache root", async () => {
  // #given
  const root = await mkdtemp(join(tmpdir(), "data-marker-directory-"));
  roots.push(root);
  await mkdir(join(root, "books/Keeper/Book"), { recursive: true });
  await mkdir(join(root, "cache/generated"), { recursive: true });
  await Bun.write(join(root, "cache/keep"), "sibling sentinel");
  await Bun.write(
    join(root, "books/Keeper/Book/keep.mp3"),
    Bun.file("test/fixtures/audio/untagged.mp3"),
  );
  await Bun.write(join(root, "incoming/01.mp3"), Bun.file("test/fixtures/audio/tagged.mp3"));
  const container = `opml-source-names-${crypto.randomUUID()}`;
  containers.push(container);
  const dataPath = "/library/cache/generated";
  await docker(
    "run",
    "-d",
    "--name",
    container,
    "--init",
    "--stop-timeout=15",
    "-p",
    "127.0.0.1::80",
    "--mount",
    `type=bind,src=${root},dst=/library`,
    "-e",
    "FILES=/library/books",
    "-e",
    `DATA=${dataPath}`,
    "-e",
    "RECONCILE_INTERVAL=0",
    image,
  );
  const baseUrl = `http://${await docker("port", container, "80/tcp")}`;
  await observe(
    "initial readiness",
    async () => (await fetch(`${baseUrl}/ready`)).status,
    (status) => status === 200,
  );
  await observe(
    "data watcher readiness",
    async () => {
      await docker(
        "exec",
        container,
        "bun",
        "-e",
        `const path="${dataPath}/Keeper/Book/keep.mp3/entry.xml"; await Bun.write(path, (await Bun.file(path).text()).replace(/<title>[^<]*<\\/title>/,"<title>Data ready</title>"));`,
      );

      return docker(
        "exec",
        container,
        "bun",
        "-e",
        `import {XMLParser} from "fast-xml-parser"; console.log(new XMLParser().parse(await Bun.file("${dataPath}/Keeper/Book/feed.xml").text()).rss.channel.title);`,
      );
    },
    (title) => title === "Data ready",
  );

  // #when
  await docker(
    "exec",
    container,
    "bun",
    "-e",
    `await import("node:fs/promises").then(fs => fs.mkdir("${dataPath}/_entry.xml"));`,
  );
  await docker(
    "exec",
    container,
    "bun",
    "-e",
    'await import("node:fs/promises").then(fs => fs.rename("/library/incoming","/library/books/_entry.xml"));',
  );

  const logs = await observe(
    "nested real marker delivery",
    () => docker("logs", container),
    (value) =>
      value.split("\n").some((line) => {
        if (!line.startsWith("{")) return false;

        const event = z
          .object({
            event_tag: z.string().optional(),
            event_type: z.string().optional(),
            path: z.string().optional(),
          })
          .parse(JSON.parse(line));

        return (
          event.event_tag === "FolderEntryXmlChanged" &&
          event.event_type === "handler_complete" &&
          event.path === `${dataPath}/~/_entry.xml/`
        );
      }),
  );

  const rootMarkers = logs
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) =>
      z
        .object({
          event_tag: z.string().optional(),
          event_type: z.string().optional(),
          path: z.string().optional(),
        })
        .parse(JSON.parse(line)),
    )
    .filter(
      (event) =>
        event.event_tag === "FolderEntryXmlChanged" &&
        event.event_type === "handler_start" &&
        event.path === `${dataPath}/`,
    ).length;

  // #then
  expect({
    rootMarkers,
    sibling: await Bun.file(join(root, "cache/keep")).text(),
    source: await Bun.file(join(root, "books/_entry.xml/01.mp3")).exists(),
    ready: (await fetch(`${baseUrl}/ready`)).status,
  }).toEqual({
    rootMarkers: 0,
    sibling: "sibling sentinel",
    source: true,
    ready: 200,
  });
}, 30_000);

test.each([
  ["events.jsonl", "/Author/events.jsonl/feed.xml"],
  ["errors.jsonl", "/Author/errors.jsonl/feed.xml"],
])(
  "source watcher removes the podcast when a %s directory is renamed out with reconciliation disabled",
  async (name, url) => {
    // #given
    const root = await mkdtemp(join(tmpdir(), "source-watcher-names-"));
    roots.push(root);
    const books = join(root, "books");
    await mkdir(join(books, "Author", name), { recursive: true });
    await mkdir(join(books, "Keeper/Book"), { recursive: true });
    const audio = await Bun.file("test/fixtures/audio/untagged.mp3").arrayBuffer();
    await Bun.write(join(books, "Author", name, "01.mp3"), audio);
    await Bun.write(join(books, "Keeper/Book/keep.mp3"), audio);
    const container = `opml-source-names-${crypto.randomUUID()}`;
    containers.push(container);
    await docker(
      "run",
      "-d",
      "--name",
      container,
      "--init",
      "--stop-timeout=15",
      "-p",
      "127.0.0.1::80",
      "--mount",
      `type=bind,src=${root},dst=/library`,
      "-e",
      "FILES=/library/books",
      "-e",
      "RECONCILE_INTERVAL=0",
      image,
    );
    const port = await docker("port", container, "80/tcp");
    const baseUrl = `http://${port}`;
    await observe(
      "publication readiness",
      async () => (await fetch(`${baseUrl}/ready`)).status,
      (status) => status === 200,
    );

    const snapshot = async () => {
      const [rss, response] = await Promise.all([
        fetch(`${baseUrl}${url}`),
        fetch(`${baseUrl}/feed.opml`),
      ]);

      if (response.status !== 200) throw new Error(`OPML HTTP status: ${response.status}`);
      const parsed = opmlSchema.parse(parser.parse(await response.text()));
      const value = parsed.opml.body.outline;
      const outlines = Array.isArray(value) ? value : [value];

      return {
        rss: rss.status,
        subscriptions: outlines.map((item) => new URL(item["@_xmlUrl"]).pathname).sort(),
      };
    };

    expect(await snapshot()).toEqual({ rss: 200, subscriptions: [url, "/Keeper/Book/feed.xml"] });
    // A real source notification proves the recursive watcher is running before the rename.
    await observe(
      "source watcher admission",
      async () => {
        await docker(
          "exec",
          container,
          "bun",
          "-e",
          'const path="/library/books/Keeper/Book/keep.mp3"; await Bun.write(path, await Bun.file(path).arrayBuffer());',
        );

        return docker("logs", container);
      },
      (logs) =>
        logs.includes(
          '"event_tag":"SourcePathSyncRequested","path":"/library/books/Keeper/Book/keep.mp3"',
        ),
    );

    // #when
    // Both paths are inside one mount. rename cannot fall back to copy/delete notifications.
    await docker(
      "exec",
      container,
      "bun",
      "-e",
      `await import("node:fs/promises").then(fs => fs.rename("/library/books/Author/${name}", "/library/moved"));`,
    );

    const published = await observe(
      "source watcher removal",
      snapshot,
      (value) => value.rss === 404 && value.subscriptions.length === 1,
    );

    // #then
    expect(published).toEqual({ rss: 404, subscriptions: ["/Keeper/Book/feed.xml"] });
  },
  30_000,
);

test.each([
  [
    "quoted filename",
    "Quote Parent",
    '01 - "Introduction".mp3',
    "/Quote%20Parent/feed.xml",
    'Quote Parent/01 - "Introduction".mp3',
  ],
  [
    "quoted parent",
    'Author/"Book"',
    "01.mp3",
    "/Author/%22Book%22/feed.xml",
    'Author/"Book"/01.mp3',
  ],
  [
    "backslash and newline",
    "Parent\\Line\nBreak",
    "01\\intro\npart.mp3",
    "/Parent%5CLine%0ABreak/feed.xml",
    "Parent\\Line\nBreak/01\\intro\npart.mp3",
  ],
])(
  "production watcher serializes %s for source creation, data updates, and directory removal",
  async (_description, parent, name, url, guid) => {
    // #given
    const root = await mkdtemp(join(tmpdir(), "source-watcher-escaping-"));
    roots.push(root);
    const books = join(root, "books");
    await mkdir(join(books, parent), { recursive: true });
    await mkdir(join(books, "Keeper/Book"), { recursive: true });
    await Bun.write(
      join(books, "Keeper/Book/keep.mp3"),
      Bun.file("test/fixtures/audio/untagged.mp3"),
    );
    const audio = await Bun.file("test/fixtures/audio/tagged.mp3").arrayBuffer();
    const container = `opml-source-names-${crypto.randomUUID()}`;
    containers.push(container);
    await docker(
      "run",
      "-d",
      "--name",
      container,
      "--init",
      "--stop-timeout=15",
      "-p",
      "127.0.0.1::80",
      "--mount",
      `type=bind,src=${root},dst=/library`,
      "-e",
      "FILES=/library/books",
      "-e",
      "RECONCILE_INTERVAL=0",
      image,
    );
    const baseUrl = `http://${await docker("port", container, "80/tcp")}`;
    await observe(
      "publication readiness",
      async () => (await fetch(`${baseUrl}/ready`)).status,
      (status) => status === 200,
    );
    await observe(
      "source watcher admission",
      async () => {
        await docker(
          "exec",
          container,
          "bun",
          "-e",
          'const path="/library/books/Keeper/Book/keep.mp3"; await Bun.write(path, await Bun.file(path).arrayBuffer());',
        );

        return docker("logs", container);
      },
      (logs) =>
        logs.includes(
          '"event_tag":"SourcePathSyncRequested","path":"/library/books/Keeper/Book/keep.mp3"',
        ),
    );

    const publication = async () => {
      const rss = await fetch(`${baseUrl}${url}`);

      if (rss.status !== 200) return { status: rss.status, title: "", guid: "", subscriptions: [] };
      const item = podcastSchema.parse(parser.parse(await rss.text())).rss.channel.item;
      const opmlResponse = await fetch(`${baseUrl}/feed.opml`);

      if (opmlResponse.status !== 200) throw new Error(`OPML HTTP status: ${opmlResponse.status}`);
      const value = opmlSchema.parse(parser.parse(await opmlResponse.text())).opml.body.outline;
      const outlines = Array.isArray(value) ? value : [value];

      return {
        status: rss.status,
        title: item.title,
        guid: item.guid["#text"],
        subscriptions: outlines.map((entry) => new URL(entry["@_xmlUrl"]).pathname).sort(),
      };
    };

    // #when
    await docker(
      "exec",
      container,
      "bun",
      "-e",
      `await Bun.write(${JSON.stringify(join("/library/books", parent, name))}, Buffer.from(${JSON.stringify(Buffer.from(audio).toString("base64"))}, "base64"));`,
    );

    const created = await observe(
      "escaped source publication",
      publication,
      (value) => value.title === "Test Title" && value.subscriptions.includes(url),
    );

    const cachePath = join("/data", parent, name, "entry.xml");

    const changed = await observe(
      "escaped data notification publication",
      async () => {
        await docker(
          "exec",
          container,
          "bun",
          "-e",
          `const path=${JSON.stringify(cachePath)}; const xml=await Bun.file(path).text(); await Bun.write(path, xml.replace("<title>Test Title</title>", "<title>Cached Transport Title</title>"));`,
        );

        return publication();
      },
      (value) => value.title === "Cached Transport Title",
    );

    await docker(
      "exec",
      container,
      "bun",
      "-e",
      `await import("node:fs/promises").then(fs => fs.rename(${JSON.stringify(join("/library/books", parent))}, "/library/moved"));`,
    );

    const removed = await observe(
      "escaped parent removal",
      async () => {
        const rss = await fetch(`${baseUrl}${url}`);
        const response = await fetch(`${baseUrl}/feed.opml`);

        if (response.status !== 200) throw new Error(`OPML HTTP status: ${response.status}`);
        const value = opmlSchema.parse(parser.parse(await response.text())).opml.body.outline;
        const outlines = Array.isArray(value) ? value : [value];

        return {
          status: rss.status,
          subscriptions: outlines.map((entry) => new URL(entry["@_xmlUrl"]).pathname),
        };
      },
      (value) => value.status === 404 && value.subscriptions.length === 1,
    );

    // #then
    expect({ created, changed, removed }).toEqual({
      created: {
        status: 200,
        title: "Test Title",
        guid,
        subscriptions: ["/Keeper/Book/feed.xml", url].sort(),
      },
      changed: {
        status: 200,
        title: "Cached Transport Title",
        guid,
        subscriptions: ["/Keeper/Book/feed.xml", url].sort(),
      },
      removed: { status: 404, subscriptions: ["/Keeper/Book/feed.xml"] },
    });
  },
  30_000,
);
