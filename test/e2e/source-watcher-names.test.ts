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

async function docker(...args: string[]): Promise<string> {
  const result = await Bun.$`docker ${args}`.quiet();

  return result.stdout.toString().trim();
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
