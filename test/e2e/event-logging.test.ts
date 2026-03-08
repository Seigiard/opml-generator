import { describe, test, expect, beforeAll, afterAll } from "bun:test";

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:8080";

// Container paths
const BOOKS_DIR = "/books";
const TEST_FOLDER = "test-events";
const FIXTURE_PDF = "/books/test/Test Book - Test Author.pdf";

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

// Helper: execute command inside container
async function execInContainer(cmd: string): Promise<string> {
  const proc = Bun.spawn(["docker", "compose", "-f", "docker-compose.e2e.yml", "exec", "-T", "opds", "sh", "-c", cmd]);
  const output = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`Command failed: ${cmd}\nExit code: ${exitCode}\nStderr: ${stderr}`);
  }
  return output;
}

// Helper: strip ANSI color codes from string
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

// Helper: get logs from docker container since timestamp
async function getLogsSince(since: string): Promise<LogEntry[]> {
  const proc = Bun.spawn(["docker", "compose", "-f", "docker-compose.e2e.yml", "logs", "--since", since, "--no-log-prefix", "opds"]);
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

// Helper: wait for events to be processed
async function waitForProcessing(ms: number = 2000): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// Helper: check if file exists in /data
async function dataExists(relativePath: string): Promise<boolean> {
  try {
    const response = await fetch(`${BASE_URL}/${relativePath}`);
    return response.ok;
  } catch {
    return false;
  }
}

// Helper: find events by tag and path
function findEvents(logs: LogEntry[], eventTag: string, pathContains?: string): LogEntry[] {
  return logs.filter((e) => {
    if (e.event_tag !== eventTag) return false;
    if (pathContains && (!e.path || !e.path.includes(pathContains))) return false;
    return true;
  });
}

// Helper: find handler events (start/complete)
function findHandlerEvents(logs: LogEntry[], eventTag: string, pathContains?: string): LogEntry[] {
  return logs.filter((e) => {
    if (e.event_tag !== eventTag) return false;
    if (!e.event_type || !["handler_start", "handler_complete"].includes(e.event_type)) return false;
    if (pathContains && (!e.path || !e.path.includes(pathContains))) return false;
    return true;
  });
}

// Helper: get timestamp for docker logs --since flag
function getDockerTimestamp(): string {
  // Docker expects RFC3339 or relative time
  return new Date().toISOString();
}

describe("Event Logging E2E", () => {
  beforeAll(
    async () => {
      // Ensure test folders don't exist (cleanup from previous runs)
      await execInContainer(
        `rm -rf ${BOOKS_DIR}/${TEST_FOLDER} ${BOOKS_DIR}/${TEST_FOLDER}-copy ${BOOKS_DIR}/${TEST_FOLDER}-duplicate ${BOOKS_DIR}/test-events-book1.pdf ${BOOKS_DIR}/test-events-book3.pdf`,
      );
      // Wait for initial sync AND cleanup events to be processed
      // The consumer may still be processing initial sync events when container becomes healthy
      await waitForProcessing(10000);
    },
    { timeout: 15000 },
  );

  afterAll(async () => {
    // Cleanup all test artifacts
    await execInContainer(
      `rm -rf ${BOOKS_DIR}/${TEST_FOLDER} ${BOOKS_DIR}/${TEST_FOLDER}-copy ${BOOKS_DIR}/${TEST_FOLDER}-duplicate ${BOOKS_DIR}/test-events-book1.pdf ${BOOKS_DIR}/test-events-book3.pdf`,
    );
  });

  describe("Phase 1: Setup", () => {
    test("create folder triggers FolderCreated event", async () => {
      const before = getDockerTimestamp();

      // Create test folder inside container
      await execInContainer(`mkdir -p ${BOOKS_DIR}/${TEST_FOLDER}`);
      await waitForProcessing(3000);

      const logs = await getLogsSince(before);

      // Should have FolderCreated event
      const folderCreatedLogs = findEvents(logs, "FolderCreated", TEST_FOLDER);
      expect(folderCreatedLogs.length).toBeGreaterThan(0);

      // Should have handler_start and handler_complete for FolderCreated
      const handlerLogs = findHandlerEvents(logs, "FolderCreated", TEST_FOLDER);
      expect(handlerLogs.some((e) => e.event_type === "handler_start")).toBe(true);
      expect(handlerLogs.some((e) => e.event_type === "handler_complete")).toBe(true);
    });

    test("folder data structure is created", async () => {
      // /data/test-events/feed.xml should exist
      const feedExists = await dataExists(`${TEST_FOLDER}/feed.xml`);
      expect(feedExists).toBe(true);
    });
  });

  describe("Phase 2: Adding books", () => {
    test("add book1 triggers AudioFileCreated event", async () => {
      const before = getDockerTimestamp();

      // Copy PDF to test folder inside container
      await execInContainer(`cp "${FIXTURE_PDF}" "${BOOKS_DIR}/${TEST_FOLDER}/test-events-book1.pdf"`);
      await waitForProcessing(3000); // PDF processing takes longer

      const logs = await getLogsSince(before);

      // Should have AudioFileCreated event
      const bookCreatedLogs = findEvents(logs, "AudioFileCreated", "test-events-book1.pdf");
      expect(bookCreatedLogs.length).toBeGreaterThan(0);

      // Should have handler events
      const handlerLogs = findHandlerEvents(logs, "AudioFileCreated", "test-events-book1.pdf");
      expect(handlerLogs.some((e) => e.event_type === "handler_start")).toBe(true);
      expect(handlerLogs.some((e) => e.event_type === "handler_complete")).toBe(true);
    });

    test("book1 data structure is created", async () => {
      // entry.xml should exist
      const entryExists = await dataExists(`${TEST_FOLDER}/test-events-book1.pdf/entry.xml`);
      expect(entryExists).toBe(true);
    });

    test("add book2 triggers AudioFileCreated event", async () => {
      const before = getDockerTimestamp();

      // Copy another PDF inside container
      await execInContainer(`cp "${FIXTURE_PDF}" "${BOOKS_DIR}/${TEST_FOLDER}/test-events-book2.pdf"`);
      await waitForProcessing(3000);

      const logs = await getLogsSince(before);

      // Should have AudioFileCreated event
      const bookCreatedLogs = findEvents(logs, "AudioFileCreated", "test-events-book2.pdf");
      expect(bookCreatedLogs.length).toBeGreaterThan(0);
    });

    test("feed.xml contains both books", async () => {
      const response = await fetch(`${BASE_URL}/${TEST_FOLDER}/feed.xml`);
      expect(response.ok).toBe(true);
      const xml = await response.text();
      expect(xml).toContain("test-events-book1.pdf");
      expect(xml).toContain("test-events-book2.pdf");
    });
  });

  describe("Phase 3: Book operations", () => {
    test("move book1 to root triggers AudioFileDeleted + AudioFileCreated", async () => {
      const before = getDockerTimestamp();

      // Move book1 from test-events/ to root inside container
      await execInContainer(`mv "${BOOKS_DIR}/${TEST_FOLDER}/test-events-book1.pdf" "${BOOKS_DIR}/test-events-book1.pdf"`);
      await waitForProcessing(3000);

      const logs = await getLogsSince(before);

      // Should have AudioFileDeleted from folder
      const deletedLogs = findEvents(logs, "AudioFileDeleted", "test-events-book1.pdf");
      expect(deletedLogs.length).toBeGreaterThan(0);

      // Should have AudioFileCreated in root
      const createdLogs = findEvents(logs, "AudioFileCreated", "test-events-book1.pdf");
      expect(createdLogs.length).toBeGreaterThan(0);
    });

    test("rename book1 to book3 triggers AudioFileDeleted + AudioFileCreated", async () => {
      const before = getDockerTimestamp();

      // Rename in root inside container
      await execInContainer(`mv "${BOOKS_DIR}/test-events-book1.pdf" "${BOOKS_DIR}/test-events-book3.pdf"`);
      await waitForProcessing(3000);

      const logs = await getLogsSince(before);

      // Should have AudioFileDeleted for book1
      const deletedLogs = findEvents(logs, "AudioFileDeleted", "test-events-book1.pdf");
      expect(deletedLogs.length).toBeGreaterThan(0);

      // Should have AudioFileCreated for book3
      const createdLogs = findEvents(logs, "AudioFileCreated", "test-events-book3.pdf");
      expect(createdLogs.length).toBeGreaterThan(0);
    });

    test("copy book3 to book1 triggers AudioFileCreated", async () => {
      const before = getDockerTimestamp();

      // Copy back inside container
      await execInContainer(`cp "${BOOKS_DIR}/test-events-book3.pdf" "${BOOKS_DIR}/test-events-book1.pdf"`);
      await waitForProcessing(3000);

      const logs = await getLogsSince(before);

      // Should have AudioFileCreated for book1
      const createdLogs = findEvents(logs, "AudioFileCreated", "test-events-book1.pdf");
      expect(createdLogs.length).toBeGreaterThan(0);
    });

    test("delete book1 and book3 triggers AudioFileDeleted", async () => {
      const before = getDockerTimestamp();

      // Delete both books inside container
      await execInContainer(`rm "${BOOKS_DIR}/test-events-book1.pdf" "${BOOKS_DIR}/test-events-book3.pdf"`);
      await waitForProcessing(3000);

      const logs = await getLogsSince(before);

      // Should have AudioFileDeleted for both
      const deleted1 = findEvents(logs, "AudioFileDeleted", "test-events-book1.pdf");
      const deleted3 = findEvents(logs, "AudioFileDeleted", "test-events-book3.pdf");
      expect(deleted1.length).toBeGreaterThan(0);
      expect(deleted3.length).toBeGreaterThan(0);
    });
  });

  describe("Phase 4: Folder operations", () => {
    test(
      "copy folder triggers FolderCreated + AudioFileCreated for contents",
      async () => {
        const before = getDockerTimestamp();

        // Copy folder inside container
        await execInContainer(`cp -r "${BOOKS_DIR}/${TEST_FOLDER}" "${BOOKS_DIR}/${TEST_FOLDER}-copy"`);
        await waitForProcessing(5000);

        const logs = await getLogsSince(before);

        // Should have FolderCreated
        const folderCreated = findEvents(logs, "FolderCreated", `${TEST_FOLDER}-copy`);
        expect(folderCreated.length).toBeGreaterThan(0);

        // Should have AudioFileCreated for book2 (the only book left in folder)
        const bookCreated = findEvents(logs, "AudioFileCreated", "test-events-book2.pdf");
        expect(bookCreated.length).toBeGreaterThan(0);
      },
      { timeout: 15000 },
    );

    test("rename folder triggers FolderDeleted + FolderCreated", async () => {
      const before = getDockerTimestamp();

      // Rename folder inside container
      await execInContainer(`mv "${BOOKS_DIR}/${TEST_FOLDER}-copy" "${BOOKS_DIR}/${TEST_FOLDER}-duplicate"`);
      await waitForProcessing(3000);

      const logs = await getLogsSince(before);

      // Should have FolderDeleted for -copy
      const deleted = findEvents(logs, "FolderDeleted", `${TEST_FOLDER}-copy`);
      expect(deleted.length).toBeGreaterThan(0);

      // Should have FolderCreated for -duplicate
      const created = findEvents(logs, "FolderCreated", `${TEST_FOLDER}-duplicate`);
      expect(created.length).toBeGreaterThan(0);
    });

    test("move folder into another triggers events", async () => {
      const before = getDockerTimestamp();

      // Move -duplicate into test-events inside container
      await execInContainer(`mv "${BOOKS_DIR}/${TEST_FOLDER}-duplicate" "${BOOKS_DIR}/${TEST_FOLDER}/${TEST_FOLDER}-duplicate"`);
      await waitForProcessing(3000);

      const logs = await getLogsSince(before);

      // Should have some folder events
      const folderLogs = logs.filter((e) => e.event_tag?.includes("Folder") && e.path?.includes("duplicate"));
      expect(folderLogs.length).toBeGreaterThan(0);
    });
  });

  describe("Phase 5: Cleanup", () => {
    test(
      "delete folder with contents triggers FolderDeleted + AudioFileDeleted",
      async () => {
        const before = getDockerTimestamp();

        // Delete entire test folder inside container
        await execInContainer(`rm -rf "${BOOKS_DIR}/${TEST_FOLDER}"`);
        await waitForProcessing(5000);

        const logs = await getLogsSince(before);

        // Should have FolderDeleted
        const folderDeleted = findEvents(logs, "FolderDeleted", TEST_FOLDER);
        expect(folderDeleted.length).toBeGreaterThan(0);

        // Should have AudioFileDeleted for remaining books
        const bookDeleted = logs.filter((e) => e.event_tag === "AudioFileDeleted");
        expect(bookDeleted.length).toBeGreaterThan(0);
      },
      { timeout: 15000 },
    );

    test("data structure is cleaned up", async () => {
      // /data/test-events/ should not exist
      const feedExists = await dataExists(`${TEST_FOLDER}/feed.xml`);
      expect(feedExists).toBe(false);
    });
  });
});
