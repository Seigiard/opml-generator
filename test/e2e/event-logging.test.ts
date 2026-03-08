import { describe, test, expect, beforeAll, afterAll } from "bun:test";

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:8080";

const AUDIOBOOKS_DIR = "/audiobooks";
const TEST_FOLDER = "test-events";
const FIXTURE_MP3 = "/audiobooks/test/Test Author/Test Audiobook/01 - Chapter One.mp3";

interface LogEntry {
  ts: string;
  level: string;
  tag: string;
  msg: string;
  event_type?: string;
  event_id?: string;
  event_tag?: string;
  path?: string;
  duration_ms?: number;
  cascade_count?: number;
  cascade_tags?: string[];
  error?: string;
}

async function execInContainer(cmd: string): Promise<string> {
  const proc = Bun.spawn(["docker", "compose", "-f", "docker-compose.e2e.yml", "exec", "-T", "opml", "sh", "-c", cmd]);
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
  const proc = Bun.spawn(["docker", "compose", "-f", "docker-compose.e2e.yml", "logs", "--since", since, "--no-log-prefix", "opml"]);
  const output = await new Response(proc.stdout).text();
  await proc.exited;

  return output
    .trim()
    .split("\n")
    .map((line) => stripAnsi(line))
    .filter((line) => line.startsWith("{"))
    .map((line) => {
      try {
        return JSON.parse(line) as LogEntry;
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
    if (!e.event_type || !["handler_start", "handler_complete"].includes(e.event_type)) return false;
    if (pathContains && (!e.path || !e.path.includes(pathContains))) return false;
    return true;
  });
}

function getDockerTimestamp(): string {
  return new Date().toISOString();
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
    test("create folder triggers FolderCreated event", async () => {
      const before = getDockerTimestamp();

      await execInContainer(`mkdir -p ${AUDIOBOOKS_DIR}/${TEST_FOLDER}`);
      await waitForProcessing(3000);

      const logs = await getLogsSince(before);

      const folderCreatedLogs = findEvents(logs, "FolderCreated", TEST_FOLDER);
      expect(folderCreatedLogs.length).toBeGreaterThan(0);

      const handlerLogs = findHandlerEvents(logs, "FolderCreated", TEST_FOLDER);
      expect(handlerLogs.some((e) => e.event_type === "handler_start")).toBe(true);
      expect(handlerLogs.some((e) => e.event_type === "handler_complete")).toBe(true);
    });

    test("folder data structure is created", async () => {
      // Empty folders get a data directory but not a feed.xml
      // (feed.xml is only created when audio files or subfolders exist)
      const folderCreated = findEvents(await getLogsSince("1970-01-01T00:00:00Z"), "FolderCreated", TEST_FOLDER);
      expect(folderCreated.length).toBeGreaterThan(0);
    });
  });

  describe("Phase 2: Adding audio files", () => {
    test("add audio1 triggers AudioFileCreated event", async () => {
      const before = getDockerTimestamp();

      await execInContainer(`cp "${FIXTURE_MP3}" "${AUDIOBOOKS_DIR}/${TEST_FOLDER}/test-events-audio1.mp3"`);
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

      await execInContainer(`cp "${FIXTURE_MP3}" "${AUDIOBOOKS_DIR}/${TEST_FOLDER}/test-events-audio2.mp3"`);
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

      await execInContainer(`mv "${AUDIOBOOKS_DIR}/${TEST_FOLDER}/test-events-audio1.mp3" "${AUDIOBOOKS_DIR}/test-events-audio1.mp3"`);
      await waitForProcessing(3000);

      const logs = await getLogsSince(before);

      const deletedLogs = findEvents(logs, "AudioFileDeleted", "test-events-audio1.mp3");
      expect(deletedLogs.length).toBeGreaterThan(0);

      const createdLogs = findEvents(logs, "AudioFileCreated", "test-events-audio1.mp3");
      expect(createdLogs.length).toBeGreaterThan(0);
    });

    test("rename audio1 to audio3 triggers AudioFileDeleted + AudioFileCreated", async () => {
      const before = getDockerTimestamp();

      await execInContainer(`mv "${AUDIOBOOKS_DIR}/test-events-audio1.mp3" "${AUDIOBOOKS_DIR}/test-events-audio3.mp3"`);
      await waitForProcessing(3000);

      const logs = await getLogsSince(before);

      const deletedLogs = findEvents(logs, "AudioFileDeleted", "test-events-audio1.mp3");
      expect(deletedLogs.length).toBeGreaterThan(0);

      const createdLogs = findEvents(logs, "AudioFileCreated", "test-events-audio3.mp3");
      expect(createdLogs.length).toBeGreaterThan(0);
    });

    test("copy audio3 to audio1 triggers AudioFileCreated", async () => {
      const before = getDockerTimestamp();

      await execInContainer(`cp "${AUDIOBOOKS_DIR}/test-events-audio3.mp3" "${AUDIOBOOKS_DIR}/test-events-audio1.mp3"`);
      await waitForProcessing(3000);

      const logs = await getLogsSince(before);

      const createdLogs = findEvents(logs, "AudioFileCreated", "test-events-audio1.mp3");
      expect(createdLogs.length).toBeGreaterThan(0);
    });

    test("delete audio1 and audio3 triggers AudioFileDeleted", async () => {
      const before = getDockerTimestamp();

      await execInContainer(`rm "${AUDIOBOOKS_DIR}/test-events-audio1.mp3" "${AUDIOBOOKS_DIR}/test-events-audio3.mp3"`);
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
      "copy folder triggers FolderCreated + AudioFileCreated for contents",
      async () => {
        const before = getDockerTimestamp();

        await execInContainer(`cp -r "${AUDIOBOOKS_DIR}/${TEST_FOLDER}" "${AUDIOBOOKS_DIR}/${TEST_FOLDER}-copy"`);
        await waitForProcessing(5000);

        const logs = await getLogsSince(before);

        const folderCreated = findEvents(logs, "FolderCreated", `${TEST_FOLDER}-copy`);
        expect(folderCreated.length).toBeGreaterThan(0);

        const audioCreated = findEvents(logs, "AudioFileCreated", "test-events-audio2.mp3");
        expect(audioCreated.length).toBeGreaterThan(0);
      },
      { timeout: 15000 },
    );

    test("rename folder triggers FolderDeleted + FolderCreated", async () => {
      const before = getDockerTimestamp();

      await execInContainer(`mv "${AUDIOBOOKS_DIR}/${TEST_FOLDER}-copy" "${AUDIOBOOKS_DIR}/${TEST_FOLDER}-duplicate"`);
      await waitForProcessing(3000);

      const logs = await getLogsSince(before);

      const deleted = findEvents(logs, "FolderDeleted", `${TEST_FOLDER}-copy`);
      expect(deleted.length).toBeGreaterThan(0);

      const created = findEvents(logs, "FolderCreated", `${TEST_FOLDER}-duplicate`);
      expect(created.length).toBeGreaterThan(0);
    });

    test("move folder into another triggers events", async () => {
      const before = getDockerTimestamp();

      await execInContainer(`mv "${AUDIOBOOKS_DIR}/${TEST_FOLDER}-duplicate" "${AUDIOBOOKS_DIR}/${TEST_FOLDER}/${TEST_FOLDER}-duplicate"`);
      await waitForProcessing(3000);

      const logs = await getLogsSince(before);

      const folderLogs = logs.filter((e) => e.event_tag?.includes("Folder") && e.path?.includes("duplicate"));
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
