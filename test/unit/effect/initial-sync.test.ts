import { describe, test, expect, beforeEach } from "bun:test";
import { folderSync } from "../../../src/effect/handlers/folder-sync.ts";
import { folderCleanup } from "../../../src/effect/handlers/folder-cleanup.ts";
import { audioCleanup } from "../../../src/effect/handlers/audio-cleanup.ts";
import type { HandlerDeps } from "../../../src/context.ts";
import type { EventType } from "../../../src/effect/types.ts";

interface MockFs {
  mkdirCalls: Array<{ path: string; options?: { recursive?: boolean } }>;
  rmCalls: Array<{ path: string; options?: { recursive?: boolean } }>;
  writeCalls: Array<{ path: string; content: string }>;
  reset: () => void;
}

interface MockLogger {
  infoCalls: Array<{ tag: string; msg: string }>;
  reset: () => void;
}

const createMockFs = (): MockFs => ({
  mkdirCalls: [],
  rmCalls: [],
  writeCalls: [],
  reset() {
    this.mkdirCalls = [];
    this.rmCalls = [];
    this.writeCalls = [];
  },
});

const createMockLogger = (): MockLogger => ({
  infoCalls: [],
  reset() {
    this.infoCalls = [];
  },
});

const mockFs = createMockFs();
const mockLogger = createMockLogger();

function makeDeps(): HandlerDeps {
  return {
    config: { filesPath: "/test/audiobooks", dataPath: "/test/data", port: 8080, reconcileInterval: 1800 },
    logger: {
      info: (tag, msg) => {
        mockLogger.infoCalls.push({ tag, msg });
      },
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
    fs: {
      mkdir: async (path, options) => {
        mockFs.mkdirCalls.push({ path, options });
      },
      rm: async (path, options) => {
        mockFs.rmCalls.push({ path, options });
      },
      readdir: async () => [],
      stat: async () => ({ isDirectory: () => false, size: 0 }),
      exists: async () => false,
      writeFile: async (path, content) => {
        mockFs.writeCalls.push({ path, content });
      },
      atomicWrite: async (path, content) => {
        mockFs.writeCalls.push({ path, content });
      },
      symlink: async () => {},
      unlink: async () => {},
    },
  };
}

const folderCreatedEvent = (parent: string, name: string): EventType => ({
  _tag: "FolderCreated",
  parent,
  name,
});

const folderDeletedEvent = (parent: string, name: string): EventType => ({
  _tag: "FolderDeleted",
  parent,
  name,
});

const audioFileDeletedEvent = (parent: string, name: string): EventType => ({
  _tag: "AudioFileDeleted",
  parent,
  name,
});

describe("Initial Sync - Folder and Cleanup Handlers", () => {
  beforeEach(() => {
    mockFs.reset();
    mockLogger.reset();
  });

  describe("folderSync during initial sync", () => {
    test("creates folder data directory", async () => {
      // #when
      await folderSync(folderCreatedEvent("/test/audiobooks/", "Fiction"), makeDeps());
      // #then
      expect(mockFs.mkdirCalls.some((c) => c.path === "/test/data/Fiction")).toBe(true);
    });

    test("generates _entry.xml for folder", async () => {
      // #when
      await folderSync(folderCreatedEvent("/test/audiobooks/", "Fiction"), makeDeps());
      // #then
      const entryWrite = mockFs.writeCalls.find((c) => c.path.endsWith("_entry.xml"));
      expect(entryWrite).toBeDefined();
      expect(entryWrite?.content).toContain("<folder>");
    });

    test("processes nested folder paths correctly", async () => {
      // #when
      await folderSync(folderCreatedEvent("/test/audiobooks/Fiction/", "SciFi"), makeDeps());
      // #then
      expect(mockFs.mkdirCalls.some((c) => c.path === "/test/data/Fiction/SciFi")).toBe(true);
    });
  });

  describe("folderCleanup during initial sync", () => {
    test("removes orphan folder directory", async () => {
      // #when
      await folderCleanup(folderDeletedEvent("/test/audiobooks/", "OldFolder"), makeDeps());
      // #then
      expect(mockFs.rmCalls).toHaveLength(1);
      expect(mockFs.rmCalls[0]!.path).toBe("/test/data/OldFolder");
    });
  });

  describe("audioCleanup during initial sync", () => {
    test("removes orphan audio file directory", async () => {
      // #when
      await audioCleanup(audioFileDeletedEvent("/test/audiobooks/Fiction/", "deleted.mp3"), makeDeps());
      // #then
      expect(mockFs.rmCalls).toHaveLength(1);
      expect(mockFs.rmCalls[0]!.path).toBe("/test/data/Fiction/deleted.mp3");
    });
  });

  describe("sync flow simulation", () => {
    test("processes multiple folders sequentially", async () => {
      // #given
      const folders = ["Fiction", "NonFiction", "Podcasts"];
      const deps = makeDeps();
      // #when
      for (const folder of folders) {
        await folderSync(folderCreatedEvent("/test/audiobooks/", folder), deps);
      }
      // #then
      const entryWrites = mockFs.writeCalls.filter((c) => c.path.endsWith("_entry.xml"));
      expect(entryWrites).toHaveLength(3);
    });

    test("cleanup then create for folder replacement", async () => {
      // #given
      const deps = makeDeps();
      // #when
      await folderCleanup(folderDeletedEvent("/test/audiobooks/", "OldFolder"), deps);
      await folderSync(folderCreatedEvent("/test/audiobooks/", "NewFolder"), deps);
      // #then
      expect(mockFs.rmCalls.some((c) => c.path.includes("OldFolder"))).toBe(true);
      expect(mockFs.mkdirCalls.some((c) => c.path.includes("NewFolder"))).toBe(true);
    });

    test("logs operations for each handler", async () => {
      // #given
      const deps = makeDeps();
      // #when
      await folderSync(folderCreatedEvent("/test/audiobooks/", "Fiction"), deps);
      await audioCleanup(audioFileDeletedEvent("/test/audiobooks/Fiction/", "old.mp3"), deps);
      // #then
      expect(mockLogger.infoCalls.some((c) => c.tag === "FolderSync")).toBe(true);
      expect(mockLogger.infoCalls.some((c) => c.tag === "AudioCleanup")).toBe(true);
    });
  });
});
