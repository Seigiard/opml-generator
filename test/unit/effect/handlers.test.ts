import { describe, test, expect, beforeEach } from "bun:test";
import { Effect, Layer } from "effect";
import { ConfigService, LoggerService, FileSystemService } from "../../../src/effect/services.ts";
import { folderCleanup } from "../../../src/effect/handlers/folder-cleanup.ts";
import { folderSync } from "../../../src/effect/handlers/folder-sync.ts";
import { audioCleanup } from "../../../src/effect/handlers/audio-cleanup.ts";
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

const TestConfigService = Layer.succeed(ConfigService, {
  filesPath: "/test/audiobooks",
  dataPath: "/test/data",
  port: 8080,
});

const TestLoggerService = Layer.succeed(LoggerService, {
  info: (tag, msg, ctx) =>
    Effect.sync(() => {
      mockLogger.infoCalls.push({ tag, msg, ctx });
    }),
  warn: (tag, msg, ctx) =>
    Effect.sync(() => {
      mockLogger.warnCalls.push({ tag, msg, ctx });
    }),
  error: (tag, msg, error) =>
    Effect.sync(() => {
      mockLogger.errorCalls.push({ tag, msg, error });
    }),
  debug: (tag, msg, ctx) =>
    Effect.sync(() => {
      mockLogger.debugCalls.push({ tag, msg, ctx });
    }),
});

const TestFileSystemService = Layer.succeed(FileSystemService, {
  mkdir: (path, options) =>
    Effect.sync(() => {
      mockFs.mkdirCalls.push({ path, options });
    }),
  rm: (path, options) =>
    Effect.sync(() => {
      mockFs.rmCalls.push({ path, options });
    }),
  readdir: (_path) => Effect.succeed([]),
  stat: (_path) => Effect.succeed({ isDirectory: () => false, size: 0 }),
  exists: (_path) => Effect.succeed(false),
  writeFile: (path, content) =>
    Effect.sync(() => {
      mockFs.writeCalls.push({ path, content });
    }),
  atomicWrite: (path, content) =>
    Effect.sync(() => {
      mockFs.writeCalls.push({ path, content });
    }),
  symlink: (target, path) =>
    Effect.sync(() => {
      mockFs.symlinkCalls.push({ target, path });
    }),
  unlink: (path) =>
    Effect.sync(() => {
      mockFs.unlinkCalls.push(path);
    }),
});

const TestLayer = Layer.mergeAll(TestConfigService, TestLoggerService, TestFileSystemService);

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

describe("Effect Handlers", () => {
  beforeEach(() => {
    mockFs.reset();
    mockLogger.reset();
  });

  describe("folderCleanup", () => {
    test("removes data directory for deleted folder", async () => {
      const effect = folderCleanup(folderDeletedEvent("/test/audiobooks/Fiction/", "Author"));

      await Effect.runPromise(Effect.provide(effect, TestLayer));

      expect(mockFs.rmCalls).toHaveLength(1);
      expect(mockFs.rmCalls[0]!.path).toBe("/test/data/Fiction/Author");
      expect(mockFs.rmCalls[0]!.options?.recursive).toBe(true);
    });

    test("logs the folder being removed", async () => {
      const effect = folderCleanup(folderDeletedEvent("/test/audiobooks/Fiction/", "Author"));

      await Effect.runPromise(Effect.provide(effect, TestLayer));

      expect(mockLogger.infoCalls.some((c) => c.tag === "FolderCleanup" && c.msg.includes("Removing"))).toBe(true);
    });

    test("handles nested folder paths correctly", async () => {
      const effect = folderCleanup(folderDeletedEvent("/test/audiobooks/Fiction/SciFi/", "Isaac Asimov"));

      await Effect.runPromise(Effect.provide(effect, TestLayer));

      expect(mockFs.rmCalls[0]!.path).toBe("/test/data/Fiction/SciFi/Isaac Asimov");
    });
  });

  describe("folderSync", () => {
    test("creates data directory for new folder", async () => {
      const effect = folderSync(folderCreatedEvent("/test/audiobooks/", "Fiction"));

      await Effect.runPromise(Effect.provide(effect, TestLayer));

      expect(mockFs.mkdirCalls.some((c) => c.path === "/test/data/Fiction")).toBe(true);
    });

    test("creates _entry.xml for non-root folders", async () => {
      const effect = folderSync(folderCreatedEvent("/test/audiobooks/", "Fiction"));

      await Effect.runPromise(Effect.provide(effect, TestLayer));

      const entryWrite = mockFs.writeCalls.find((c) => c.path.endsWith("_entry.xml"));
      expect(entryWrite).toBeDefined();
      expect(entryWrite?.content).toContain("<entry");
    });

    test("does not create _entry.xml for root folder", async () => {
      const effect = folderSync(folderCreatedEvent("/test/audiobooks/", ""));

      await Effect.runPromise(Effect.provide(effect, TestLayer));

      const entryWrite = mockFs.writeCalls.find((c) => c.path.endsWith("_entry.xml"));
      expect(entryWrite).toBeUndefined();
    });

    test("includes subsection link in _entry.xml", async () => {
      const effect = folderSync(folderCreatedEvent("/test/audiobooks/", "Fiction"));

      await Effect.runPromise(Effect.provide(effect, TestLayer));

      const entryWrite = mockFs.writeCalls.find((c) => c.path.endsWith("_entry.xml"));
      expect(entryWrite?.content).toContain("Fiction/feed.xml");
    });

    test("returns cascade event to generate root feed.xml", async () => {
      const effect = folderSync(folderCreatedEvent("/test/audiobooks/", ""));

      const cascades = await Effect.runPromise(Effect.provide(effect, TestLayer));

      expect(cascades).toHaveLength(1);
      expect(cascades[0]).toEqual({
        _tag: "FolderMetaSyncRequested",
        path: "/test/data",
      });
    });

    test("returns cascade event to generate folder feed.xml", async () => {
      const effect = folderSync(folderCreatedEvent("/test/audiobooks/", "Fiction"));

      const cascades = await Effect.runPromise(Effect.provide(effect, TestLayer));

      expect(cascades).toHaveLength(1);
      expect(cascades[0]).toEqual({
        _tag: "FolderMetaSyncRequested",
        path: "/test/data/Fiction",
      });
    });
  });

  describe("audioCleanup", () => {
    test("removes data directory for deleted audio file", async () => {
      const effect = audioCleanup(audioFileDeletedEvent("/test/audiobooks/Fiction/", "chapter01.mp3"));

      await Effect.runPromise(Effect.provide(effect, TestLayer));

      expect(mockFs.rmCalls).toHaveLength(1);
      expect(mockFs.rmCalls[0]!.path).toBe("/test/data/Fiction/chapter01.mp3");
      expect(mockFs.rmCalls[0]!.options?.recursive).toBe(true);
    });

    test("logs the audio file being removed", async () => {
      const effect = audioCleanup(audioFileDeletedEvent("/test/audiobooks/Fiction/", "chapter01.mp3"));

      await Effect.runPromise(Effect.provide(effect, TestLayer));

      expect(mockLogger.infoCalls.some((c) => c.tag === "AudioCleanup" && c.msg.includes("Removing"))).toBe(true);
    });

    test("returns cascade event to regenerate parent feed", async () => {
      const effect = audioCleanup(audioFileDeletedEvent("/test/audiobooks/Fiction/", "chapter01.mp3"));

      const cascades = await Effect.runPromise(Effect.provide(effect, TestLayer));

      expect(cascades).toHaveLength(1);
      expect(cascades[0]).toEqual({
        _tag: "FolderMetaSyncRequested",
        path: "/test/data/Fiction",
      });
    });
  });

  describe("folderCleanup cascade", () => {
    test("returns cascade event to regenerate parent feed for nested folders", async () => {
      const effect = folderCleanup(folderDeletedEvent("/test/audiobooks/Fiction/", "SciFi"));

      const cascades = await Effect.runPromise(Effect.provide(effect, TestLayer));

      expect(cascades).toHaveLength(1);
      expect(cascades[0]).toEqual({
        _tag: "FolderMetaSyncRequested",
        path: "/test/data/Fiction",
      });
    });

    test("returns empty cascades for top-level folder deletion", async () => {
      const effect = folderCleanup(folderDeletedEvent("/test/audiobooks/", "Fiction"));

      const cascades = await Effect.runPromise(Effect.provide(effect, TestLayer));

      expect(cascades).toHaveLength(0);
    });
  });
});
