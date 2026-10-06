import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { z } from "zod";
import { XMLParser } from "fast-xml-parser";

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:8080";

const AUDIOBOOKS_DIR = "/audiobooks";

const TEST_FOLDER = "test-events";

const FIXTURE_MP3 = "/audiobooks/test/Test Author/Test Audiobook/01 - Chapter One.mp3";

const logEntrySchema = z.object({
  ts: z.string(),
  level: z.string(),
  tag: z.string(),
  msg: z.string(),
  event_type: z.string().optional(),
  event_id: z.string().optional(),
  event_tag: z.string().optional(),
  path: z.string().optional(),
  duration_ms: z.number().optional(),
  cascade_count: z.number().optional(),
  cascade_tags: z.array(z.string()).optional(),
  error: z.string().optional(),
});

type LogEntry = z.output<typeof logEntrySchema>;

async function execInContainer(cmd: string): Promise<string> {
  const proc = Bun.spawn([
    "docker",
    "compose",
    "-f",
    "docker-compose.e2e.yml",
    "exec",
    "-T",
    "opml",
    "sh",
    "-c",
    cmd,
  ]);

  const output = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`Command failed: ${cmd}\nExit code: ${exitCode}\nStderr: ${stderr}`);
  }

  return output;
}

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

async function getLogsSince(since: string): Promise<LogEntry[]> {
  const proc = Bun.spawn([
    "docker",
    "compose",
    "-f",
    "docker-compose.e2e.yml",
    "logs",
    "--since",
    since,
    "--no-log-prefix",
    "opml",
  ]);

  const output = await new Response(proc.stdout).text();
  const status = await proc.exited;

  if (status !== 0) throw new Error(`docker compose logs failed: ${status}`);

  return output
    .trim()
    .split("\n")
    .map((line) => stripAnsi(line))
    .filter((line) => line.startsWith("{"))
    .map((line) => {
      try {
        return logEntrySchema.parse(JSON.parse(line));
      } catch {
        return null;
      }
    })
    .filter((e): e is LogEntry => e !== null);
}

async function waitForProcessing(ms: number = 2000): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function dataExists(relativePath: string): Promise<boolean> {
  try {
    const response = await fetch(`${BASE_URL}/${relativePath}`);

    return response.ok;
  } catch {
    return false;
  }
}

function findEvents(logs: LogEntry[], eventTag: string, pathContains?: string): LogEntry[] {
  return logs.filter((e) => {
    if (e.event_tag !== eventTag) return false;

    if (pathContains && (!e.path || !e.path.includes(pathContains))) return false;

    return true;
  });
}

function findHandlerEvents(logs: LogEntry[], eventTag: string, pathContains?: string): LogEntry[] {
  return logs.filter((e) => {
    if (e.event_tag !== eventTag) return false;

    if (!e.event_type || !["handler_start", "handler_complete"].includes(e.event_type))
      return false;

    if (pathContains && (!e.path || !e.path.includes(pathContains))) return false;

    return true;
  });
}

function getDockerTimestamp(): string {
  return new Date().toISOString();
}

const publicationParser = new XMLParser({ ignoreAttributes: false });

const publishedPodcastSchema = z.object({
  rss: z.object({
    channel: z.object({ item: z.object({ guid: z.object({ "#text": z.string() }) }) }),
  }),
});

const publishedOpmlSchema = z.object({
  opml: z.object({ body: z.object({ outline: z.array(z.object({ "@_xmlUrl": z.string() })) }) }),
});

async function opmlPaths(): Promise<string[]> {
  const response = await fetch(`${BASE_URL}/feed.opml`);

  if (response.status !== 200) throw new Error(`OPML request failed: ${response.status}`);
  const opml = publishedOpmlSchema.parse(publicationParser.parse(await response.text()));

  return opml.opml.body.outline.map((outline) => new URL(outline["@_xmlUrl"]).pathname).sort();
}

async function waitForHandlerCompletion(
  since: string,
  path: string,
  tag = "SourcePathSyncRequested",
): Promise<LogEntry[]> {
  const deadline = Date.now() + 10_000;

  while (Date.now() < deadline) {
    const logs = await getLogsSince(since);

    if (
      logs.some(
        (entry) =>
          entry.event_tag === tag && entry.path === path && entry.event_type === "handler_complete",
      )
    )
      return logs;
    await Bun.sleep(50);
  }

  throw new Error(`${tag} handler did not complete: ${path}`);
}

function sourceTrace(logs: LogEntry[], path: string): string[] {
  const events = logs.flatMap((entry) =>
    entry.event_tag === "SourcePathSyncRequested" &&
    entry.path === path &&
    (entry.event_type === "handler_start" || entry.event_type === "handler_complete")
      ? [entry.event_type]
      : [],
  );

  return [...new Set(events)].sort();
}

async function waitForPodcast(
  path: string,
  expectedGuid: string,
): Promise<{ status: number; guid: string }> {
  const deadline = Date.now() + 10_000;

  while (Date.now() < deadline) {
    const response = await fetch(`${BASE_URL}${path}`);

    if (response.status === 200) {
      const podcast = publishedPodcastSchema.parse(publicationParser.parse(await response.text()));
      const guid = podcast.rss.channel.item.guid["#text"];

      if (guid === expectedGuid && (await opmlPaths()).includes(path))
        return { status: response.status, guid };
    }

    await Bun.sleep(50);
  }

  throw new Error(`Podcast did not publish ${expectedGuid}: ${path}`);
}

async function waitForPodcastRemoval(path: string): Promise<number> {
  const deadline = Date.now() + 10_000;

  while (Date.now() < deadline) {
    const response = await fetch(`${BASE_URL}${path}`);

    if (response.status === 404 && !(await opmlPaths()).includes(path)) return response.status;
    await Bun.sleep(50);
  }

  throw new Error(`Obsolete podcast remains published: ${path}`);
}

describe("Event Logging E2E", () => {
  beforeAll(
    async () => {
      await execInContainer(
        `rm -rf ${AUDIOBOOKS_DIR}/${TEST_FOLDER} ${AUDIOBOOKS_DIR}/${TEST_FOLDER}-copy ${AUDIOBOOKS_DIR}/${TEST_FOLDER}-duplicate ${AUDIOBOOKS_DIR}/test-events-audio1.mp3 ${AUDIOBOOKS_DIR}/test-events-audio3.mp3`,
      );
      await waitForProcessing(10000);
    },
    { timeout: 15000 },
  );

  afterAll(async () => {
    await execInContainer(
      `rm -rf ${AUDIOBOOKS_DIR}/${TEST_FOLDER} ${AUDIOBOOKS_DIR}/${TEST_FOLDER}-copy ${AUDIOBOOKS_DIR}/${TEST_FOLDER}-duplicate ${AUDIOBOOKS_DIR}/test-events-audio1.mp3 ${AUDIOBOOKS_DIR}/test-events-audio3.mp3`,
    );
  });

  describe("Phase 1: Setup", () => {
    test("create an empty folder completes a current-source hint without publishing a podcast", async () => {
      // #given
      const before = getDockerTimestamp();

      // #when
      await execInContainer(`mkdir -p ${AUDIOBOOKS_DIR}/${TEST_FOLDER}`);

      const logs = await waitForHandlerCompletion(
        before,
        "/data/test-events",
        "FolderMetaSyncRequested",
      );

      const response = await fetch(`${BASE_URL}/test-events/feed.xml`);

      // #then
      expect({
        trace: sourceTrace(logs, "/audiobooks/test-events"),
        rss: response.status,
        paths: await opmlPaths(),
      }).toEqual({
        trace: ["handler_complete", "handler_start"],
        rss: 404,
        paths: [
          "/test/Test%20Author/Test%20Audiobook/feed.xml",
          "/test/Untagged%20Podcast/feed.xml",
        ],
      });
    }, 15_000);

    test("an empty source folder remains outside the published Catalog", async () => {
      // #given
      const path = "/test-events/feed.xml";

      // #when
      await waitForHandlerCompletion(
        "1970-01-01T00:00:00Z",
        "/data/test-events",
        "FolderMetaSyncRequested",
      );
      const status = await waitForPodcastRemoval(path);

      // #then
      expect({ status, paths: await opmlPaths() }).toEqual({
        status: 404,
        paths: [
          "/test/Test%20Author/Test%20Audiobook/feed.xml",
          "/test/Untagged%20Podcast/feed.xml",
        ],
      });
    }, 15_000);
  });

  describe("Phase 2: Adding audio files", () => {
    test("add audio1 triggers AudioFileCreated event", async () => {
      const before = getDockerTimestamp();

      await execInContainer(
        `cp "${FIXTURE_MP3}" "${AUDIOBOOKS_DIR}/${TEST_FOLDER}/test-events-audio1.mp3"`,
      );
      await waitForProcessing(3000);

      const logs = await getLogsSince(before);

      const audioCreatedLogs = findEvents(logs, "AudioFileCreated", "test-events-audio1.mp3");
      expect(audioCreatedLogs.length).toBeGreaterThan(0);

      const handlerLogs = findHandlerEvents(logs, "AudioFileCreated", "test-events-audio1.mp3");
      expect(handlerLogs.some((e) => e.event_type === "handler_start")).toBe(true);
      expect(handlerLogs.some((e) => e.event_type === "handler_complete")).toBe(true);
    });

    test("audio1 data structure is created", async () => {
      const entryExists = await dataExists(`${TEST_FOLDER}/test-events-audio1.mp3/entry.xml`);
      expect(entryExists).toBe(true);
    });

    test("add audio2 triggers AudioFileCreated event", async () => {
      const before = getDockerTimestamp();

      await execInContainer(
        `cp "${FIXTURE_MP3}" "${AUDIOBOOKS_DIR}/${TEST_FOLDER}/test-events-audio2.mp3"`,
      );
      await waitForProcessing(3000);

      const logs = await getLogsSince(before);

      const audioCreatedLogs = findEvents(logs, "AudioFileCreated", "test-events-audio2.mp3");
      expect(audioCreatedLogs.length).toBeGreaterThan(0);
    });

    test("feed.xml contains both audio files", async () => {
      const response = await fetch(`${BASE_URL}/${TEST_FOLDER}/feed.xml`);
      expect(response.ok).toBe(true);
      const xml = await response.text();
      expect(xml).toContain("test-events-audio1.mp3");
      expect(xml).toContain("test-events-audio2.mp3");
    });
  });

  describe("Phase 3: Audio file operations", () => {
    test("move audio1 to root triggers AudioFileDeleted + AudioFileCreated", async () => {
      const before = getDockerTimestamp();

      await execInContainer(
        `mv "${AUDIOBOOKS_DIR}/${TEST_FOLDER}/test-events-audio1.mp3" "${AUDIOBOOKS_DIR}/test-events-audio1.mp3"`,
      );
      await waitForProcessing(3000);

      const logs = await getLogsSince(before);

      const deletedLogs = findEvents(logs, "AudioFileDeleted", "test-events-audio1.mp3");
      expect(deletedLogs.length).toBeGreaterThan(0);

      const createdLogs = findEvents(logs, "AudioFileCreated", "test-events-audio1.mp3");
      expect(createdLogs.length).toBeGreaterThan(0);
    });

    test("rename audio1 to audio3 triggers AudioFileDeleted + AudioFileCreated", async () => {
      const before = getDockerTimestamp();

      await execInContainer(
        `mv "${AUDIOBOOKS_DIR}/test-events-audio1.mp3" "${AUDIOBOOKS_DIR}/test-events-audio3.mp3"`,
      );
      await waitForProcessing(3000);

      const logs = await getLogsSince(before);

      const deletedLogs = findEvents(logs, "AudioFileDeleted", "test-events-audio1.mp3");
      expect(deletedLogs.length).toBeGreaterThan(0);

      const createdLogs = findEvents(logs, "AudioFileCreated", "test-events-audio3.mp3");
      expect(createdLogs.length).toBeGreaterThan(0);
    });

    test("copy audio3 to audio1 triggers AudioFileCreated", async () => {
      const before = getDockerTimestamp();

      await execInContainer(
        `cp "${AUDIOBOOKS_DIR}/test-events-audio3.mp3" "${AUDIOBOOKS_DIR}/test-events-audio1.mp3"`,
      );
      await waitForProcessing(3000);

      const logs = await getLogsSince(before);

      const createdLogs = findEvents(logs, "AudioFileCreated", "test-events-audio1.mp3");
      expect(createdLogs.length).toBeGreaterThan(0);
    });

    test("delete audio1 and audio3 triggers AudioFileDeleted", async () => {
      const before = getDockerTimestamp();

      await execInContainer(
        `rm "${AUDIOBOOKS_DIR}/test-events-audio1.mp3" "${AUDIOBOOKS_DIR}/test-events-audio3.mp3"`,
      );
      await waitForProcessing(3000);

      const logs = await getLogsSince(before);

      const deleted1 = findEvents(logs, "AudioFileDeleted", "test-events-audio1.mp3");
      const deleted3 = findEvents(logs, "AudioFileDeleted", "test-events-audio3.mp3");
      expect(deleted1.length).toBeGreaterThan(0);
      expect(deleted3.length).toBeGreaterThan(0);
    });
  });

  describe("Phase 4: Folder operations", () => {
    test(
      "copy folder reconciles current descendants and publishes new Episode identities",
      async () => {
        // #given
        const before = getDockerTimestamp();

        // #when
        await execInContainer(
          `cp -r "${AUDIOBOOKS_DIR}/${TEST_FOLDER}" "${AUDIOBOOKS_DIR}/${TEST_FOLDER}-copy"`,
        );

        const podcast = await waitForPodcast(
          "/test-events-copy/feed.xml",
          "test-events-copy/test-events-audio2.mp3",
        );

        const logs = await waitForHandlerCompletion(before, "/audiobooks/test-events-copy");

        // #then
        expect({
          podcast,
          trace: sourceTrace(logs, "/audiobooks/test-events-copy"),
          paths: await opmlPaths(),
        }).toEqual({
          podcast: { status: 200, guid: "test-events-copy/test-events-audio2.mp3" },
          trace: ["handler_complete", "handler_start"],
          paths: [
            "/test-events-copy/feed.xml",
            "/test-events/feed.xml",
            "/test/Test%20Author/Test%20Audiobook/feed.xml",
            "/test/Untagged%20Podcast/feed.xml",
          ],
        });
      },
      { timeout: 15000 },
    );

    test("rename folder replaces the old Podcast URL and Episode identity with current paths", async () => {
      // #given
      const before = getDockerTimestamp();

      // #when
      await execInContainer(
        `mv "${AUDIOBOOKS_DIR}/${TEST_FOLDER}-copy" "${AUDIOBOOKS_DIR}/${TEST_FOLDER}-duplicate"`,
      );

      const podcast = await waitForPodcast(
        "/test-events-duplicate/feed.xml",
        "test-events-duplicate/test-events-audio2.mp3",
      );

      const removed = await waitForPodcastRemoval("/test-events-copy/feed.xml");
      const logs = await waitForHandlerCompletion(before, "/audiobooks/test-events-duplicate");

      // #then
      expect({
        podcast,
        removed,
        from: sourceTrace(logs, "/audiobooks/test-events-copy"),
        to: sourceTrace(logs, "/audiobooks/test-events-duplicate"),
        paths: await opmlPaths(),
      }).toEqual({
        podcast: { status: 200, guid: "test-events-duplicate/test-events-audio2.mp3" },
        removed: 404,
        from: ["handler_complete", "handler_start"],
        to: ["handler_complete", "handler_start"],
        paths: [
          "/test-events-duplicate/feed.xml",
          "/test-events/feed.xml",
          "/test/Test%20Author/Test%20Audiobook/feed.xml",
          "/test/Untagged%20Podcast/feed.xml",
        ],
      });
    }, 25_000);

    test("move folder into another triggers events", async () => {
      const before = getDockerTimestamp();

      await execInContainer(
        `mv "${AUDIOBOOKS_DIR}/${TEST_FOLDER}-duplicate" "${AUDIOBOOKS_DIR}/${TEST_FOLDER}/${TEST_FOLDER}-duplicate"`,
      );
      await waitForProcessing(3000);

      const logs = await getLogsSince(before);

      const folderLogs = logs.filter(
        (e) => e.event_tag?.includes("Folder") && e.path?.includes("duplicate"),
      );

      expect(folderLogs.length).toBeGreaterThan(0);
    });
  });

  describe("Phase 5: Cleanup", () => {
    test(
      "delete folder with contents triggers FolderDeleted + AudioFileDeleted",
      async () => {
        const before = getDockerTimestamp();

        await execInContainer(`rm -rf "${AUDIOBOOKS_DIR}/${TEST_FOLDER}"`);
        await waitForProcessing(5000);

        const logs = await getLogsSince(before);

        const folderDeleted = findEvents(logs, "FolderDeleted", TEST_FOLDER);
        expect(folderDeleted.length).toBeGreaterThan(0);

        const audioDeleted = logs.filter((e) => e.event_tag === "AudioFileDeleted");
        expect(audioDeleted.length).toBeGreaterThan(0);
      },
      { timeout: 15000 },
    );

    test("data structure is cleaned up", async () => {
      const feedExists = await dataExists(`${TEST_FOLDER}/feed.xml`);
      expect(feedExists).toBe(false);
    });
  });
});
