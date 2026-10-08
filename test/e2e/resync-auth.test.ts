import { expect, test } from "bun:test";
import { XMLParser } from "fast-xml-parser";
import { z } from "zod";

const baseUrl = process.env.TEST_BASE_URL || "http://localhost:8080";

const parser = new XMLParser({ ignoreAttributes: false });

const episodeSchema = z.object({ title: z.string(), guid: z.object({ "#text": z.string() }) });

const podcastSchema = z.object({
  rss: z.object({ channel: z.object({ item: z.array(episodeSchema) }) }),
});

async function inContainer(code: string): Promise<string> {
  const result =
    await Bun.$`docker compose -f docker-compose.e2e.yml exec -T opml bun -e ${code}`.quiet();

  return result.stdout.toString().trim();
}

async function waitForEpisodeTitle(
  expected: string,
  update?: () => Promise<void>,
): Promise<string> {
  const deadline = Date.now() + 15_000;
  let latest: string | undefined;

  while (Date.now() < deadline) {
    if (update) await update();
    const response = await fetch(`${baseUrl}/test/Test%20Author/Test%20Audiobook/feed.xml`);

    if (response.status === 200) {
      const podcast = podcastSchema.parse(parser.parse(await response.text()));
      latest = podcast.rss.channel.item.find(
        (episode) =>
          episode.guid["#text"] === "test/Test Author/Test Audiobook/01 - Chapter One.mp3",
      )?.title;

      if (latest === expected) return latest;
    }

    await Bun.sleep(50);
  }

  throw new Error(`Episode title did not recover: expected ${expected}, received ${latest}`);
}

async function waitForReady() {
  const deadline = Date.now() + 30_000;

  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/ready`);

    if (response.status === 200) return;
    await Bun.sleep(50);
  }

  throw new Error("Publication readiness did not recover after resync");
}

test("nginx retains resync Basic auth and proxies authenticated GET as an accepted rebuild", async () => {
  // #given
  await waitForReady();
  await waitForEpisodeTitle("Chapter One");

  const sourceHash = await inContainer(
    'console.log(Bun.hash(await Bun.file("/audiobooks/test/Test Author/Test Audiobook/01 - Chapter One.mp3").arrayBuffer()).toString(16));',
  );

  const missing = await fetch(`${baseUrl}/resync`);

  const wrong = await fetch(`${baseUrl}/resync`, {
    headers: { Authorization: `Basic ${Buffer.from("wrong:credentials").toString("base64")}` },
  });

  await inContainer(
    'const path="/data/test/Test Author/Test Audiobook/feed.xml"; const xml=await Bun.file(path).text(); await Bun.write(path, xml.replace(/<title>Chapter One<\\/title>/, "<title>Cached title before resync</title>"));',
  );
  const corruptedTitle = await waitForEpisodeTitle("Cached title before resync");

  // #when
  const accepted = await fetch(`${baseUrl}/resync?force=1`, {
    headers: { Authorization: `Basic ${Buffer.from("admin:secret").toString("base64")}` },
  });

  expect(accepted.status).toBe(202);
  const message = await accepted.text();
  const restoredTitle = await waitForEpisodeTitle("Chapter One");
  await waitForReady();
  const rssResponse = await fetch(`${baseUrl}/test/Test%20Author/Test%20Audiobook/feed.xml`);
  const opmlResponse = await fetch(`${baseUrl}/feed.opml`);
  expect([rssResponse.status, opmlResponse.status]).toEqual([200, 200]);
  const channel = parser.parse(await rssResponse.text()).rss.channel;
  const rawOutlines = parser.parse(await opmlResponse.text()).opml.body.outline;
  const outlines = Array.isArray(rawOutlines) ? rawOutlines : [rawOutlines];

  // #then
  expect({
    unauthorized: [missing.status, wrong.status],
    realm: missing.headers.get("www-authenticate"),
    message,
    corruptedTitle,
    restoredTitle,
    unchangedSource:
      sourceHash ===
      (await inContainer(
        'console.log(Bun.hash(await Bun.file("/audiobooks/test/Test Author/Test Audiobook/01 - Chapter One.mp3").arrayBuffer()).toString(16));',
      )),
    episodes: channel.item.map((item: { guid: { "#text": string }; "itunes:episode": number }) => ({
      guid: item.guid["#text"],
      number: item["itunes:episode"],
    })),
    opmlUrls: outlines.map((outline: { "@_xmlUrl": string }) => outline["@_xmlUrl"]).sort(),
  }).toEqual({
    unauthorized: [401, 401],
    realm: 'Basic realm="Podcast Admin"',
    message: "Resync started",
    corruptedTitle: "Cached title before resync",
    restoredTitle: "Chapter One",
    unchangedSource: true,
    episodes: [
      { guid: "test/Test Author/Test Audiobook/01 - Chapter One.mp3", number: 1 },
      { guid: "test/Test Author/Test Audiobook/02 - Chapter Two.mp3", number: 2 },
      { guid: "test/Test Author/Test Audiobook/03 - Chapter Three.m4a", number: 3 },
    ],
    opmlUrls: [
      `${baseUrl}/test/Test%20Author/Test%20Audiobook/feed.xml`,
      `${baseUrl}/test/Untagged%20Podcast/feed.xml`,
    ].sort(),
  });
}, 30_000);
