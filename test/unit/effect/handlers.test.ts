import { describe, test, expect, beforeEach } from "bun:test";
import { folderCleanup } from "../../../src/effect/handlers/folder-cleanup.ts";
import { folderSync } from "../../../src/effect/handlers/folder-sync.ts";
import { audioCleanup } from "../../../src/effect/handlers/audio-cleanup.ts";
import type { HandlerDeps } from "../../../src/context.ts";
import type { EventType } from "../../../src/effect/types.ts";
import type { LogContext } from "../../../src/logging/types.ts";

interface MockFs {
  mkdirCalls: Array<{ path: string; options?: { recursive?: boolean } }>;
  rmCalls: Array<{ path: string; options?: { recursive?: boolean } }>;
  writeCalls: Array<{ path: string; content: string }>;
  unlinkCalls: string[];
  symlinkCalls: Array<{ target: string; path: string }>;
  reset: () => void;
}

interface MockLogger {
  infoCalls: Array<{ tag: string; msg: string; ctx?: LogContext }>;
  warnCalls: Array<{ tag: string; msg: string; ctx?: LogContext }>;
  errorCalls: Array<{ tag: string; msg: string; error?: unknown }>;
  debugCalls: Array<{ tag: string; msg: string; ctx?: LogContext }>;
  reset: () => void;
}

const createMockFs = (): MockFs => ({
  mkdirCalls: [],
  rmCalls: [],
  writeCalls: [],
  unlinkCalls: [],
  symlinkCalls: [],
  reset() {
    this.mkdirCalls = [];
    this.rmCalls = [];
    this.writeCalls = [];
    this.unlinkCalls = [];
    this.symlinkCalls = [];
  },
});

const createMockLogger = (): MockLogger => ({
  infoCalls: [],
  warnCalls: [],
  errorCalls: [],
  debugCalls: [],
  reset() {
    this.infoCalls = [];
    this.warnCalls = [];
    this.errorCalls = [];
    this.debugCalls = [];
  },
});

const mockFs = createMockFs();
const mockLogger = createMockLogger();

function makeDeps(): HandlerDeps {
  return {
    config: { filesPath: "/test/audiobooks", dataPath: "/test/data", port: 8080, reconcileInterval: 1800 },
    logger: {
      info: (tag, msg, ctx) => {
        mockLogger.infoCalls.push({ tag, msg, ctx });
      },
      warn: (tag, msg, ctx) => {
        mockLogger.warnCalls.push({ tag, msg, ctx });
      },
      error: (tag, msg, error) => {
        mockLogger.errorCalls.push({ tag, msg, error });
      },
      debug: (tag, msg, ctx) => {
        mockLogger.debugCalls.push({ tag, msg, ctx });
      },
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
      symlink: async (target, path) => {
        mockFs.symlinkCalls.push({ target, path });
      },
      unlink: async (path) => {
        mockFs.unlinkCalls.push(path);
      },
    },
  };
}

const folderDeletedEvent = (parent: string, name: string): EventType => ({
  _tag: "FolderDeleted",
  parent,
  name,
});

const folderCreatedEvent = (parent: string, name: string): EventType => ({
  _tag: "FolderCreated",
  parent,
  name,
});

const audioFileDeletedEvent = (parent: string, name: string): EventType => ({
  _tag: "AudioFileDeleted",
  parent,
  name,
});

describe("Handler integration", () => {
  beforeEach(() => {
    mockFs.reset();
    mockLogger.reset();
  });

  describe("folderCleanup", () => {
    test("removes data directory for deleted folder", async () => {
      // #when
      await folderCleanup(folderDeletedEvent("/test/audiobooks/Fiction/", "Author"), makeDeps());
      // #then
      expect(mockFs.rmCalls).toHaveLength(1);
      expect(mockFs.rmCalls[0]!.path).toBe("/test/data/Fiction/Author");
    });

    test("logs the folder being removed", async () => {
      // #when
      await folderCleanup(folderDeletedEvent("/test/audiobooks/Fiction/", "Author"), makeDeps());
      // #then
      expect(mockLogger.infoCalls.some((c) => c.tag === "FolderCleanup" && c.msg.includes("Removing"))).toBe(true);
    });

    test("handles nested folder paths correctly", async () => {
      // #when
      await folderCleanup(folderDeletedEvent("/test/audiobooks/Fiction/SciFi/", "Isaac Asimov"), makeDeps());
      // #then
      expect(mockFs.rmCalls[0]!.path).toBe("/test/data/Fiction/SciFi/Isaac Asimov");
    });
  });

  describe("folderSync", () => {
    test("creates data directory for new folder", async () => {
      // #when
      await folderSync(folderCreatedEvent("/test/audiobooks/", "Fiction"), makeDeps());
      // #then
      expect(mockFs.mkdirCalls.some((c) => c.path === "/test/data/Fiction")).toBe(true);
    });

    test("creates _entry.xml for non-root folders", async () => {
      // #when
      await folderSync(folderCreatedEvent("/test/audiobooks/", "Fiction"), makeDeps());
      // #then
      const entryWrite = mockFs.writeCalls.find((c) => c.path.endsWith("_entry.xml"));
      expect(entryWrite).toBeDefined();
      expect(entryWrite?.content).toContain("<folder>");
      expect(entryWrite?.content).toContain("<title>Fiction</title>");
    });

    test("does not create _entry.xml for root folder", async () => {
      // #when
      await folderSync(folderCreatedEvent("/test/audiobooks/", ""), makeDeps());
      // #then
      const entryWrite = mockFs.writeCalls.find((c) => c.path.endsWith("_entry.xml"));
      expect(entryWrite).toBeUndefined();
    });

    test("includes href in _entry.xml", async () => {
      // #when
      await folderSync(folderCreatedEvent("/test/audiobooks/", "Fiction"), makeDeps());
      // #then
      const entryWrite = mockFs.writeCalls.find((c) => c.path.endsWith("_entry.xml"));
      expect(entryWrite?.content).toContain("/Fiction/feed.xml");
    });

    test("returns cascade event to generate root feed.xml", async () => {
      // #when
      const result = await folderSync(folderCreatedEvent("/test/audiobooks/", ""), makeDeps());
      // #then
      const cascades = result._unsafeUnwrap();
      expect(cascades).toHaveLength(1);
      expect(cascades[0]).toEqual({ _tag: "FolderMetaSyncRequested", path: "/test/data" });
    });

    test("returns cascade event to generate folder feed.xml", async () => {
      // #when
      const result = await folderSync(folderCreatedEvent("/test/audiobooks/", "Fiction"), makeDeps());
      // #then
      const cascades = result._unsafeUnwrap();
      expect(cascades).toHaveLength(1);
      expect(cascades[0]).toEqual({ _tag: "FolderMetaSyncRequested", path: "/test/data/Fiction" });
    });
  });

  describe("audioCleanup", () => {
    test("removes data directory for deleted audio file", async () => {
      // #when
      await audioCleanup(audioFileDeletedEvent("/test/audiobooks/Fiction/", "chapter01.mp3"), makeDeps());
      // #then
      expect(mockFs.rmCalls).toHaveLength(1);
      expect(mockFs.rmCalls[0]!.path).toBe("/test/data/Fiction/chapter01.mp3");
    });

    test("logs the audio file being removed", async () => {
      // #when
      await audioCleanup(audioFileDeletedEvent("/test/audiobooks/Fiction/", "chapter01.mp3"), makeDeps());
      // #then
      expect(mockLogger.infoCalls.some((c) => c.tag === "AudioCleanup" && c.msg.includes("Removing"))).toBe(true);
    });

    test("returns cascade event to regenerate parent feed", async () => {
      // #when
      const result = await audioCleanup(audioFileDeletedEvent("/test/audiobooks/Fiction/", "chapter01.mp3"), makeDeps());
      // #then
      const cascades = result._unsafeUnwrap();
      expect(cascades).toHaveLength(1);
      expect(cascades[0]).toEqual({ _tag: "FolderMetaSyncRequested", path: "/test/data/Fiction" });
    });
  });

  describe("folderCleanup cascade", () => {
    test("returns cascade event to regenerate parent feed for nested folders", async () => {
      // #when
      const result = await folderCleanup(folderDeletedEvent("/test/audiobooks/Fiction/", "SciFi"), makeDeps());
      // #then
      const cascades = result._unsafeUnwrap();
      expect(cascades).toHaveLength(1);
      expect(cascades[0]).toEqual({ _tag: "FolderMetaSyncRequested", path: "/test/data/Fiction" });
    });

    test("returns empty cascades for top-level folder deletion", async () => {
      // #when
      const result = await folderCleanup(folderDeletedEvent("/test/audiobooks/", "Fiction"), makeDeps());
      // #then
      const cascades = result._unsafeUnwrap();
      expect(cascades).toHaveLength(0);
    });
  });
});
