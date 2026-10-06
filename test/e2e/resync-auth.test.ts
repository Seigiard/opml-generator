import { expect, test } from "bun:test";
import { XMLParser } from "fast-xml-parser";

const baseUrl = process.env.TEST_BASE_URL || "http://localhost:8080";

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
  const missing = await fetch(`${baseUrl}/resync`);

  const wrong = await fetch(`${baseUrl}/resync`, {
    headers: { Authorization: `Basic ${Buffer.from("wrong:credentials").toString("base64")}` },
  });

  // #when
  const accepted = await fetch(`${baseUrl}/resync`, {
    headers: { Authorization: `Basic ${Buffer.from("admin:secret").toString("base64")}` },
  });

  expect(accepted.status).toBe(202);
  const message = await accepted.text();
  await waitForReady();
  const rssResponse = await fetch(`${baseUrl}/test/Test%20Author/Test%20Audiobook/feed.xml`);
  const opmlResponse = await fetch(`${baseUrl}/feed.opml`);
  expect([rssResponse.status, opmlResponse.status]).toEqual([200, 200]);
  const parser = new XMLParser({ ignoreAttributes: false });
  const channel = parser.parse(await rssResponse.text()).rss.channel;
  const outlines = parser.parse(await opmlResponse.text()).opml.body.outline;

  // #then
  expect({
    unauthorized: [missing.status, wrong.status],
    realm: missing.headers.get("www-authenticate"),
    message,
    episodes: channel.item.map((item: { guid: { "#text": string }; "itunes:episode": number }) => ({
      guid: item.guid["#text"],
      number: item["itunes:episode"],
    })),
    urls: outlines.map((outline: { "@_xmlUrl": string }) => outline["@_xmlUrl"]),
  }).toEqual({
    unauthorized: [401, 401],
    realm: 'Basic realm="Podcast Admin"',
    message: "Resync started",
    episodes: [
      { guid: "test/Test Author/Test Audiobook/01 - Chapter One.mp3", number: 1 },
      { guid: "test/Test Author/Test Audiobook/02 - Chapter Two.mp3", number: 2 },
      { guid: "test/Test Author/Test Audiobook/03 - Chapter Three.m4a", number: 3 },
    ],
    urls: [
      `${baseUrl}/test/Test%20Author/Test%20Audiobook/feed.xml`,
      `${baseUrl}/test/Untagged%20Podcast/feed.xml`,
    ],
  });
}, 30_000);
