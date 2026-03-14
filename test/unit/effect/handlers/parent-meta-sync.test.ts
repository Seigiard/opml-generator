import { describe, test, expect, beforeEach } from "bun:test";
import { Effect, Layer } from "effect";
import { ConfigService, LoggerService, FileSystemService } from "../../../../src/effect/services.ts";
import { parentMetaSync } from "../../../../src/effect/handlers/parent-meta-sync.ts";
import type { EventType } from "../../../../src/effect/types.ts";

const mockLogger = {
  infoCalls: [] as Array<{ tag: string; msg: string }>,
  reset() {
    this.infoCalls = [];
  },
};

const TestConfigService = Layer.succeed(ConfigService, {
  filesPath: "/files",
  dataPath: "/data",
  port: 3000,
  reconcileInterval: 1800,
});

const TestLoggerService = Layer.succeed(LoggerService, {
  info: (tag, msg) =>
    Effect.sync(() => {
      mockLogger.infoCalls.push({ tag, msg });
    }),
  warn: () => Effect.void,
  error: () => Effect.void,
  debug: () => Effect.void,
});

const TestFileSystemService = Layer.succeed(FileSystemService, {
  mkdir: () => Effect.void,
  rm: () => Effect.void,
  readdir: () => Effect.succeed([]),
  stat: () => Effect.succeed({ isDirectory: () => false, size: 0 }),
  exists: () => Effect.succeed(false),
  writeFile: () => Effect.void,
  atomicWrite: () => Effect.void,
  symlink: () => Effect.void,
  unlink: () => Effect.void,
});

const TestLayer = Layer.mergeAll(TestConfigService, TestLoggerService, TestFileSystemService);

const entryXmlChangedEvent = (parent: string): EventType => ({
  _tag: "EntryXmlChanged",
  parent,
});

describe("parentMetaSync handler", () => {
  beforeEach(() => {
    mockLogger.reset();
  });

  test("returns empty array for non-EntryXmlChanged events", async () => {
    const event: EventType = { _tag: "AudioFileCreated", parent: "/files", name: "chapter01.mp3" };
    const cascades = await Effect.runPromise(Effect.provide(parentMetaSync(event), TestLayer));

    expect(cascades).toEqual([]);
  });

  test("returns FolderMetaSyncRequested for parent directory", async () => {
    const cascades = await Effect.runPromise(Effect.provide(parentMetaSync(entryXmlChangedEvent("/data/Fiction/Author")), TestLayer));

    expect(cascades).toHaveLength(1);
    expect(cascades[0]).toEqual({
      _tag: "FolderMetaSyncRequested",
      path: "/data/Fiction",
    });
  });

  test("returns FolderMetaSyncRequested for root when parent is root", async () => {
    const cascades = await Effect.runPromise(Effect.provide(parentMetaSync(entryXmlChangedEvent("/data/Fiction")), TestLayer));

    expect(cascades).toHaveLength(1);
    expect(cascades[0]).toEqual({
      _tag: "FolderMetaSyncRequested",
      path: "/data",
    });
  });

  test("handles trailing slash in path", async () => {
    const cascades = await Effect.runPromise(Effect.provide(parentMetaSync(entryXmlChangedEvent("/data/Fiction/Author/")), TestLayer));

    expect(cascades).toHaveLength(1);
    expect(cascades[0]).toEqual({
      _tag: "FolderMetaSyncRequested",
      path: "/data/Fiction",
    });
  });

  test("logs the action", async () => {
    await Effect.runPromise(Effect.provide(parentMetaSync(entryXmlChangedEvent("/data/Fiction/Author")), TestLayer));

    expect(mockLogger.infoCalls.some((c) => c.tag === "ParentMetaSync")).toBe(true);
  });
});
